// R0-03 Daemon crash & orphan-process behavior probe.
// Empirically measures, for a node-pty child whose Daemon (PTY master owner)
// dies, what happens to the child: does it survive, get orphaned to pid 1,
// receive SIGHUP, remain re-identifiable by full identity (not PID alone), and
// can a new Daemon stop it by pid / pgid? Feeds RT-REC-07/08/12, RT-LAUNCH-06/07,
// RT-STATE-22/23, RT-T-08/27.
//
// Topology: probe.mjs (orchestrator = "new Daemon after restart") spawns
// daemon-worker.mjs (the "old Daemon" = node-pty owner) which pty.spawn()s
// agent-child.mjs. The orchestrator kills the worker three ways and then
// observes the child from a separate process.
//
// node-pty is loaded by daemon-worker from a temp install OUTSIDE the repo, so
// this file and its siblings stay clear of the packages/apps node-pty guard
// (RT-TERM-08 / SV1-AUTH-09). Only sanitized JSON is written into the repo.
//
// Usage: node probe.mjs <sanitized-out.json> [--env-dir <dir>] [--raw-out <path>]

import { spawn, execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePs } from "./ps-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentChild = join(here, "agent-child.mjs");
const daemonWorker = join(here, "daemon-worker.mjs");

const args = process.argv.slice(2);
const sanitizedOut = args[0];
if (!sanitizedOut) {
  console.error("usage: node probe.mjs <sanitized-out.json> [--env-dir <dir>] [--raw-out <path>]");
  process.exit(2);
}
const envDirIdx = args.indexOf("--env-dir");
const envDirFlag = envDirIdx >= 0 ? args[envDirIdx + 1] : undefined;
const rawOutIdx = args.indexOf("--raw-out");
const rawOut = rawOutIdx >= 0 ? args[rawOutIdx + 1] : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- ensure node-pty installed + executable helper (the npm 11 allow-scripts gap) ---
const installDir = envDirFlag ?? join(tmpdir(), "r0-03-pty-env");
const setup = ensureNodePty(installDir);

// --- helpers ---
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sendSignal = (pidOrNegPgid, sig) => {
  try {
    process.kill(pidOrNegPgid, sig);
    return true;
  } catch {
    return false;
  }
};
function readJsonlTail(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(40);
  }
  return existsSync(file);
}
async function waitForFirstBeat(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readJsonlTail(file).length > 0) return true;
    await sleep(40);
  }
  return readJsonlTail(file).length > 0;
}

const MODES = ["exit-normal", "sigterm", "sigkill"];

