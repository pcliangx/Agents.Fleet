// R0-14 — StoreReconciliation 行为测试（Seam 2，RT-STO-03、RT-REC-10）。
// 有文件无索引 = orphan（校验后接纳或隔离）；有索引无文件 / checksum 失败 =
// 显式 dataGap，读取返回 DataIntegrityFailure，不用空 bytes 或旧数据伪装。
// 测试输入（崩溃后的磁盘残骸）直接由 fs 构造；断言只打公开 seam
// （reconcileStore 报告 + ByteJournal 读取）。

import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ByteJournal, chunkRelativePath, DataIntegrityFailure } from "./byte-journal.js";
import { reconcileStore } from "./store-reconciliation.js";
import { openSessionStoreDb } from "./store-schema.js";

const FRAME_A = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff]);
const FRAME_B = new TextEncoder().encode("orphan-payload 中文\r\n");

const STREAM = { sessionId: "ses-1", generation: 1 } as const;

/** 模拟「rename 完成、index tx 未提交」的崩溃残骸：完整最终文件、无索引。 */
const writeOrphanChunk = (storeDir: string, seq: number, bytes: Uint8Array): void => {
  const rel = chunkRelativePath(STREAM.sessionId, STREAM.generation, seq);
  const abs = join(storeDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
};

describe("StoreReconciliation (R0-14 Seam 2)", () => {
  let storeDir: string;
  let db: ReturnType<typeof openSessionStoreDb>;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "r0-14-reconcile-"));
    db = openSessionStoreDb(join(storeDir, "session-store.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("健康 store：无 orphan、无 dataGap，cursor 不变", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 1, bytes: FRAME_A });

    const report = reconcileStore(storeDir, db);
    expect(report.adoptedOrphans).toEqual([]);
    expect(report.isolatedOrphans).toEqual([]);
    expect(report.dataGaps).toEqual([]);
    expect(report.verifiedChunks).toBe(1);
    expect(journal.durableCursor(STREAM)).toBe(1);
  });

  it("有文件无索引的完整 chunk 被校验后接纳，cursor 连续推进、bytes 可读回（RT-STO-03）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 1, bytes: FRAME_A });
    // 崩溃残骸：seq=2 已 rename 但 index tx 未提交。
    writeOrphanChunk(storeDir, 2, FRAME_B);

    const report = reconcileStore(storeDir, db);
    expect(report.adoptedOrphans).toEqual([{ ...STREAM, seq: 2 }]);
    expect(report.dataGaps).toEqual([]);

    expect(journal.durableCursor(STREAM)).toBe(2);
    const adopted = journal.readFrame({ ...STREAM, seq: 2 });
    if (adopted === null) throw new Error("adopted orphan must be publishable");
    expect([...adopted]).toEqual([...FRAME_B]);
  });

  it("orphan 不跳 seq：缺口未补时接纳但不推进 cursor（RT-ORDER-07）", () => {
    writeOrphanChunk(storeDir, 2, FRAME_B);

    const report = reconcileStore(storeDir, db);
    expect(report.adoptedOrphans).toEqual([{ ...STREAM, seq: 2 }]);

    const journal = new ByteJournal({ storeDir, db });
    expect(journal.durableCursor(STREAM)).toBe(0);
    expect(journal.readFrame({ ...STREAM, seq: 2 })).toBeNull();
  });

  it("残留临时文件（rename 前崩溃）被隔离到 quarantine，不进索引、不影响 cursor（RT-STO-03）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 1, bytes: FRAME_A });
    const chunkDir = join(storeDir, "chunks", STREAM.sessionId, String(STREAM.generation));
    writeFileSync(join(chunkDir, ".tmp-1234-deadbeef"), FRAME_B);

    const report = reconcileStore(storeDir, db);
    expect(report.adoptedOrphans).toEqual([]);
    expect(report.isolatedOrphans).toHaveLength(1);
    expect(report.isolatedOrphans[0]?.originalPath).toContain(".tmp-1234-deadbeef");

    // 原位置已清空，临时残骸只存在于 quarantine。
    expect(readdirSync(chunkDir).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
    expect(journal.durableCursor(STREAM)).toBe(1);
    expect(journal.readFrame({ ...STREAM, seq: 2 })).toBeNull();
  });

  it("有索引无文件 = 显式 dataGap；读取返回 DataIntegrityFailure（RT-STO-03、RT-REC-10）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 1, bytes: FRAME_A });
    unlinkSync(join(storeDir, chunkRelativePath(STREAM.sessionId, STREAM.generation, 1)));

    const report = reconcileStore(storeDir, db);
    expect(report.dataGaps).toEqual([
      { ...STREAM, seq: 1, reason: "file-missing", byteLength: FRAME_A.byteLength },
    ]);

    // 不伪装：cursor 与索引保留原状，读取显式失败而非返回空 bytes。
    expect(journal.durableCursor(STREAM)).toBe(1);
    expect(() => journal.readFrame({ ...STREAM, seq: 1 })).toThrow(DataIntegrityFailure);
  });

  it("checksum 失败 = 显式 dataGap；读取返回 DataIntegrityFailure（RT-REC-10）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 1, bytes: FRAME_A });
    writeFileSync(
      join(storeDir, chunkRelativePath(STREAM.sessionId, STREAM.generation, 1)),
      new Uint8Array([0xaa, 0xbb]),
    );

    const report = reconcileStore(storeDir, db);
    expect(report.dataGaps).toEqual([
      { ...STREAM, seq: 1, reason: "checksum-mismatch", byteLength: FRAME_A.byteLength },
    ]);
    expect(() => journal.readFrame({ ...STREAM, seq: 1 })).toThrow(DataIntegrityFailure);
  });

  it("索引中 cursor 之后的乱序 chunk 不产生 dataGap，也不推进 cursor", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ ...STREAM, seq: 2, bytes: FRAME_B });

    const report = reconcileStore(storeDir, db);
    expect(report.dataGaps).toEqual([]);
    expect(report.verifiedChunks).toBe(1);
    expect(journal.durableCursor(STREAM)).toBe(0);
  });
});
