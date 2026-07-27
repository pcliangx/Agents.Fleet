// RT-MOD-03 / RT-LAUNCH-02..08 — Session Runtime public seam.
//
// ProcessSupervisor and the file handshake remain private implementation
// details. Callers pass a scheduler-produced PreparedLaunch and receive only
// domain results. The durable LaunchIntent result makes a replay return the
// original Session without spawning a second bootstrap or Agent.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  Attempt,
  type DurableFrameRef,
  LaunchIntent,
  type LaunchSessionResult,
  type LaunchValidation,
  type PreparedLaunch,
  type RestartReconciliationReport,
  type SessionRuntime as SessionRuntimeContract,
  type SessionRuntimeRecord,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { transact } from "../storage/database.js";
import { EVENT_SCHEMA_VERSION, StoreError } from "../storage/task-store.js";
import { ByteJournal } from "./byte-journal.js";
import { durableWriteContentObject } from "./content-object-io.js";
import type {
  ProcessSupervisor,
  PtyExitEvent,
  SupervisedPtyProcess,
} from "./process-supervisor.js";
import { reconcileStore } from "./store-reconciliation.js";

const DEFAULT_BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), "bootstrap.mjs");

type LaunchStep = "afterBootstrapReceipt" | "afterAuthorize" | "afterCommitSent";

interface SessionRuntimeOptions {
  readonly db: DatabaseSync;
  readonly storeDir: string;
  readonly processSupervisor: ProcessSupervisor;
  readonly bootstrapPath?: string;
  readonly bootstrapTimeoutMs?: number;
  readonly receiptTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly now?: () => number;
  /** RT-T-11 crash injection at protocol boundaries. */
  readonly onLaunchStep?: (step: LaunchStep) => void;
}

interface LaunchIntentRow {
  readonly launch_nonce: string;
  readonly attempt_id: string;
  readonly command_id: string;
  readonly slot_lease_id: string;
  readonly planned_session_id: string;
  readonly agent_id: string;
  readonly argv_hash: string;
  readonly launch_spec_json: string;
  readonly launch_spec_hash: string;
  readonly status: LaunchIntent.LaunchIntentStatus;
  readonly commit_sent_at: string | null;
  readonly result_json: string | null;
}

interface ProcessReceipt {
  readonly nonce: string;
  readonly argvHash: string;
  readonly pid: number;
  readonly pgid: number;
  readonly lstart: string;
  readonly command?: string;
}

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const readReceipt = (path: string): ProcessReceipt | null => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProcessReceipt>;
    if (
      typeof value.nonce !== "string" ||
      typeof value.argvHash !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.pgid !== "number" ||
      typeof value.lstart !== "string"
    ) {
      return null;
    }
    return value as ProcessReceipt;
  } catch {
    return null;
  }
};

export class SessionRuntime implements SessionRuntimeContract {
  readonly #db: DatabaseSync;
  readonly #storeDir: string;
  readonly #processSupervisor: ProcessSupervisor;
  readonly #bootstrapPath: string;
  readonly #bootstrapTimeoutMs: number;
  readonly #receiptTimeoutMs: number;
  readonly #agentTimeoutMs: number;
  readonly #now: () => number;
  readonly #onLaunchStep: ((step: LaunchStep) => void) | undefined;
  readonly #journal: ByteJournal;
  readonly #launches = new Map<string, Promise<LaunchSessionResult>>();
  readonly #processes = new Map<string, SupervisedPtyProcess>();
  readonly #outputSubscriptions = new Map<string, () => void>();
  readonly #exitSubscriptions = new Map<string, () => void>();
  readonly #exitPromises = new Map<string, Promise<void>>();
  readonly #streamFailures = new Map<string, unknown>();