async function runMode(mode) {
  const runDir = join(tmpdir(), `r0-03-run-${mode}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const identityFile = join(runDir, "identity.json");
  const heartbeatFile = join(runDir, "heartbeat.jsonl");
  const signalLogFile = join(runDir, "signals.jsonl");

  const worker = spawn(process.execPath, [daemonWorker, installDir, agentChild, identityFile, heartbeatFile, signalLogFile], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? tmpdir() },
  });
  const workerStdout = [];
  worker.stdout.on("data", (c) => workerStdout.push(c.toString()));
  const workerStderr = [];
  worker.stderr.on("data", (c) => workerStderr.push(c.toString()));

  const workerExit = new Promise((res) => worker.on("exit", (code, sig) => res({ code, sig })));

  const identityReady = await waitForFile(identityFile, 8000);
  if (!identityReady) {
    return { mode, error: "identity-timeout", workerStderr: workerStderr.join("").slice(0, 500) };
  }
  const identity = JSON.parse(readFileSync(identityFile, "utf8"));
  const childPid = identity.childPid;
  const childPgid = identity.childIdentity?.pgid ?? childPid;

  const firstBeat = await waitForFirstBeat(heartbeatFile, 5000);
  if (!firstBeat) {
    return { mode, error: "no-heartbeat", childPid, workerStderr: workerStderr.join("").slice(0, 500) };
  }
  await sleep(300); // let a couple beats accumulate
  const beatsBefore = readJsonlTail(heartbeatFile).length;

  // --- trigger the Daemon death ---
  const crashAt = Date.now();
  if (mode === "exit-normal") {
    worker.stdin.write("EXIT\n");
    worker.stdin.end();
  } else if (mode === "sigterm") {
    worker.kill("SIGTERM");
  } else {
    worker.kill("SIGKILL");
  }
  const workerExitInfo = await workerExit;

  // Propagation window: SIGHUP on master close etc.
  await sleep(1000);

  const childPsAfter = parsePs(childPid);
  const survived = isAlive(childPid);
  const orphanedToPid1 = survived && childPsAfter?.ppid === 1;
  const beatsAfter = readJsonlTail(heartbeatFile).length;
  const beatsGainedAfterCrash = Math.max(0, beatsAfter - beatsBefore);
  const heartbeatContinued = beatsGainedAfterCrash >= 2;

  const sigLines = readJsonlTail(signalLogFile);
  const signalsSeen = sigLines.filter((l) => l.event === "SIGNAL").map((l) => l.sig);
  const stdoutErrorSeen = sigLines.some((l) => l.event === "STDOUT_ERROR");

  // --- re-identification by FULL identity (RT-REC-12): pid alone vs pid+lstart ---
  const recordedLstart = identity.childIdentity?.lstart ?? null;
  const reidentifiedByFullIdentity = survived && childPsAfter?.lstart != null && childPsAfter.lstart === recordedLstart;

  // --- stop sequence (if the orphan survived) ---
  const stopSequence = [];
  let finalStopMethod = survived ? null : "already-dead";
  let alive = survived;
  if (alive) {
    for (const [label, sig, target] of [
      ["sigterm-by-pid", "SIGTERM", childPid],
      ["sigterm-by-pgid", "SIGTERM", -childPgid],
      ["sigkill-by-pid", "SIGKILL", childPid],
      ["sigkill-by-pgid", "SIGKILL", -childPgid],
    ]) {
      const sent = sendSignal(target, sig);
      await sleep(600);
      alive = isAlive(childPid);
      stopSequence.push({ label, sig, sent, aliveAfter: alive });
      if (!alive) {
        finalStopMethod = label;
        break;
      }
    }
    if (alive) finalStopMethod = "still-alive";
  }

  return {
    mode,
    crashTrigger: mode,
    workerExit: workerExitInfo,
    childPid,
    childPgid,
    childIdentityBefore: identity.childIdentity,
    daemonWorkerPid: identity.daemonWorkerPid,
    daemonWorkerIdentityBefore: identity.daemonWorkerIdentity,
    childSurvived: survived,
    orphanedToPid1,
    childPsAfter,
    signalsDelivered: signalsSeen,
    stdoutErrorDelivered: stdoutErrorSeen,
    heartbeatContinued,
    beatsGainedAfterCrash,
    recordedLstart,
    reidentifiedByFullIdentity,
    pidAloneWouldMatch: survived, // pid-alone "matches" while alive, but see pidReuseObservation
    stopSequence,
    finalStopMethod,
    workerStdout: workerStdout.join("").slice(0, 300),
  };
}

// --- pid-reuse observation: after a child is confirmed dead, churn processes
// and see whether its old PID gets reused with a DIFFERENT lstart (proving
// pid-alone is unsafe). Done once, against the last mode's dead child. ---
async function observePidReuse(deadChildPid, recordedLstart) {
  if (!deadChildPid || !recordedLstart) return { attempted: false };
  // Spawn a churn of short-lived processes to push pid allocation forward.
  const churn = [];
  for (let i = 0; i < 400; i++) {
    const c = spawn("/usr/bin/true", [], { stdio: "ignore" });
    c.on("error", () => {}); // tolerate transient spawn failures
    churn.push(c);
  }
  await Promise.all(
    churn.map((c) => new Promise((r) => c.on("exit", () => r()).on("error", () => r()))),
  );
  await sleep(100);
  const reused = isAlive(deadChildPid);
  if (!reused) return { attempted: true, churn: churn.length, reused: false };
  const ps = parsePs(deadChildPid);
  return {
    attempted: true,
    churn: churn.length,
    reused: true,
    newLstart: ps?.lstart ?? null,
    recordedLstart,
    lstartDiffers: ps?.lstart !== recordedLstart, // true → pid-alone would misidentify
  };
}

const modeResults = [];
for (const mode of MODES) {
  process.stdout.write(`[probe] mode=${mode} ...\n`);
  const r = await runMode(mode);
  modeResults.push(r);
}

// pid-reuse against the last (sigkill) mode's now-dead child, if we have its pid.
const last = modeResults[modeResults.length - 1];
const pidReuseObservation =
  last && !last.error && last.finalStopMethod !== "still-alive"
    ? await observePidReuse(last.childPid, last.recordedLstart)
    : { attempted: false, reason: "no-dead-child" };

// --- assemble + sanitize ---
const report = {
  probeId: "r0-03-daemon-crash-behavior",
  capturedAt: new Date().toISOString(),
  context: {
    node: process.version,
    execPath: process.execPath,
    platform: `${process.platform}/${process.arch}`,
    uid: process.getuid?.() ?? null,
    swVers: safeExec("/usr/bin/sw_vers"),
    launchctlManager: safeExec("/bin/launchctl", ["managername"]),
  },
  nodePtySetup: setup,
  modes: modeResults,
  pidReuseObservation,
};

const sanitized = sanitize(report);
mkdirSync(dirname(sanitizedOut), { recursive: true });
writeFileSync(sanitizedOut, `${JSON.stringify(sanitized, null, 2)}\n`);
console.log(`sanitized -> ${sanitizedOut}`);

if (rawOut) {
  const allowedPrefix = process.env.TMPDIR ?? "/tmp";
  if (!rawOut.startsWith("/tmp") && !rawOut.startsWith(allowedPrefix)) {
    console.error("raw output must live outside the repo (e.g. $TMPDIR); refusing");
    process.exit(2);
  }
  writeFileSync(rawOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`raw       -> ${rawOut}`);
}

// --- helpers (late) ---
function ensureNodePty(dir) {
  mkdirSync(dir, { recursive: true });
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) {
    execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore", env: { ...process.env } });
  }
  const ptyPj = join(dir, "node_modules", "node-pty", "package.json");
  let installedVia;
  if (!existsSync(ptyPj)) {
    execFileSync("npm", ["install", "node-pty@1.1.0"], { cwd: dir, stdio: "pipe", env: { ...process.env } });
    installedVia = "npm-install-1.1.0";
  } else {
    installedVia = "preexisting";
  }
  const version = JSON.parse(readFileSync(ptyPj, "utf8")).version;
  const helper = join(dir, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  let helperModeBefore = null;
  let helperModeAfter = null;
  let helperChmodApplied = false;
  // MEASURED (not inferred): attempt a pty.spawn BEFORE chmod. A non-executable
  // spawn-helper must fail with posix_spawnp (EACCES); capturing the actual
  // failure here keeps the evidence self-contained rather than inferring it.
  let posixSpawnpFailureBeforeChmod = { attempted: false };
  if (existsSync(helper)) {
    helperModeBefore = modeOctal(helper);
    posixSpawnpFailureBeforeChmod = probeSpawnBeforeChmod(dir);
    chmodSync(helper, 0o755);
    helperModeAfter = modeOctal(helper);
    helperChmodApplied = helperModeBefore !== helperModeAfter;
  }
  return {
    installDir: dir,
    installedVia,
    nodePtyVersion: version,
    prebuiltUsed: existsSync(helper),
    helperPath: existsSync(helper) ? helper : null,
    helperModeBefore,
    helperModeAfter,
    helperChmodApplied,
    posixSpawnpFailureBeforeChmod,
    posixSpawnpFailsWithoutChmod: posixSpawnpFailureBeforeChmod.failed === true,
    note: "node-pty prebuilt spawn-helper ships mode 0644; npm 11 allow-scripts blocks its lifecycle chmod; a pre-chmod pty.spawn is measured to fail with posix_spawnp (EACCES), so the Daemon install must explicitly chmod + verify signature. Out-of-scope discovery for #3, tracked in a separate issue (feeds RT-DIST-01 / SV1-SUPPLY-02).",
  };
}
function probeSpawnBeforeChmod(dir) {
  try {
    const require = createRequire(resolve(dir, "package.json"));
    const pty = require("node-pty");
    const p = pty.spawn("/bin/echo", ["pre-chmod-probe"], { encoding: null });
    // Helper was somehow already executable — clean up the probe child.
    p.onExit(() => {});
    try {
      p.kill();
    } catch {}
    return { attempted: true, failed: false };
  } catch (e) {
    return { attempted: true, failed: true, error: String(e?.message ?? e).slice(0, 200) };
  }
}
function modeOctal(p) {
  return `0o${(statSync(p).mode & 0o777).toString(8).padStart(3, "0")}`;
}
function safeExec(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 }).trim();
  } catch (e) {
    return String(e?.message ?? e).slice(0, 200);
  }
}
function sanitize(obj) {
  // Defense-in-depth: no env/secrets are placed in evidence; strip anything that
  // matches the denylist just in case a future field carries a value.
  // No /g flag — a stateful lastIndex would make .test() non-deterministic across keys.
  const DENYLIST = /TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE|CREDENTIAL|COOKIE/i;
  const seen = new WeakSet();
  const walk = (v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "string" && DENYLIST.test(k)) v[k] = "<redacted>";
        else v[k] = walk(v[k]);
      }
    }
    return v;
  };
  return walk(structuredClone(obj));
}
