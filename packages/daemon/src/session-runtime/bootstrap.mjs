// R1-05 inert bootstrap (RT-LAUNCH-02..04/06).
//
// This helper never starts the configured Agent until a one-shot CommitLaunch
// file carrying the matching nonce + argv hash is durably visible. It is
// short-lived: after spawning the Agent with inherited PTY descriptors and
// publishing its identity receipt, it exits instead of supervising the
// Session.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const configPath = valueAfter("--config");
if (configPath === null) process.exit(2);

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  process.exit(3);
}

const launchDir = dirname(configPath);
mkdirSync(launchDir, { recursive: true, mode: 0o700 });
const receiptPath = join(launchDir, "bootstrap-receipt.json");
const commitPath = join(launchDir, "commit-launch.json");
const abortPath = join(launchDir, "abort-launch.json");
const execReceiptPath = join(launchDir, "exec-receipt.json");

const fsyncDirectory = (path) => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeExclusiveDurable = (path, value) => {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
};

const processFact = (pid, field) => {
  const result = spawnSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
};

try {
  writeExclusiveDurable(receiptPath, {
    nonce: config.launchNonce,
    argvHash: config.argvHash,
    pid: process.pid,
    pgid: Number(processFact(process.pid, "pgid")),
    lstart: processFact(process.pid, "lstart"),
  });
} catch {
  process.exit(4);
}

const startedAt = Date.now();
const pollMs = 20;
const timer = setInterval(() => {
  if (existsSync(abortPath)) {
    clearInterval(timer);
    process.exit(5);
  }
  if (Date.now() - startedAt >= config.timeoutMs) {
    clearInterval(timer);
    process.exit(6);
  }
  if (!existsSync(commitPath)) return;

  let commit;
  try {
    commit = JSON.parse(readFileSync(commitPath, "utf8"));
  } catch {
    clearInterval(timer);
    process.exit(7);
  }
  if (commit.launchNonce !== config.launchNonce || commit.argvHash !== config.argvHash) {
    clearInterval(timer);
    process.exit(8);
  }

  clearInterval(timer);
  try {
    writeExclusiveDurable(execReceiptPath, {
      nonce: config.launchNonce,
      argvHash: config.argvHash,
      pid: process.pid,
      pgid: Number(processFact(process.pid, "pgid")),
      lstart: processFact(process.pid, "lstart"),
    });
  } catch {
    process.exit(10);
  }
  try {
    process.chdir(config.launchSpec.cwd);
    process.execve(
      config.launchSpec.executablePath,
      [config.launchSpec.executablePath, ...config.launchSpec.argv],
      config.launchSpec.env,
    );
  } catch {
    process.exit(9);
  }
}, pollMs);
