// R0-14 — ByteJournal：Session 原始字节的 append-only chunk store（Seam 1）。
// 一个 frame 只有在完整 durability 协议（临时 chunk → checksum → 文件 fsync →
// 原子 rename → 目录 fsync → SQLite 单事务写 chunk index + 推进连续
// Durable Stream Cursor）完成后才可发布（RT-STO-02、RT-INV-09）；
// cursor 严格连续，不越过缺失 / 未索引 / checksum 未验证的 frame（RT-ORDER-07）。
// 读取只提供 cursor 覆盖的 frame；索引在而文件缺失 / checksum 失败返回
// DataIntegrityFailure，绝不用空 bytes 或旧数据伪装（RT-STO-03、RT-REC-10）。

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ContentObjectStep,
  durableWriteContentObject,
  sha256Hex,
  verifyContentObject,
} from "./content-object-io.js";
import { withTx } from "./store-schema.js";

/** 读取时内容不可信：索引覆盖但文件缺失或 checksum 失败（RT-STO-03 的 dataGap）。 */
export class DataIntegrityFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataIntegrityFailure";
  }
}

/** 一条 Session stream 的命名空间（RT-ORDER-01：seq 只在其内单调）。 */
export interface StreamRef {
  readonly sessionId: string;
  readonly generation: number;
}

export interface FrameRef extends StreamRef {
  readonly seq: number;
}

/** RT-T-23 边界：文件协议四步 + SQLite index + Durable Stream Cursor commit。 */
export type ByteJournalStep = ContentObjectStep | "afterIndexTx";

export interface AppendResult {
  /** cursor 是否已覆盖该 frame（RT-STO-08：覆盖前不可发布）。 */
  readonly publishable: boolean;
  readonly durableCursor: number;
}

export const chunkRelativePath = (sessionId: string, generation: number, seq: number): string =>
  join("chunks", sessionId, String(generation), `chunk-${String(seq).padStart(6, "0")}.bin`);

interface ChunkRow {
  readonly chunk_path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export class ByteJournal {
  private readonly storeDir: string;
  private readonly db: DatabaseSync;
  private readonly onStep: ((step: ByteJournalStep, frame: FrameRef) => void) | undefined;

  constructor(opts: {
    readonly storeDir: string;
    readonly db: DatabaseSync;
    /** 崩溃注入 seam（RT-T-23）：在每个协议边界同步回调。 */
    readonly onStep?: (step: ByteJournalStep, frame: FrameRef) => void;
  }) {
    this.storeDir = opts.storeDir;
    this.db = opts.db;
    this.onStep = opts.onStep;
  }

  /** RT-ORDER-07：最大连续 durable seq；无 frame 时为 0。 */
  readonly durableCursor = (ref: StreamRef): number => {
    const row = this.db
      .prepare("SELECT durable_seq FROM stream_cursors WHERE session_id = ? AND generation = ?")
      .get(ref.sessionId, ref.generation) as { durable_seq: number } | undefined;
    return row?.durable_seq ?? 0;
  };

  /**
   * RT-STO-02：先完成文件协议，再在单个 SQLite transaction 中写 chunk index
   * 并推进连续 cursor；该 transaction 提交前调用者不得发布受影响 frame。
   * 同 seq 同 bytes 重放幂等（producer 崩溃恢复后重发）；同 seq 不同 bytes 拒绝。
   */
  readonly appendFrame = (frame: FrameRef & { readonly bytes: Uint8Array }): AppendResult => {
    const { sessionId, generation, seq, bytes } = frame;
    const sha256 = sha256Hex(bytes);

    const existing = this.chunkRow(frame);
    if (existing) {
      if (existing.sha256 !== sha256) {
        throw new Error(
          `appendFrame: seq ${seq} already durable with different content (RT-ORDER-01/02 violation)`,
        );
      }
      const cursor = this.durableCursor(frame);
      return { publishable: seq <= cursor, durableCursor: cursor };
    }

    const written = durableWriteContentObject({
      storeDir: this.storeDir,
      relativeDir: join("chunks", sessionId, String(generation)),
      finalName: `chunk-${String(seq).padStart(6, "0")}.bin`,
      bytes,
      onStep: (step) => this.onStep?.(step, frame),
    });

    // 单事务：chunk index + 连续 cursor 推进（RT-STO-02、RT-ORDER-07）。
    const cursor = withTx(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO chunks (session_id, generation, seq, chunk_path, byte_length, sha256) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, generation, seq, written.relativePath, written.byteLength, written.sha256);
      return advanceContiguousCursor(this.db, frame);
    });
    this.onStep?.("afterIndexTx", frame);

    return { publishable: seq <= cursor, durableCursor: cursor };
  };

  /**
   * 按 cursor 读取 publishable frame。seq 尚未被 cursor 覆盖返回 null；
   * cursor 覆盖但 index 缺失 / 文件缺失 / checksum 失败抛 DataIntegrityFailure
   * （RT-STO-03：显式 dataGap，不伪装）。
   */
  readonly readFrame = (frame: FrameRef): Uint8Array | null => {
    const cursor = this.durableCursor(frame);
    const row = this.chunkRow(frame);
    if (!row) {
      if (frame.seq <= cursor) {
        throw new DataIntegrityFailure(
          `chunk index missing for ${frame.sessionId}/${frame.generation}/seq ${frame.seq} within durable cursor ${cursor}`,
        );
      }
      return null;
    }
    if (frame.seq > cursor) return null; // 未覆盖，不可发布（RT-STO-08）

    const verification = verifyContentObject(join(this.storeDir, row.chunk_path), row.sha256);
    if (!verification.ok) {
      throw new DataIntegrityFailure(
        `chunk ${verification.reason} for ${frame.sessionId}/${frame.generation}/seq ${frame.seq} (${row.chunk_path})`,
      );
    }
    return verification.bytes;
  };

  private readonly chunkRow = (frame: FrameRef): ChunkRow | undefined =>
    this.db
      .prepare(
        "SELECT chunk_path, byte_length, sha256 FROM chunks WHERE session_id = ? AND generation = ? AND seq = ?",
      )
      .get(frame.sessionId, frame.generation, frame.seq) as ChunkRow | undefined;
}

/** RT-ORDER-07：cursor 只前进到连续 chunk index 覆盖处；调用方负责事务上下文。 */
export const advanceContiguousCursor = (db: DatabaseSync, ref: StreamRef): number => {
  const row = db
    .prepare("SELECT durable_seq FROM stream_cursors WHERE session_id = ? AND generation = ?")
    .get(ref.sessionId, ref.generation) as { durable_seq: number } | undefined;
  const current = row?.durable_seq ?? 0;
  let next = current + 1;
  while (
    db
      .prepare("SELECT 1 AS x FROM chunks WHERE session_id = ? AND generation = ? AND seq = ?")
      .get(ref.sessionId, ref.generation, next) !== undefined
  ) {
    next += 1;
  }
  const advanced = next - 1;
  if (advanced > current) {
    db.prepare(
      "INSERT INTO stream_cursors (session_id, generation, durable_seq) VALUES (?, ?, ?) ON CONFLICT (session_id, generation) DO UPDATE SET durable_seq = excluded.durable_seq",
    ).run(ref.sessionId, ref.generation, advanced);
  }
  return Math.max(current, advanced);
};
