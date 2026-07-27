// R0-14 — intent writer child。扮演 Daemon 的 WriteSessionInput 路径：
// InputIntentStore.dispatch 走 content object durability → Prepared record →
// PTY write → Dispatched record。PTY 是 durable fake sink（pty-writes.log
// 独立证据）。武装崩溃点上 SIGKILL（RT-T-24）。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InputIntentStore } from "../../../session-runtime/input-intent-store.js";
import { openSessionStoreDb } from "../../../session-runtime/store-schema.js";
import { durableFakeSink } from "./durable-sink.js";

interface IntentChildConfig {
  readonly workDir: string;
  readonly commandId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly bytesHex: string;
  readonly crashPoint: string | null;
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: intent-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as IntentChildConfig;

  const db = openSessionStoreDb(join(config.workDir, "session-store.db"));
  const store = new InputIntentStore({
    storeDir: config.workDir,
    db,
    ptySink: durableFakeSink(config.workDir),
    onStep: (step) => {
      if (step === config.crashPoint) {
        writeFileSync(join(config.workDir, `crashed-at-${step}`), new Date().toISOString());
        process.kill(process.pid, "SIGKILL");
      }
    },
  });

  const result = await store.dispatch({
    commandId: config.commandId,
    sessionId: config.sessionId,
    generation: config.generation,
    attachmentId: "r0-fixture-attachment",
    fencingToken: 1,
    source: "Automation",
    bytes: new Uint8Array(Buffer.from(config.bytesHex, "hex")),
  });
  writeFileSync(join(config.workDir, "writer-outcome.json"), JSON.stringify({ result }));
  db.close();
};

await main();
