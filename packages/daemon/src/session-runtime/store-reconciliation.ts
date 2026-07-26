// R0-14 — StoreReconciliation（Seam 2，RT-STO-03、RT-REC-10）。
// 崩溃后从新进程对账 chunk 文件与 SQLite chunk index：
// - 有文件无索引 = orphan：完整最终文件（rename 只在 checksum + 文件 fsync
//   之后发生）经校验接纳进索引并按连续性推进 cursor；残留临时文件
//   （rename 前崩溃）隔离到 quarantine，绝不进索引。
// - 有索引无文件 / checksum 失败 = 显式 dataGap：保留索引与 cursor 原状，
//   读取走 ByteJournal 返回 DataIntegrityFailure，不用空 bytes 或旧数据伪装。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { advanceContiguousCursor } from "./byte-journal.js";
import {
  type QuarantinedFile,
  quarantineFile,
  sha256Hex,
  verifyContentObject,
} from "./content-object-io.js";
import { withTx } from "./store-schema.js";

export interface AdoptedOrphan {
  readonly sessionId: string;
  readonly generation: number;
  readonly seq: number;
}

export type IsolatedOrphan = QuarantinedFile;

export interface StoreDataGap {
  readonly sessionId: string;
  readonly generation: number;
  readonly seq: number;
  readonly reason: "file-missing" | "checksum-mismatch";
  /** 索引承诺的字节数，用于量化缺口（RT-PERF-05 的 missingByteCount 口径）。 */
  readonly byteLength: number;
}

export interface StoreReconciliationReport {
  readonly adoptedOrphans: readonly AdoptedOrphan[];
  readonly isolatedOrphans: readonly IsolatedOrphan[];
  readonly dataGaps: readonly StoreDataGap[];
  readonly verifiedChunks: number;
}

const CHUNK_FILE_RE = /^chunk-(\d+)\.bin$/;

export const reconcileStore = (storeDir: string, db: DatabaseSync): StoreReconciliationReport => {
  const adoptedOrphans: AdoptedOrphan[] = [];
  const isolatedOrphans: IsolatedOrphan[] = [];
  const dataGaps: StoreDataGap[] = [];
  let verifiedChunks = 0;

  // 1) 索引视角：每条 chunk index 必须有可信文件（RT-STO-03 的 dataGap 方向）。
  const rows = db
    .prepare(
      "SELECT session_id, generation, seq, chunk_path, byte_length, sha256 FROM chunks ORDER BY session_id, generation, seq",
    )
    .all() as unknown as {
    session_id: string;
    generation: number;
    seq: number;
    chunk_path: string;
    byte_length: number;
    sha256: string;
  }[];

  for (const row of rows) {
    const verification = verifyContentObject(join(storeDir, row.chunk_path), row.sha256);
    if (!verification.ok) {
      dataGaps.push({
        sessionId: row.session_id,
        generation: row.generation,
        seq: row.seq,
        reason: verification.reason,
        byteLength: row.byte_length,
      });
      continue;
    }
    verifiedChunks += 1;
  }

  // 2) 文件视角：无索引的文件是 orphan（RT-STO-03 的 orphan 方向）。
  const chunksRoot = join(storeDir, "chunks");
  if (existsSync(chunksRoot)) {
    for (const sessionId of readdirSync(chunksRoot)) {
      const sessionDir = join(chunksRoot, sessionId);
      for (const generationName of readdirSync(sessionDir)) {
        const generation = Number(generationName);
        const generationDir = join(sessionDir, generationName);
        const adoptedHere: AdoptedOrphan[] = [];
        for (const file of readdirSync(generationDir)) {
          const abs = join(generationDir, file);
          if (file.startsWith(".tmp-")) {
            // rename 前崩溃的残骸：内容完整性无从保证 → 隔离，绝不接纳。
            isolatedOrphans.push(
              quarantineFile({
                storeDir,
                relativeDir: join("chunks", sessionId, generationName),
                fileName: file,
                quarantineName: `${sessionId}-${generationName}-${file.replace(/^\.tmp-/, "tmp-")}`,
              }),
            );
            continue;
          }
          const match = CHUNK_FILE_RE.exec(file);
          if (!match) continue;
          const seq = Number(match[1]);
          const indexed = db
            .prepare(
              "SELECT 1 AS x FROM chunks WHERE session_id = ? AND generation = ? AND seq = ?",
            )
            .get(sessionId, generation, seq);
          if (indexed !== undefined) continue; // 已在索引视角验证

          // orphan 最终文件：文件协议保证 rename 即完整 + 已 fsync → 校验后接纳。
          // R1 注明：这里的「校验」只是自算 sha256 入库（协议内自洽）；一个
          // 非协议来源的同名最终文件（外部进程按命名规则投放）同样会被接纳。
          // 本原型接受这一点（orphan 只在 Daemon 自己的 storeDir 内产生）；
          // R1 若放宽 storeDir 的信任边界，需要更强的来源判定。
          const bytes = readFileSync(abs);
          withTx(db, () => {
            db.prepare(
              "INSERT INTO chunks (session_id, generation, seq, chunk_path, byte_length, sha256) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              sessionId,
              generation,
              seq,
              join("chunks", sessionId, generationName, file),
              bytes.byteLength,
              sha256Hex(bytes),
            );
          });
          adoptedHere.push({ sessionId, generation, seq });
        }

        // 接纳后按连续性推进 cursor（绝不跳 seq，RT-ORDER-07）。
        if (adoptedHere.length > 0) {
          withTx(db, () => {
            advanceContiguousCursor(db, { sessionId, generation });
          });
          adoptedOrphans.push(...adoptedHere.sort((a, b) => a.seq - b.seq));
        }
      }
    }
  }

  return { adoptedOrphans, isolatedOrphans, dataGaps, verifiedChunks };
};
