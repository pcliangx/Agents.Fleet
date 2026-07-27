// RT-ORDER-08 / RT-TERM-07/11/12 — durable, parser-safe Session Snapshot cache.
//
// The coordinator rebuilds only from ByteJournal frames already covered by the
// Durable Stream Cursor. It advances the Snapshot cursor solely after the
// pinned headless terminal proves parserGround && utf8DecoderEmpty, then wraps
// addon-serialize output in an app-owned, versioned, non-HTML document.

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { FROZEN_RUNTIME_LIMIT_PROFILE, type Seq, type Snapshot } from "@agents-fleet/contracts";
import { TERMINAL_PACKAGE_SET } from "@agents-fleet/terminal/manifest";
import { transact } from "../storage/database.js";
import { type ByteJournal, DataIntegrityFailure } from "./byte-journal.js";
import { durableWriteContentObject, verifyContentObject } from "./content-object-io.js";

const SNAPSHOT_SCHEMA_VERSION = 1;

interface SnapshotDocument {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly generation: number;
  readonly coversThroughSeq: number;
  readonly terminalPackageSet: typeof TERMINAL_PACKAGE_SET;
  readonly producer:
    | {
        readonly kind: "SnapshotWorker";
        readonly threadId: number;
        readonly receivedPtyHandle: false;
      }
    | {
        readonly kind: "InitialState";
        readonly receivedPtyHandle: false;
      };
  readonly terminal: {
    readonly cols: number;
    readonly rows: number;
    readonly serialized: string;
    readonly cursor: { readonly row: number; readonly col: number };
    readonly title: string;
  };
  readonly checkpoint: {
    readonly parserGround: true;
    readonly utf8DecoderEmpty: true;
  };
  readonly truncated: false;
}

interface SnapshotRow {
  readonly covers_through_seq: number;
  readonly content_ref: string;
  readonly sha256: string;
  readonly schema_version: number;
  readonly package_set_json: string;
}

const packageSetJson = JSON.stringify(TERMINAL_PACKAGE_SET);

interface SnapshotWorkerResult {
  readonly type: "result";
  readonly coversThroughSeq: number;
  readonly serialized: string;
  readonly cursor: { readonly row: number; readonly col: number };
  readonly title: string;
  readonly producer: SnapshotDocument["producer"];
}

type SnapshotWorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "frame-applied"; readonly seq: number }
  | SnapshotWorkerResult
  | { readonly type: "error"; readonly message: string };

const nextWorkerMessage = async (worker: Worker): Promise<SnapshotWorkerMessage> =>
  await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: SnapshotWorkerMessage): void => {
      cleanup();
      if (message.type === "error") {
        reject(new Error(message.message));
        return;
      }
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`Snapshot Worker exited before replying (code ${code})`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });

export class SnapshotCoordinator {
  readonly #db: DatabaseSync;
  readonly #storeDir: string;
  readonly #journal: ByteJournal;
  readonly #now: () => number;

  constructor(options: {
    readonly db: DatabaseSync;
    readonly storeDir: string;
    readonly journal: ByteJournal;
    readonly now?: () => number;
  }) {
    this.#db = options.db;
    this.#storeDir = options.storeDir;
    this.#journal = options.journal;
    this.#now = options.now ?? Date.now;
  }

