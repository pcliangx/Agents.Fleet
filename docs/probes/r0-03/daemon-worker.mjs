// R0-03 — the "Daemon" (PTY master owner). Spawned by probe.mjs as a child
// process so the orchestrator can kill it (simulating Daemon crash) and then
// observe the node-pty child's fate from a SEPARATE process (= Reconciliation
// in a new Daemon).
//
// Loads node-pty via createRequire from the temp install dir (outside the repo)
// so this file stays out of the packages/apps node-pty guard (RT-TERM-08 /
// SV1-AUTH-09).
//
// On startup it:
//   1. pty.spawn() the agent-child via node-pty (encoding:null, raw Buffer)
//   2. records the child's FULL process identity via `ps` to identityFile
//      (RT-REC-12: Reconciliation must probe by full identity, not PID alone)
//   3. waits — no SIGTERM/SIGINT handler, so a signal kills it with default
//      semantics (the master fd is then closed by the kernel)
//   4. honors a single stdin control "EXIT" → process.exit(0) (graceful close)
//
// Args: <installDir> <agentChildScript> <identityFile> <heartbeatFile> <signalLogFile>

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , installDir, agentChildScript, identityFile, heartbeatFile, signalLogFile] = process.argv;
if (!installDir || !agentChildScript || !identityFile || !heartbeatFile || !signalLogFile) {
  console.error(
    "usage: node daemon-worker.mjs <installDir> <agentChildScript> <identityFile> <heartbeatFile> <signalLogFile>",
  );
  process.exit(2);
}

const require = createRequire(resolve(installDir, "package.json"));
const pty = require("node-pty");
const nodePtyVersion = require("node-pty/package.json").version;

// encoding:null → raw Buffer (RT-TERM-08). Child = agent-child.mjs in a neutral cwd.
const ptyProc = pty.spawn(process.execPath, [agentChildScript, heartbeatFile, signalLogFile], {
  encoding: null,
  cols: 80,
  rows: 24,
  cwd: process.env.TMPDIR ?? "/tmp",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR },
});

let outputBytes = 0;
ptyProc.onData((buf) => {
  outputBytes += buf.length;
});

const childPid = ptyProc.pid;

// Read the child's full identity from outside (the same view Reconciliation has).
const identity = parsePs(childPid);

writeFileSync(
  identityFile,
  `${JSON.stringify(
    {
      ready: true,
      childPid,
      childIdentity: identity,
      daemonWorkerPid: process.pid,
      daemonWorkerIdentity: parsePs(process.pid),
      nodePtyVersion,
      encodingNull: true,
      outputBytesObservedAtReady: outputBytes,
    },
    null,
    2,
  )}\n`,
);

// Announce ready on stdout for the orchestrator (optional log).
process.stdout.write(`<daemon-worker ready childPid=${childPid}>\n`);

// Graceful-close control: stdin "EXIT" → exit 0 (master fd closes on exit).
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.trim() === "EXIT") process.exit(0);
});

// If the child exits on its own, record and exit.
ptyProc.onExit(({ exitCode, signal }) => {
  process.stdout.write(`<daemon-worker child exited exitCode=${exitCode} signal=${signal}>\n`);
  process.exit(0);
});

// IMPORTANT: no SIGTERM/SIGINT handler — default semantics terminate this
// process, and the kernel closes the PTY master fd. That is the realistic
// "Daemon crash / launchctl kill" path under test.

function parsePs(pid) {
  // macOS ps: trailing `=` strips the header. lstart is the only multi-token
  // field and sits between sess and tty.
  let raw;
  try {
    raw = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,sess=,lstart=,tty=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch (e) {
    return { pid, error: String(e?.message ?? e) };
  }
  if (!raw) return { pid, error: "ps-empty" };
  const tok = raw.split(/\s+/).filter(Boolean);
  const [p, pp, pg, sess, ...rest] = tok;
  const tty = rest[rest.length - 1];
  const lstart = rest.slice(0, -1).join(" ");
  return { pid: Number(p), ppid: Number(pp), pgid: Number(pg), sess: Number(sess), lstart, tty };
}
