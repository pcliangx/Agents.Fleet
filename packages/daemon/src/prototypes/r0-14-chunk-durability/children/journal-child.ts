// R0-14 — journal writer child。被崩溃驱动 spawn（tsx），扮演 Daemon 的
// stream 写入方：逐 frame 走 ByteJournal 完整 durability 协议，publishable
// 的 frame 记一行 published.log（durable 证据，含 fsync）。在武装的崩溃点
// 留下 marker 后自杀（SIGKILL），模拟 Daemon 在协议边界中途死亡（RT-T-23）。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ByteJournal } from "../../../session-runtime/byte-journal.js";
import { openSessionStoreDb } from "../../../session-runtime/store-schema.js";
import { appendDurableLogLine } from "../driver.js";

interface JournalChildConfig {
  readonly workDir: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly frames: readonly { readonly seq: number; readonly bytesHex: string }[];
  readonly crashPoint: string | null;
  readonly crashOnSeq: number;
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: journal-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as JournalChildConfig;

  const crashHere = (point: string): void => {
    writeFileSync(join(config.workDir, `crashed-at-${point}`), new Date().toISOString());
    process.kill(process.pid, "SIGKILL");
  };

  const db = openSessionStoreDb(join(config.workDir, "session-store.db"));
  const journal = new ByteJournal({
    storeDir: config.workDir,
    db,
    onStep: (step, frame) => {
      if (frame.seq === config.crashOnSeq && step === config.crashPoint) crashHere(step);
    },
  });

  for (const frame of config.frames) {
    const result = journal.appendFrame({
      sessionId: config.sessionId,
      generation: config.generation,
      seq: frame.seq,
      bytes: new Uint8Array(Buffer.from(frame.bytesHex, "hex")),
    });
    if (frame.seq === config.crashOnSeq && config.crashPoint === "beforePublish") {
      // RT-T-23 的 publish 边界：index + cursor 已提交，发布前死亡。
      crashHere("beforePublish");
    }
    if (result.publishable) {
      appendDurableLogLine(join(config.workDir, "published.log"), String(frame.seq));
    }
  }
  db.close();
};

await main();