  constructor(options: SessionRuntimeOptions) {
    this.#db = options.db;
    this.#storeDir = options.storeDir;
    this.#processSupervisor = options.processSupervisor;
    this.#bootstrapPath = options.bootstrapPath ?? DEFAULT_BOOTSTRAP;
    this.#bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 10_000;
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 3_000;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 3_000;
    this.#now = options.now ?? Date.now;
    this.#onLaunchStep = options.onLaunchStep;
    this.#journal = new ByteJournal({ storeDir: options.storeDir, db: options.db });
  }

  async launch(
    prepared: PreparedLaunch,
    validation: LaunchValidation,
  ): Promise<LaunchSessionResult> {
    const persisted = this.#intent(prepared.launchNonce);
    this.#assertPreparedMatches(prepared, persisted);
    if (persisted.result_json !== null) {
      return JSON.parse(persisted.result_json) as LaunchSessionResult;
    }

    const inFlight = this.#launches.get(prepared.launchNonce);
    if (inFlight !== undefined) return await inFlight;
    const launch = this.#launchOnce(prepared, validation);
    this.#launches.set(prepared.launchNonce, launch);
    try {
      return await launch;
    } finally {
      this.#launches.delete(prepared.launchNonce);
    }
  }

  async terminate(sessionId: string): Promise<void> {
    const process = this.#processes.get(sessionId);
    if (process === undefined) return;
    this.#outputSubscriptions.get(sessionId)?.();
    this.#outputSubscriptions.delete(sessionId);
    const exited = this.#exitPromises.get(sessionId);
    await process.terminate().catch(() => {});
    if (exited !== undefined) {
      await Promise.race([exited, sleep(1_000)]);
    }
    this.#processes.delete(sessionId);
  }

  inspectSession(sessionId: string): SessionRuntimeRecord | null {
    const row = this.#db
      .prepare(
        "SELECT session_id, attempt_id, generation, availability FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          readonly session_id: string;
          readonly attempt_id: string;
          readonly generation: number;
          readonly availability: SessionRuntimeRecord["availability"];
        }
      | undefined;
    return row === undefined
      ? null
      : {
          sessionId: row.session_id,
          attemptId: row.attempt_id,
          generation: row.generation,
          availability: row.availability,
        };
  }