  async create(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly cols: number;
    readonly rows: number;
  }): Promise<Snapshot> {
    const worker = new Worker(new URL("./snapshot-worker.mjs", import.meta.url), {
      workerData: {
        cols: input.cols,
        rows: input.rows,
        scrollbackLines: FROZEN_RUNTIME_LIMIT_PROFILE.terminal.scrollbackLines,
        maxPendingWriteBytes: FROZEN_RUNTIME_LIMIT_PROFILE.terminal.pendingWriteBytes,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: Math.floor(
          FROZEN_RUNTIME_LIMIT_PROFILE.snapshotWorkerMemoryBytes / (1024 * 1024),
        ),
      },
    });
    let result: SnapshotWorkerResult;
    try {
      const ready = await nextWorkerMessage(worker);
      if (ready.type !== "ready") throw new Error("Snapshot Worker did not become ready");
      const durableCursor = this.#journal.durableCursor(input);
      for (let seq = 1; seq <= durableCursor; seq += 1) {
        const bytes = this.#journal.readFrame({ ...input, seq });
        if (bytes === null) {
          throw new DataIntegrityFailure(`durable Snapshot replay is missing seq ${seq}`);
        }
        worker.postMessage({ type: "frame", seq, bytes: new Uint8Array(bytes) });
        const applied = await nextWorkerMessage(worker);
        if (applied.type !== "frame-applied" || applied.seq !== seq) {
          throw new Error("Snapshot Worker acknowledged the wrong frame");
        }
      }
      worker.postMessage({ type: "finish" });
      const completed = await nextWorkerMessage(worker);
      if (completed.type !== "result") {
        throw new Error("Snapshot Worker did not return a result");
      }
      result = completed;
    } finally {
      await worker.terminate();
    }

    const document: SnapshotDocument = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      generation: input.generation,
      coversThroughSeq: result.coversThroughSeq,
      terminalPackageSet: TERMINAL_PACKAGE_SET,
      producer: result.producer,
      terminal: {
        cols: input.cols,
        rows: input.rows,
        serialized: result.serialized,
        cursor: result.cursor,
        title: result.title,
      },
      checkpoint: { parserGround: true, utf8DecoderEmpty: true },
      truncated: false,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    if (bytes.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.snapshotBytes) {
      throw new Error(
        `Snapshot exceeds ${FROZEN_RUNTIME_LIMIT_PROFILE.snapshotBytes} byte runtime limit`,
      );
    }
    const written = durableWriteContentObject({
      storeDir: this.#storeDir,
      relativeDir: join("snapshots", input.sessionId, String(input.generation)),
      finalName: `snapshot-${result.coversThroughSeq}.json`,
      bytes,
    });
    transact(
      this.#db,
      () => {
        this.#db
          .prepare(
            `INSERT INTO session_snapshots
               (session_id, generation, covers_through_seq, content_ref, sha256,
                byte_length, schema_version, package_set_json, truncated,
                truncated_before_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
             ON CONFLICT (session_id, generation) DO UPDATE SET
               covers_through_seq = excluded.covers_through_seq,
               content_ref = excluded.content_ref,
               sha256 = excluded.sha256,
               byte_length = excluded.byte_length,
               schema_version = excluded.schema_version,
               package_set_json = excluded.package_set_json,
               truncated = excluded.truncated,
               truncated_before_seq = excluded.truncated_before_seq,
               created_at = excluded.created_at`,
          )
          .run(
            input.sessionId,
            input.generation,
            result.coversThroughSeq,
            written.relativePath,
            written.sha256,
            written.byteLength,
            SNAPSHOT_SCHEMA_VERSION,
            packageSetJson,
            new Date(this.#now()).toISOString(),
          );
      },
      this.#now,
    );
    return { coversThroughSeq: result.coversThroughSeq as Seq, bytes };
  }

  initial(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly cols: number;
    readonly rows: number;
  }): Snapshot {
    const document: SnapshotDocument = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      generation: input.generation,
      coversThroughSeq: 0,
      terminalPackageSet: TERMINAL_PACKAGE_SET,
      producer: { kind: "InitialState", receivedPtyHandle: false },
      terminal: {
        cols: input.cols,
        rows: input.rows,
        serialized: "",
        cursor: { row: 0, col: 0 },
        title: "",
      },
      checkpoint: { parserGround: true, utf8DecoderEmpty: true },
      truncated: false,
    };
    return {
      coversThroughSeq: 0 as Seq,
      bytes: new TextEncoder().encode(JSON.stringify(document)),
    };
  }

  read(sessionId: string, generation: number): Snapshot | null {
    const row = this.#db
      .prepare(
        `SELECT covers_through_seq, content_ref, sha256, schema_version, package_set_json
         FROM session_snapshots
         WHERE session_id = ? AND generation = ?`,
      )
      .get(sessionId, generation) as SnapshotRow | undefined;
    if (
      row === undefined ||
      row.schema_version !== SNAPSHOT_SCHEMA_VERSION ||
      row.package_set_json !== packageSetJson
    ) {
      return null;
    }
    const verified = verifyContentObject(join(this.#storeDir, row.content_ref), row.sha256);
    if (!verified.ok) return null;
    try {
      const document = JSON.parse(new TextDecoder().decode(verified.bytes)) as SnapshotDocument;
      if (
        document.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
        document.sessionId !== sessionId ||
        document.generation !== generation ||
        document.coversThroughSeq !== row.covers_through_seq ||
        document.checkpoint.parserGround !== true ||
        document.checkpoint.utf8DecoderEmpty !== true ||
        document.producer.receivedPtyHandle !== false ||
        (document.producer.kind === "SnapshotWorker" &&
          (!Number.isSafeInteger(document.producer.threadId) || document.producer.threadId <= 0)) ||
        (document.producer.kind !== "SnapshotWorker" &&
          document.producer.kind !== "InitialState") ||
        JSON.stringify(document.terminalPackageSet) !== packageSetJson
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return {
      coversThroughSeq: row.covers_through_seq as Seq,
      bytes: new Uint8Array(verified.bytes),
    };
  }
}
