// R0-14 — intent recover child。writer 死后从**新进程**执行 Input Intent
// Reconciliation（Prepared → Uncertain、object 缺失 / 损坏 → dataGap、
// 无 record orphan 隔离），然后用**相同 commandId + 相同 bytes** 重发
// （RT-INPUT-03/04：只能得到原结果，绝不自动重放）。pty-writes.log 继续
// 由 durable fake sink 追加，orchestrator 据此判定 PTY write 总次数。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InputIntentStore,
  reconcileInputIntents,
} from "../../../session-runtime/input-intent-store.js";
import { openSessionStoreDb } from "../../../session-runtime/store-schema.js";
import { durableFakeSink } from "./durable-sink.js";

interface IntentRecoverConfig {
  readonly workDir: string;
  readonly commandId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly bytesHex: string;
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: intent-recover-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as IntentRecoverConfig;

  const db = openSessionStoreDb(join(config.workDir, "session-store.db"));
  const report = reconcileInputIntents(config.workDir, db);

  const store = new InputIntentStore({
    storeDir: config.workDir,
    db,
    ptySink: durableFakeSink(config.workDir),
  });
  const redispatchResult = await store.dispatch({
    commandId: config.commandId,
    sessionId: config.sessionId,
    generation: config.generation,
    bytes: new Uint8Array(Buffer.from(config.bytesHex, "hex")),
  });

  writeFileSync(
    join(config.workDir, "intent-recover-outcome.json"),
    JSON.stringify({ report, redispatchResult }),
  );
  db.close();
};

await main();
