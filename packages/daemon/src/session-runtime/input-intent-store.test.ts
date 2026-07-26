// R0-14 — InputIntentStore 行为测试（Seam 3，RT-STO-11、RT-INPUT-01..04）。
// 原始 bytes 的 content object 先 durable（与 chunk 同一文件协议），再落
// SQLite Prepared record，此前绝不写 PTY；Prepared/Dispatched 之间崩溃
// 标 Uncertain 绝不自动重放；同 commandId 重试返回原结果不重复写 PTY；
// object 缺失/损坏 → DataGap（明确失败）且绝不写 PTY。
// PTY 用 fake sink（@agents-fleet/testing 的 FakePty，PtySink 契约）。

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePty } from "@agents-fleet/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataIntegrityFailure } from "./byte-journal.js";
import { InputIntentStore, reconcileInputIntents } from "./input-intent-store.js";
import { openSessionStoreDb } from "./store-schema.js";

const INPUT_BYTES = new Uint8Array([0x6c, 0x73, 0x20, 0x2d, 0x6c, 0x0d, 0x00, 0xff]); // "ls -l\r" + NUL + invalid
const SESSION = "ses-1";
const GENERATION = 1;

describe("InputIntentStore (R0-14 Seam 3)", () => {
  let storeDir: string;
  let db: ReturnType<typeof openSessionStoreDb>;
  let sink: FakePty;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "r0-14-intent-"));
    db = openSessionStoreDb(join(storeDir, "session-store.db"));
    sink = new FakePty();
  });

  afterEach(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("dispatch 成功：content object 与 Prepared/Dispatched record 落库，PTY 收到逐字节相同 bytes（RT-INPUT-01/02）", async () => {
    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    const result = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    expect(result.status).toBe("Dispatched");
    expect([...sink.writtenBytes]).toEqual([...INPUT_BYTES]);

    // contentRef 指向的原始 bytes 可读回（RT-INPUT-01：恢复源是 object，不是 DB）。
    const content = store.readContent("cmd-1");
    expect([...content]).toEqual([...INPUT_BYTES]);
  });

  it("同 commandId 重发返回原 Dispatched 结果，不重复写 PTY（RT-INPUT-04）", async () => {
    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    const first = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    const second = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    expect(second).toEqual(first);
    expect(sink.writtenBytes.byteLength).toBe(INPUT_BYTES.byteLength);
  });

  it("同 commandId 不同 bytes 是 IdempotencyConflict，不写 PTY", async () => {
    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    const conflict = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: new Uint8Array([0x01, 0x02]),
    });
    expect(conflict.status).toBe("IdempotencyConflict");
    expect(sink.writtenBytes.byteLength).toBe(INPUT_BYTES.byteLength);
  });

  it("Prepared 与 Dispatched 之间崩溃 → Reconciliation 标 Uncertain，重试返回 Uncertain 且绝不重放（RT-INPUT-03）", async () => {
    // 用公开注入 seam 在 afterPreparedTx 边界中断 dispatch，留下 Prepared 残骸。
    const doomed = new InputIntentStore({
      storeDir,
      db,
      ptySink: sink,
      onStep: (step) => {
        if (step === "afterPreparedTx") throw new Error("simulated daemon crash");
      },
    });
    await expect(
      doomed.dispatch({
        commandId: "cmd-1",
        sessionId: SESSION,
        generation: GENERATION,
        bytes: INPUT_BYTES,
      }),
    ).rejects.toThrow("simulated daemon crash");

    const report = reconcileInputIntents(storeDir, db);
    expect(report.markedUncertain).toEqual(["cmd-1"]);

    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    const retry = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    expect(retry.status).toBe("Uncertain");
    expect(sink.writtenBytes.byteLength).toBe(0); // 绝不自动重放
  });

  it("有 record 但 content object 缺失 → 重发返回 DataGap（明确失败），绝不写 PTY（RT-STO-11）", async () => {
    const doomed = new InputIntentStore({
      storeDir,
      db,
      ptySink: sink,
      onStep: (step) => {
        if (step === "afterPreparedTx") throw new Error("simulated daemon crash");
      },
    });
    await expect(
      doomed.dispatch({
        commandId: "cmd-1",
        sessionId: SESSION,
        generation: GENERATION,
        bytes: INPUT_BYTES,
      }),
    ).rejects.toThrow();
    // 磁盘损坏：content object 丢失。
    unlinkSync(join(storeDir, "input-intents", "cmd-1.bin"));

    const report = reconcileInputIntents(storeDir, db);
    expect(report.dataGaps).toEqual(["cmd-1"]);

    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    const retry = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    expect(retry.status).toBe("DataGap");
    expect(sink.writtenBytes.byteLength).toBe(0);
  });

  it("Dispatched 之后 object 损坏 → readContent 返回 DataIntegrityFailure，不伪装（RT-STO-11、RT-REC-10）", async () => {
    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    writeFileSync(join(storeDir, "input-intents", "cmd-1.bin"), new Uint8Array([0x00]));

    const report = reconcileInputIntents(storeDir, db);
    expect(report.dataGaps).toEqual(["cmd-1"]);
    expect(() => store.readContent("cmd-1")).toThrow(DataIntegrityFailure);
  });

  it("无 record 的 orphan content object 被隔离到 quarantine（RT-STO-11）", async () => {
    const doomed = new InputIntentStore({
      storeDir,
      db,
      ptySink: sink,
      onStep: (step) => {
        if (step === "afterDirFsync") throw new Error("simulated daemon crash");
      },
    });
    await expect(
      doomed.dispatch({
        commandId: "cmd-1",
        sessionId: SESSION,
        generation: GENERATION,
        bytes: INPUT_BYTES,
      }),
    ).rejects.toThrow();

    const report = reconcileInputIntents(storeDir, db);
    expect(report.isolatedOrphans).toHaveLength(1);
    expect(report.isolatedOrphans[0]?.originalPath).toContain("cmd-1.bin");

    // object 被隔离后，同 commandId 作为全新命令正常 dispatch（此前从未有 record）。
    const store = new InputIntentStore({ storeDir, db, ptySink: sink });
    const result = await store.dispatch({
      commandId: "cmd-1",
      sessionId: SESSION,
      generation: GENERATION,
      bytes: INPUT_BYTES,
    });
    expect(result.status).toBe("Dispatched");
    expect([...sink.writtenBytes]).toEqual([...INPUT_BYTES]);
  });
});
