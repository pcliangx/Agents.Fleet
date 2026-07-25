// R0-07 — inert bootstrap (RT-LAUNCH-02/04/06). Plain node, no deps, no
// node-pty (D8). Short-lived: writes the durable receipt, waits for a
// one-shot CommitLaunch bound to its launchNonce, execs at most once, and
// self-times-out when the Daemon disappears before authorizing.
//
// IPC choice: atomic-rename files in the scenario dir.
// - a FIFO would block the writer until the reader opens it, coupling the
//   coordinator's crash window to the bootstrap's poll loop;
// - a signal cannot carry the nonce, so "correct authorization" could not be
//   verified;
// - write-tmp + rename is crash-atomic on macOS: Reconciliation can tell
//   "CommitLaunch definitely not sent" (file absent) from "delivery unknown"
//   (file present) — exactly the distinction RT-LAUNCH-08 requires.
//
// argv: --nonce N --dir D --timeout-ms T --grace-ms G --agent-path P --argv-hash H
// Exit record is written to <dir>/bootstrap-exit-<nonce>.json before exiting.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { arg, lstartOf } from "./child-util.mjs";

const args = process.argv.slice(2);
const nonce = arg(args, "nonce");
const dir = arg(args, "dir");
const timeoutMs = Number(arg(args, "timeout-ms") ?? "5000");
const graceMs = Number(arg(args, "grace-ms") ?? "400");
const agentPath = arg(args, "agent-path");
const argvHash = arg(args, "argv-hash");
if (!nonce || !dir || !agentPath || !argvHash) {
  console.error("bootstrap: missing required args");
  process.exit(2);
}

const receiptPath = `${dir}/receipt-${nonce}.json`;
const commitPath = `${dir}/commit-${nonce}.json`;
const abortPath = `${dir}/abort-${nonce}.json`;
const exitPath = `${dir}/bootstrap-exit-${nonce}.json`;

const writeExitRecord = (record) => {
  try {
    writeFileSync(exitPath, JSON.stringify({ nonce, pid: process.pid, ...record }));
  } catch {
    // best effort — the receipt is the durable fact, this is evidence.
  }
};

// RT-LAUNCH-02 — atomically write the durable receipt BEFORE waiting for any
// authorization. O_CREAT|O_EXCL: a second bootstrap bearing the same nonce
// fails loudly instead of overwriting the first one's identity.
const receipt = JSON.stringify({
  nonce,
  pid: process.pid,
  pgid: process.pid, // spawned detached by the coordinator: own process group
  ppid: process.ppid,
  lstart: lstartOf(process.pid),
  argvHash,
  writtenAt: new Date().toISOString(),
});
let fd;
try {
  fd = openSync(receiptPath, "wx");
} catch (err) {
  writeExitRecord({ exitCode: 6, reason: `receipt-conflict:${err.code}` });
  process.exit(6);
}
writeSync(fd, receipt);
closeSync(fd);

const POLL_MS = 25;
const startedAt = Date.now();
let parentDeadAt = null;

const timer = setInterval(() => {
  // RT-LAUNCH-03 — one-shot CommitLaunch bound to this nonce.
  if (existsSync(commitPath)) {
    clearInterval(timer);
    let commit;
    try {
      commit = JSON.parse(readFileSync(commitPath, "utf8"));
    } catch {
      writeExitRecord({ exitCode: 7, reason: "commit-unparseable", exec: false });
      process.exit(7);
    }
    // RT-LAUNCH-04 — accept at most one CORRECT authorization.
    if (commit.nonce !== nonce || commit.argvHash !== argvHash) {
      writeExitRecord({ exitCode: 8, reason: "commit-nonce-mismatch", exec: false });
      process.exit(8);
    }
    // Authorized exactly once: exec the structured argv (no shell). The
    // bootstrap exits right after spawn; the detached agent carries on and
    // writes its own identity file (observed by the Daemon per RT-LAUNCH-04).
    const child = spawn(
      process.execPath,
      [agentPath, "--nonce", nonce, "--dir", dir, "--argv-hash", argvHash],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    writeExitRecord({ exitCode: 0, reason: "committed", exec: true, agentPid: child.pid });
    process.exit(0);
  }

  // RT-LAUNCH-08 — explicit AbortLaunch.
  if (existsSync(abortPath)) {
    clearInterval(timer);
    writeExitRecord({ exitCode: 4, reason: "aborted", exec: false });
    process.exit(4);
  }

  // RT-LAUNCH-06 — Daemon disappeared (reparented to launchd) and no
  // authorization arrived within the grace window: exit, never exec.
  if (parentDeadAt === null && process.ppid === 1) parentDeadAt = Date.now();
  const totalElapsed = Date.now() - startedAt;
  const graceElapsed = parentDeadAt === null ? 0 : Date.now() - parentDeadAt;
  if (totalElapsed > timeoutMs || graceElapsed > graceMs) {
    clearInterval(timer);
    writeExitRecord({
      exitCode: 5,
      reason: parentDeadAt === null ? "timeout" : "daemon-gone-timeout",
      exec: false,
    });
    process.exit(5);
  }
}, POLL_MS);
