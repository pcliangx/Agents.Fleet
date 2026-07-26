// R0-14 — durable fake PTY sink：每次 write 把 bytes 的 hex 追加到
// pty-writes.log（含 fsync），作为「PTY owner 接受过几次、什么内容」的
// 独立 durable 证据，供崩溃后的 orchestrator 判定是否发生了重放。

import { join } from "node:path";
import type { PtySink } from "@agents-fleet/contracts";
import { appendDurableLogLine } from "../driver.js";

export const durableFakeSink = (workDir: string): PtySink => ({
  write: async (bytes: Uint8Array) => {
    appendDurableLogLine(join(workDir, "pty-writes.log"), Buffer.from(bytes).toString("hex"));
  },
  resize: async () => {},
  kill: async () => {},
  onOutput: () => () => {},
});