  reconcileAfterRestart(): RestartReconciliationReport {
    const storage = reconcileStore(this.#storeDir, this.#db);
    const alive = this.#db
      .prepare(
        `SELECT sessions.session_id, sessions.attempt_id, attempts.task_id, attempts.status
         FROM sessions
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE sessions.availability = 'Alive'
         ORDER BY sessions.created_at, sessions.session_id`,
      )
      .all() as unknown as {
      readonly session_id: string;
      readonly attempt_id: string;
      readonly task_id: string;
      readonly status: Attempt.AttemptStatus;
    }[];
    const actions: RestartReconciliationReport["actions"][number][] = [];

    for (const row of alive) {
      transact(
        this.#db,
        () => {
          const now = new Date(this.#now()).toISOString();
          this.#db
            .prepare(
              "UPDATE sessions SET availability = 'Lost', updated_at = ? WHERE session_id = ? AND availability = 'Alive'",
            )
            .run(now, row.session_id);
          if (Attempt.canTransition(row.status, "Interrupted")) {
            this.#db
              .prepare("UPDATE attempts SET status = 'Interrupted' WHERE attempt_id = ?")
              .run(row.attempt_id);
          }
          this.#db
            .prepare(
              `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
               VALUES (?, 'Probing', ?)
               ON CONFLICT (attempt_id) DO UPDATE
               SET disposition = 'Probing', updated_at = excluded.updated_at`,
            )
            .run(row.attempt_id, now);
          this.#appendLifecycleEvent({
            taskId: row.task_id,
            attemptId: row.attempt_id,
            sessionId: row.session_id,
            type: "session-lost",
            payload: { reason: "daemon-runtime-restarted" },
          });
        },
        this.#now,
      );
      actions.push({
        action: "marked-lost",
        attemptId: row.attempt_id,
        sessionId: row.session_id,
      });
    }

    const prepared = this.#db
      .prepare(
        `SELECT launch_intents.*, attempts.task_id
         FROM launch_intents
         JOIN attempts ON attempts.attempt_id = launch_intents.attempt_id
         WHERE attempts.status = 'Starting'
           AND launch_intents.status = 'Prepared'
           AND launch_intents.result_json IS NULL
         ORDER BY launch_intents.created_at, launch_intents.launch_nonce`,
      )
      .all() as unknown as (LaunchIntentRow & { readonly task_id: string })[];
    for (const row of prepared) {
      const launch = preparedLaunchFromRow(row);
      const receiptPath = join(
        this.#storeDir,
        "launch",
        row.launch_nonce,
        "bootstrap-receipt.json",
      );
      if (!existsSync(receiptPath)) {
        actions.push({
          action: "resume-prepared",
          attemptId: row.attempt_id,
          launchNonce: row.launch_nonce,
          preparedLaunch: launch,
        });
        continue;
      }
      this.#abort(launch, "bootstrap-lost-before-authorize");
      this.#writeSignal(join("launch", row.launch_nonce), "abort-launch.json", {
        launchNonce: row.launch_nonce,
      });
      actions.push({
        action: "aborted-bootstrap-lost",
        attemptId: row.attempt_id,
        launchNonce: row.launch_nonce,
      });
    }

    const authorized = this.#db
      .prepare(
        `SELECT launch_intents.*, attempts.task_id
         FROM launch_intents
         JOIN attempts ON attempts.attempt_id = launch_intents.attempt_id
         WHERE attempts.status = 'Starting'
           AND launch_intents.status = 'Authorized'
           AND launch_intents.result_json IS NULL
         ORDER BY launch_intents.created_at, launch_intents.launch_nonce`,
      )
      .all() as unknown as (LaunchIntentRow & { readonly task_id: string })[];
    for (const row of authorized) {
      const commitPath = join(this.#storeDir, "launch", row.launch_nonce, "commit-launch.json");
      const launch = preparedLaunchFromRow(row);
      if (row.commit_sent_at !== null || existsSync(commitPath)) {
        this.#markUncertain(launch, "commit-delivery-unknown-after-restart");
        actions.push({
          action: "marked-uncertain",
          attemptId: row.attempt_id,
          launchNonce: row.launch_nonce,
        });
        continue;
      }
      this.#abort(launch, "commit-never-sent-after-restart");
      this.#writeSignal(join("launch", row.launch_nonce), "abort-launch.json", {
        launchNonce: row.launch_nonce,
      });
      actions.push({
        action: "aborted-before-commit",
        attemptId: row.attempt_id,
        launchNonce: row.launch_nonce,
      });
    }
    return {
      actions,
      dataIntegrity: {
        adoptedOrphanCount: storage.adoptedOrphans.length,
        isolatedOrphanCount: storage.isolatedOrphans.length,
        dataGapCount: storage.dataGaps.length,
        verifiedChunks: storage.verifiedChunks,
      },
    };
  }

  readDurableFrame(frame: DurableFrameRef): Uint8Array | null {
    const failure = this.#streamFailures.get(`${frame.sessionId}:${frame.generation}`);
    if (failure !== undefined) throw failure;
    return this.#journal.readFrame(frame);
  }

  async #launchOnce(
    prepared: PreparedLaunch,
    validation: LaunchValidation,
  ): Promise<LaunchSessionResult> {
    const launchDir = join("launch", prepared.launchNonce);
    const config = {
      launchNonce: prepared.launchNonce,
      argvHash: this.#intent(prepared.launchNonce).argv_hash,
      timeoutMs: this.#bootstrapTimeoutMs,
      launchSpec: prepared.launchSpec,
    };
    const written = durableWriteContentObject({
      storeDir: this.#storeDir,
      relativeDir: launchDir,
      finalName: "bootstrap-config.json",
      bytes: Buffer.from(JSON.stringify(config)),
    });
    const configPath = join(this.#storeDir, written.relativePath);
    const bootstrapProcess = this.#processSupervisor.spawn({
      executablePath: processExecPath(),
      args: [this.#bootstrapPath, "--config", configPath],
      cwd: this.#storeDir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      cols: 80,
      rows: 24,
    });
    this.#processes.set(prepared.plannedSessionId, bootstrapProcess);
    this.#captureOutput(prepared, bootstrapProcess);
    this.#captureExit(prepared, bootstrapProcess);

    const receipt = await this.#waitForReceipt(
      join(this.#storeDir, launchDir, "bootstrap-receipt.json"),
      this.#receiptTimeoutMs,
    );
    if (
      receipt === null ||
      receipt.nonce !== prepared.launchNonce ||
      receipt.argvHash !== config.argvHash ||
      receipt.pid !== bootstrapProcess.pid
    ) {
      await bootstrapProcess.terminate();
      this.#forgetProcess(prepared.plannedSessionId);
      return this.#abort(prepared, "bootstrap-receipt-lost");
    }

    this.#onLaunchStep?.("afterBootstrapReceipt");
    this.#authorize(prepared, receipt);
    this.#onLaunchStep?.("afterAuthorize");
    let validationFailure: "launch-facts-drifted" | "launch-facts-unverifiable" | null = null;
    try {
      if (!(await validation.revalidate())) validationFailure = "launch-facts-drifted";
    } catch {
      validationFailure = "launch-facts-unverifiable";
    }
    if (validationFailure !== null) {
      const result = this.#abort(prepared, validationFailure);
      this.#writeSignal(launchDir, "abort-launch.json", {
        launchNonce: prepared.launchNonce,
      });
      await bootstrapProcess.terminate();
      this.#forgetProcess(prepared.plannedSessionId);
      return result;
    }

    this.#writeSignal(launchDir, "commit-launch.json", {
      launchNonce: prepared.launchNonce,
      argvHash: config.argvHash,
    });
    this.#recordCommitSent(prepared.launchNonce);
    this.#onLaunchStep?.("afterCommitSent");

    const agent = await this.#waitForAgent(
      join(this.#storeDir, launchDir, "exec-receipt.json"),
      this.#agentTimeoutMs,
      prepared,
    );
    if (
      agent === null ||
      agent.nonce !== prepared.launchNonce ||
      agent.argvHash !== config.argvHash
    ) {
      return this.#markUncertain(prepared, "agent-not-observed-after-commit");
    }

    const result = this.#finalizeRunning(prepared, agent);
    return result;
  }

  #captureOutput(prepared: PreparedLaunch, process: SupervisedPtyProcess): void {
    let nextSeq =
      this.#journal.durableCursor({
        sessionId: prepared.plannedSessionId,
        generation: 1,
      }) + 1;
    const streamKey = `${prepared.plannedSessionId}:1`;
    const unsubscribe = process.onOutput((bytes) => {
      if (this.#streamFailures.has(streamKey)) return;
      try {
        this.#journal.appendFrame({
          sessionId: prepared.plannedSessionId,
          generation: 1,
          seq: nextSeq,
          bytes: Uint8Array.from(bytes),
        });
        nextSeq += 1;
      } catch (error) {
        this.#streamFailures.set(streamKey, error);
        void process.terminate().catch(() => {});
      }
    });
    this.#outputSubscriptions.set(prepared.plannedSessionId, unsubscribe);
  }

  #captureExit(prepared: PreparedLaunch, process: SupervisedPtyProcess): void {
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.#exitPromises.set(prepared.plannedSessionId, exited);
    const unsubscribe = process.onExit((event) => {
      this.#recordExit(prepared, event);
      resolveExit?.();
    });
    this.#exitSubscriptions.set(prepared.plannedSessionId, unsubscribe);
  }

  #recordExit(prepared: PreparedLaunch, event: PtyExitEvent): void {
    transact(
      this.#db,
      () => {
        const session = this.inspectSession(prepared.plannedSessionId);
        if (session?.availability !== "Alive") return;
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE sessions
             SET availability = 'Exited', exit_code = ?, updated_at = ?
             WHERE session_id = ? AND availability = 'Alive'`,
          )
          .run(event.exitCode, now, prepared.plannedSessionId);
        this.#appendEvent(prepared, "session-exited", {
          sessionId: prepared.plannedSessionId,
          exitCode: event.exitCode,
          signal: event.signal,
        });
      },
      this.#now,
    );
    this.#forgetProcess(prepared.plannedSessionId);
  }

  #forgetProcess(sessionId: string): void {
    this.#outputSubscriptions.get(sessionId)?.();
    this.#outputSubscriptions.delete(sessionId);
    this.#exitSubscriptions.get(sessionId)?.();
    this.#exitSubscriptions.delete(sessionId);
    this.#exitPromises.delete(sessionId);
    this.#processes.delete(sessionId);
  }

  #intent(launchNonce: string): LaunchIntentRow {
    const row = this.#db
      .prepare("SELECT * FROM launch_intents WHERE launch_nonce = ?")
      .get(launchNonce) as LaunchIntentRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", "no such LaunchIntent");
    return row;
  }

  #assertPreparedMatches(prepared: PreparedLaunch, row: LaunchIntentRow): void {
    if (
      row.attempt_id !== prepared.attemptId ||
      row.command_id !== prepared.commandId ||
      row.slot_lease_id !== prepared.slotLeaseId ||
      row.planned_session_id !== prepared.plannedSessionId ||
      row.agent_id !== prepared.agentId ||
      row.launch_spec_json !== JSON.stringify(prepared.launchSpec) ||
      row.launch_spec_hash !== canonicalSha256(prepared.launchSpec)
    ) {
      throw new StoreError("IdempotencyConflict", "prepared launch does not match LaunchIntent");
    }
  }

  async #waitForReceipt(path: string, timeoutMs: number): Promise<ProcessReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = readReceipt(path);
      if (receipt !== null) return receipt;
      await sleep(20);
    }
    return null;
  }

  async #waitForAgent(
    receiptPath: string,
    timeoutMs: number,
    prepared: PreparedLaunch,
  ): Promise<ProcessReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = readReceipt(receiptPath);
      if (
        receipt !== null &&
        receipt.nonce === prepared.launchNonce &&
        receipt.pid === this.#processes.get(prepared.plannedSessionId)?.pid
      ) {
        const observed = processIdentity(receipt.pid);
        if (
          observed !== null &&
          observed.pgid === receipt.pgid &&
          observed.lstart === receipt.lstart &&
          observed.command.includes(prepared.launchSpec.executablePath)
        ) {
          return { ...receipt, command: observed.command };
        }
      }
      await sleep(20);
    }
    return null;
  }

  #authorize(prepared: PreparedLaunch, receipt: ProcessReceipt): void {
    transact(
      this.#db,
      () => {
        const row = this.#intent(prepared.launchNonce);
        if (!LaunchIntent.canTransition(row.status, "Authorized")) {
          throw new StoreError("Conflict", `LaunchIntent is ${row.status}, cannot authorize`);
        }
        this.#db
          .prepare(
            `UPDATE launch_intents
             SET status = 'Authorized', bootstrap_pid = ?, bootstrap_pgid = ?,
                 bootstrap_started_at = ?, updated_at = ?
             WHERE launch_nonce = ?`,
          )
          .run(
            receipt.pid,
            receipt.pgid,
            receipt.lstart,
            new Date(this.#now()).toISOString(),
            prepared.launchNonce,
          );
        this.#appendEvent(prepared, "launch-intent-authorized", {
          launchNonce: prepared.launchNonce,
        });
      },
      this.#now,
    );
  }

  #recordCommitSent(launchNonce: string): void {
    transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            "UPDATE launch_intents SET commit_sent_at = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(now, now, launchNonce);
      },
      this.#now,
    );
  }

  #finalizeRunning(prepared: PreparedLaunch, agent: ProcessReceipt): LaunchSessionResult {
    const result: LaunchSessionResult = {
      kind: "running",
      attemptId: prepared.attemptId,
      sessionId: prepared.plannedSessionId,
      generation: 1,
    };
    return transact(
      this.#db,
      () => {
        const attempt = this.#attemptStatus(prepared.attemptId);
        if (!Attempt.canTransition(attempt, "Running")) {
          throw new StoreError("Conflict", `Attempt is ${attempt}, cannot become Running`);
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `INSERT INTO sessions
             (session_id, attempt_id, availability, role, completion_policy, generation,
              process_pid, process_pgid, process_started_at, created_at, updated_at)
             VALUES (?, ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1,
                     ?, ?, ?, ?, ?)`,
          )
          .run(
            prepared.plannedSessionId,
            prepared.attemptId,
            agent.pid,
            agent.pgid,
            agent.lstart,
            now,
            now,
          );
        this.#db
          .prepare("UPDATE attempts SET status = 'Running' WHERE attempt_id = ?")
          .run(prepared.attemptId);
        this.#db
          .prepare(
            "UPDATE launch_intents SET result_json = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(JSON.stringify(result), now, prepared.launchNonce);
        this.#appendEvent(prepared, "session-alive", {
          sessionId: prepared.plannedSessionId,
          generation: 1,
        });
        this.#appendEvent(prepared, "attempt-running", {});
        return result;
      },
      this.#now,
    );
  }

  #abort(prepared: PreparedLaunch, reason: string): LaunchSessionResult {
    const result: LaunchSessionResult = {
      kind: "failed",
      attemptId: prepared.attemptId,
      reason,
    };
    return transact(
      this.#db,
      () => {
        const intent = this.#intent(prepared.launchNonce);
        if (!LaunchIntent.canTransition(intent.status, "Aborted")) {
          throw new StoreError("Conflict", `LaunchIntent is ${intent.status}, cannot abort`);
        }
        if (intent.commit_sent_at !== null) {
          throw new StoreError("Conflict", "CommitLaunch may have been delivered");
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE launch_intents
             SET status = 'Aborted', abort_reason = ?, result_json = ?, updated_at = ?
             WHERE launch_nonce = ?`,
          )
          .run(reason, JSON.stringify(result), now, prepared.launchNonce);
        this.#db
          .prepare("UPDATE attempts SET status = 'Failed' WHERE attempt_id = ?")
          .run(prepared.attemptId);
        this.#db
          .prepare("UPDATE slot_leases SET released_at = ? WHERE slot_lease_id = ?")
          .run(now, prepared.slotLeaseId);
        this.#appendEvent(prepared, "launch-aborted", { reason });
        return result;
      },
      this.#now,
    );
  }

  #markUncertain(prepared: PreparedLaunch, reason: string): LaunchSessionResult {
    const result: LaunchSessionResult = {
      kind: "uncertain",
      attemptId: prepared.attemptId,
      reason,
    };
    return transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare("UPDATE attempts SET status = 'Uncertain' WHERE attempt_id = ?")
          .run(prepared.attemptId);
        this.#db
          .prepare(
            "UPDATE launch_intents SET result_json = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(JSON.stringify(result), now, prepared.launchNonce);
        this.#db
          .prepare(
            `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
             VALUES (?, 'Probing', ?)
             ON CONFLICT (attempt_id) DO UPDATE
             SET disposition = 'Probing', updated_at = excluded.updated_at`,
          )
          .run(prepared.attemptId, now);
        this.#appendEvent(prepared, "attempt-uncertain", { reason });
        return result;
      },
      this.#now,
    );
  }

  #writeSignal(relativeDir: string, name: string, value: unknown): void {
    const finalPath = join(this.#storeDir, relativeDir, name);
    if (existsSync(finalPath)) return;
    durableWriteContentObject({
      storeDir: this.#storeDir,
      relativeDir,
      finalName: name,
      bytes: Buffer.from(JSON.stringify(value)),
    });
  }

  #attemptStatus(attemptId: string): Attempt.AttemptStatus {
    const row = this.#db
      .prepare("SELECT status FROM attempts WHERE attempt_id = ?")
      .get(attemptId) as { status: Attempt.AttemptStatus } | undefined;
    if (row === undefined) throw new StoreError("NotFound", "no such Attempt");
    return row.status;
  }

  #appendEvent(prepared: PreparedLaunch, type: string, payload: unknown): void {
    this.#appendLifecycleEvent({
      taskId: prepared.taskId,
      attemptId: prepared.attemptId,
      sessionId: prepared.plannedSessionId,
      type,
      payload,
    });
  }

  #appendLifecycleEvent(input: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly sessionId: string;
    readonly type: string;
    readonly payload: unknown;
  }): void {
    const now = new Date(this.#now()).toISOString();
    const sequence = this.#db
      .prepare(
        "SELECT COALESCE(MAX(timeline_seq), 0) + 1 AS seq FROM domain_events WHERE task_id = ?",
      )
      .get(input.taskId) as { seq: number };
    this.#db
      .prepare(
        `INSERT INTO domain_events
         (event_id, schema_version, task_id, attempt_id, session_id, timeline_seq,
          type, source, confidence, payload_json, occurred_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'daemon', 'authoritative', ?, ?, ?)`,
      )
      .run(
        `ev_${randomUUID()}`,
        EVENT_SCHEMA_VERSION,
        input.taskId,
        input.attemptId,
        input.sessionId,
        sequence.seq,
        input.type,
        JSON.stringify(input.payload),
        now,
        now,
      );
  }
}

