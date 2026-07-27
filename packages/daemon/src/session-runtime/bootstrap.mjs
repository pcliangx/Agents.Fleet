// R1-05 inert bootstrap (RT-LAUNCH-02..04/06).
//
// This helper never starts the configured Agent until a one-shot CommitLaunch
// file carrying the matching nonce + argv hash is durably visible. It is
// short-lived: after spawning the Agent with inherited PTY descriptors and
// publishing its identity receipt, it exits instead of supervising the
// Session.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
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
const execFailurePath = join(launchDir, "exec-failure.json");

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

const readProcessIdentity = (pid) => {
  const result = spawnSync(
    config.processProbePath,
    ["-o", "pgid=,lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      timeout: 500,
    },
  );
  if (result.status !== 0) return null;
  const tokens = result.stdout.trim().split(/\s+/);
  const pgid = Number(tokens[0]);
  const lstart = tokens.slice(1, 6).join(" ");
  return Number.isInteger(pgid) && lstart.length > 0 ? { pgid, lstart } : null;
};

const connectExecBarrier = async ({ host, port, token }) =>
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(token, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve(socket);
      });
    });
  });

let execBarrierSocket;
try {
  execBarrierSocket = await connectExecBarrier(config.execBarrier);
} catch {
  process.exit(11);
}
execBarrierSocket.on("error", () => {});

const observedIdentity = readProcessIdentity(process.pid);
const identityCoverage = observedIdentity?.pgid === process.pid ? "full" : "pid-pgid";
const bootstrapIdentity = {
  pid: process.pid,
  pgid: identityCoverage === "full" ? observedIdentity.pgid : process.pid,
  lstart: identityCoverage === "full" ? observedIdentity.lstart : "",
  identityCoverage,
};

try {
  writeExclusiveDurable(receiptPath, {
    nonce: config.launchNonce,
    argvHash: config.argvHash,
    ...bootstrapIdentity,
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
    accessSync(config.launchSpec.executablePath, constants.X_OK);
  } catch {
    try {
      writeExclusiveDurable(execFailurePath, {
        nonce: config.launchNonce,
        argvHash: config.argvHash,
        code: "entry-not-executable",
      });
    } catch {
      // The authorized outcome remains uncertain if failure evidence cannot be persisted.
    }
    process.exit(9);
  }
  try {
    writeExclusiveDurable(execReceiptPath, {
      nonce: config.launchNonce,
      argvHash: config.argvHash,
      ...bootstrapIdentity,
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
  } catch (error) {
    try {
      writeExclusiveDurable(execFailurePath, {
        nonce: config.launchNonce,
        argvHash: config.argvHash,
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "unknown",
      });
    } catch {
      // The durable exec receipt already means the launch outcome is uncertain.
    }
    process.exit(9);
  }
}, pollMs);

// Keep the close-on-exec socket reachable until process.execve replaces this
// image. The Daemon observes EOF as positive proof that the authorized exec
// boundary was crossed; an exec failure is distinguished by exec-failure.json.
void execBarrierSocket;
