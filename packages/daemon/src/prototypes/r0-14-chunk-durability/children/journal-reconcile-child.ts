// R0-14 — journal reconcile child。writer 死后从**新进程**执行
// StoreReconciliation，然后续写余下 frame（同一 session / generation，
// seq 接续；已 durable 的同 bytes frame 走幂等重放），publishable 的记
// published.log。reconcile 报告写入 reconcile-outcome.json 供 orchestrator 断言。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ByteJournal } from "../../../session-runtime/byte-journal.js";
import { reconcileStore } from "../../../session-runtime/store-reconciliation.js";
import { openSessionStoreDb } from "../../../session-runtime/store-schema.js";
import { appendDurableLogLine } from "../driver.js";

interface JournalReconcileConfig {
  readonly workDir: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly resumeFrames: readonly { readonly seq: number; readonly bytesHex: string }[];
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: journal-reconcile-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as JournalReconcileConfig;

  const db = openSessionStoreDb(join(config.workDir, "session-store.db"));
  const report = reconcileStore(config.workDir, db);

  const journal = new ByteJournal({ storeDir: config.workDir, db });
  for (const frame of config.resumeFrames) {
    const result = journal.appendFrame({
      sessionId: config.sessionId,
      generation: config.generation,
      seq: frame.seq,
      bytes: new Uint8Array(Buffer.from(frame.bytesHex, "hex")),
    });
    if (result.publishable) {
      appendDurableLogLine(join(config.workDir, "published.log"), String(frame.seq));
    }
  }

  writeFileSync(join(config.workDir, "reconcile-outcome.json"), JSON.stringify({ report }));
  db.close();
};

await main();
