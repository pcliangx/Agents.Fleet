// R0-07 — fake agent. Stands in for the real CLI Agent (R0-09 / R1 will
// exercise real agents via node-pty). Writes its full process identity so the
// Daemon can "observe the Agent" (RT-LAUNCH-04), then heartbeats to a file so
// an INDEPENDENT process can verify "exactly one agent is running".
//
// argv: --nonce N --dir D --argv-hash H

import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { arg, lstartOf } from "./child-util.mjs";

const args = process.argv.slice(2);
const nonce = arg(args, "nonce");
const dir = arg(args, "dir");
const argvHash = arg(args, "argv-hash");
if (!nonce || !dir || !argvHash) {
  console.error("fake-agent: missing required args");
  process.exit(2);
}

// Atomic self-identity: write tmp + rename.
const identity = JSON.stringify({
  nonce,
  pid: process.pid,
  pgid: process.pid, // spawned detached: own process group leader
  ppid: process.ppid,
  lstart: lstartOf(process.pid),
  argvHash,
  startedAt: new Date().toISOString(),
});
const identityPath = `${dir}/agent-${nonce}.json`;
writeFileSync(`${identityPath}.tmp`, identity);
renameSync(`${identityPath}.tmp`, identityPath);

const heartbeatPath = `${dir}/agent-${nonce}.hb`;
let beats = 0;
const timer = setInterval(() => {
  beats += 1;
  try {
    appendFileSync(heartbeatPath, `${process.pid} ${beats} ${Date.now()}\n`);
  } catch {
    // heartbeat is best-effort evidence; the process itself is the fact.
  }
}, 40);

process.on("SIGTERM", () => {
  clearInterval(timer);
  try {
    appendFileSync(heartbeatPath, `${process.pid} sigterm ${Date.now()}\n`);
  } catch {}
  process.exit(0);
});
