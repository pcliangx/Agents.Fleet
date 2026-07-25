// R0-03 — the "Agent" child process, spawned via node-pty by daemon-worker.
//
// It is deliberately signal-trapping so the probe can OBSERVE which signals the
// kernel/node-pty deliver when the Daemon (PTY master owner) dies, independent
// of whether a default handler would have killed it. Survival in production
// therefore depends on each real Agent's own signal handling; this child
// measures the SUBSTRATE (signal delivery + reparenting), not any specific
// Agent's behavior.
//
// Writes are appendFileSync so they survive even if the PTY/master breaks:
//   - heartbeatFile: periodic liveness beats (proves still running after crash)
//   - signalLogFile: STARTED, every caught signal, STDOUT_ERROR (master gone),
//     and CONTROL_PIPE_EOF proxies
//
// Args: <heartbeatFile> <signalLogFile>

import { appendFileSync } from "node:fs";
import { hrtime } from "node:process";

const [, , heartbeatFile, signalLogFile] = process.argv;
if (!heartbeatFile || !signalLogFile) {
  console.error("usage: node agent-child.mjs <heartbeatFile> <signalLogFile>");
  process.exit(2);
}

const log = (event, extra = {}) => {
  appendFileSync(
    signalLogFile,
    `${JSON.stringify({ event, pid: process.pid, ppid: process.ppid, t: Number(hrtime.bigint()), ...extra })}\n`,
  );
};

log("STARTED", { bin: process.execPath, argv: process.argv.slice(2) });

// Periodic heartbeat → proves the child kept running across the crash window.
let beat = 0;
setInterval(() => {
  beat += 1;
  appendFileSync(heartbeatFile, `${JSON.stringify({ beat, pid: process.pid, t: Number(hrtime.bigint()) })}\n`);
}, 120);

// Periodic stdout write → if the PTY master is gone, stdout emits an error
// (EIO/EPIPE). That moment is a proxy for "Daemon disappeared" detectable by a
// child — relevant to the inert bootstrap self-timeout (RT-LAUNCH-06/07).
setInterval(() => {
  process.stdout.write(".", () => {});
}, 120);
process.stdout?.on?.("error", (err) => {
  log("STDOUT_ERROR", { code: err?.code, errno: err?.errno, syscall: err?.syscall });
});

// Catch and LOG every signal that could be delivered on master close / process
// death. Do NOT exit on any of them — the probe needs the child to survive so
// it can measure orphan reparenting and stop-by-pgid. Only SIGKILL (uncatchable)
// terminates this child.
for (const sig of ["SIGHUP", "SIGINT", "SIGTERM", "SIGUSR1", "SIGUSR2", "SIGQUIT", "SIGPIPE"]) {
  process.on(sig, () => log("SIGNAL", { sig }));
}

// Keep alive.
setInterval(() => {}, 1 << 30);