const processExecPath = (): string => process.execPath;

const preparedLaunchFromRow = (
  row: LaunchIntentRow & { readonly task_id: string },
): PreparedLaunch => {
  let launchSpec: PreparedLaunch["launchSpec"];
  try {
    launchSpec = JSON.parse(row.launch_spec_json) as PreparedLaunch["launchSpec"];
  } catch {
    throw new StoreError("DataIntegrityFailure", "stored LaunchSpec is not valid JSON");
  }
  if (canonicalSha256(launchSpec) !== row.launch_spec_hash) {
    throw new StoreError("DataIntegrityFailure", "stored LaunchSpec hash does not match");
  }
  if (canonicalSha256(launchSpec.argv) !== row.argv_hash) {
    throw new StoreError("DataIntegrityFailure", "stored argv hash does not match");
  }
  return {
    kind: "prepared",
    attemptId: row.attempt_id,
    taskId: row.task_id,
    commandId: row.command_id,
    agentId: row.agent_id,
    slotLeaseId: row.slot_lease_id,
    launchNonce: row.launch_nonce,
    plannedSessionId: row.planned_session_id,
    launchSpec,
  };
};

const processIdentity = (
  pid: number,
): { readonly pgid: number; readonly lstart: string; readonly command: string } | null => {
  try {
    const field = (name: string): string =>
      execFileSync("/bin/ps", ["-o", `${name}=`, "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
      })
        .trim()
        .replace(/\s+/g, " ");
    const pgid = Number(field("pgid"));
    const lstart = field("lstart");
    const command = field("command");
    if (!Number.isInteger(pgid) || lstart.length === 0 || command.length === 0) return null;
    return { pgid, lstart, command };
  } catch {
    return null;
  }
};
