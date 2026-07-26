// R0-14 — ByteJournal 行为测试（Seam 1，RT-STO-02、RT-STO-08、RT-ORDER-07、RT-PERF-05）。
// 真实临时文件系统 + 真实 node:sqlite（ADR-0005：不暴露仅供 mock 的 Seam）。
// 预期字节来自独立 fixture（已知字节序列），断言只打公开 seam。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ByteJournal, DataIntegrityFailure } from "./byte-journal.js";
import { openSessionStoreDb } from "./store-schema.js";

// 独立已知字节序列：ANSI escape + NUL + invalid UTF-8 + 跨字节 multibyte（RT-T-32 形状）。
const FRAME_A = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xfe, 0xaa]);
const FRAME_B = new TextEncoder().encode("prompt$ 中文🙂\r\n");
const FRAME_C = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00]);

const SESSION = "ses-1";
const GENERATION = 1;

/** 读取并断言非 null（cursor 已覆盖的 frame 必须存在，否则就是测试要抓的 bug）。 */
const mustRead = (
  journal: ByteJournal,
  sessionId: string,
  generation: number,
  seq: number,
): Uint8Array => {
  const read = journal.readFrame(sessionId, generation, seq);
  if (read === null) throw new Error(`expected frame seq ${seq} to be publishable`);
  return read;
};

describe("ByteJournal (R0-14 Seam 1)", () => {
  let storeDir: string;
  let db: ReturnType<typeof openSessionStoreDb>;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "r0-14-journal-"));
    db = openSessionStoreDb(join(storeDir, "session-store.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("单 frame 完成 durability 协议后可发布，按 cursor 逐字节读回（RT-STO-02）", () => {
    const journal = new ByteJournal({ storeDir, db });
    const result = journal.appendFrame({
      sessionId: SESSION,
      generation: GENERATION,
      seq: 1,
      bytes: FRAME_A,
    });
    expect(result.publishable).toBe(true);
    expect(result.durableCursor).toBe(1);
    expect(journal.durableCursor(SESSION, GENERATION)).toBe(1);
    expect([...mustRead(journal, SESSION, GENERATION, 1)]).toEqual([...FRAME_A]);
  });

  it("顺序 append 多个 frame，cursor 连续推进，全部可读（RT-ORDER-07）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_A });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 2, bytes: FRAME_B });
    const third = journal.appendFrame({
      sessionId: SESSION,
      generation: GENERATION,
      seq: 3,
      bytes: FRAME_C,
    });
    expect(third.durableCursor).toBe(3);
    expect([...mustRead(journal, SESSION, GENERATION, 2)]).toEqual([...FRAME_B]);
    expect([...mustRead(journal, SESSION, GENERATION, 3)]).toEqual([...FRAME_C]);
  });

  it("乱序 append 不跳 seq：缺口未补前 cursor 不推进、后续 frame 不可发布（RT-ORDER-07、RT-STO-08）", () => {
    const journal = new ByteJournal({ storeDir, db });
    const outOfOrder = journal.appendFrame({
      sessionId: SESSION,
      generation: GENERATION,
      seq: 2,
      bytes: FRAME_B,
    });
    // seq=2 的字节已 durable（chunk 协议完成），但 cursor 不能越过缺失的 seq=1。
    expect(outOfOrder.publishable).toBe(false);
    expect(outOfOrder.durableCursor).toBe(0);
    expect(journal.readFrame(SESSION, GENERATION, 2)).toBeNull();

    const gap = journal.appendFrame({
      sessionId: SESSION,
      generation: GENERATION,
      seq: 1,
      bytes: FRAME_A,
    });
    expect(gap.durableCursor).toBe(2);
    expect([...mustRead(journal, SESSION, GENERATION, 2)]).toEqual([...FRAME_B]);
  });

  it("同 seq 同 bytes 重放幂等；同 seq 不同 bytes 拒绝（producer 违背 RT-ORDER-01）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_A });
    const replay = journal.appendFrame({
      sessionId: SESSION,
      generation: GENERATION,
      seq: 1,
      bytes: FRAME_A,
    });
    expect(replay.publishable).toBe(true);
    expect(replay.durableCursor).toBe(1);
    expect(() =>
      journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_B }),
    ).toThrow();
    expect(journal.durableCursor(SESSION, GENERATION)).toBe(1);
    expect([...mustRead(journal, SESSION, GENERATION, 1)]).toEqual([...FRAME_A]);
  });

  it("Durable Stream Cursor 按 {sessionId, generation} 隔离（RT-ORDER-01）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_A });
    journal.appendFrame({ sessionId: "ses-2", generation: GENERATION, seq: 1, bytes: FRAME_B });
    journal.appendFrame({ sessionId: SESSION, generation: 2, seq: 1, bytes: FRAME_C });

    expect(journal.durableCursor(SESSION, GENERATION)).toBe(1);
    expect(journal.durableCursor("ses-2", GENERATION)).toBe(1);
    expect(journal.durableCursor(SESSION, 2)).toBe(1);
    expect(journal.durableCursor("ses-2", 2)).toBe(0);
    expect([...mustRead(journal, "ses-2", GENERATION, 1)]).toEqual([...FRAME_B]);
    expect([...mustRead(journal, SESSION, 2, 1)]).toEqual([...FRAME_C]);
  });

  it("cursor 之前不存在的 frame 返回 null，不伪装空 bytes", () => {
    const journal = new ByteJournal({ storeDir, db });
    expect(journal.durableCursor(SESSION, GENERATION)).toBe(0);
    expect(journal.readFrame(SESSION, GENERATION, 1)).toBeNull();
  });

  it("新进程（新实例重开同一 storeDir + DB）后 cursor 与 bytes 仍在（RT-PERF-05）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_A });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 2, bytes: FRAME_B });
    db.close();

    db = openSessionStoreDb(join(storeDir, "session-store.db"));
    const reopened = new ByteJournal({ storeDir, db });
    expect(reopened.durableCursor(SESSION, GENERATION)).toBe(2);
    expect([...mustRead(reopened, SESSION, GENERATION, 1)]).toEqual([...FRAME_A]);
    expect([...mustRead(reopened, SESSION, GENERATION, 2)]).toEqual([...FRAME_B]);
  });

  it("cursor 覆盖但 chunk 文件被外部破坏时读取返回 DataIntegrityFailure（RT-STO-03）", () => {
    const journal = new ByteJournal({ storeDir, db });
    journal.appendFrame({ sessionId: SESSION, generation: GENERATION, seq: 1, bytes: FRAME_A });
    // 外部破坏：直接篡改 chunk 文件内容（模拟磁盘损坏，属测试输入而非断言侧道）。
    const chunkPath = join(storeDir, "chunks", SESSION, String(GENERATION), "chunk-000001.bin");
    // 覆写为已知不同内容，checksum 必失败。
    writeFileSync(chunkPath, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(() => journal.readFrame(SESSION, GENERATION, 1)).toThrow(DataIntegrityFailure);
  });
});
