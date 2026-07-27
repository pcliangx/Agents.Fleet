// R0-07 — inert bootstrap behavior (RT-LAUNCH-02/04/06), real child processes.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortPath,
  agentIdentityPath,
  bootstrapExitPath,
  commitPath,
  receiptPath,
} from "./paths.js";
import { parsePs } from "./ps-helpers.js";
import { atomicPublish } from "./shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(here, "children", "bootstrap.mjs");
const AGENT = join(here, "children", "fake-agent.mjs");

const dirs: string[] = [];
const agentPids: number[] = [];

afterEach(() => {
  for (const pid of agentPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "r0-07-bootstrap-"));
  dirs.push(d);
  return d;
};

const waitFor = async (pred: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const readJson = (path: string): Record<string, unknown> | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // O_EXCL makes receipt creation unique, not instantly complete for a
    // concurrent reader. Match SessionRuntime.readReceipt: retry until the
    // writer has finished the durable JSON payload.
    return null;
  }
};

interface SpawnBootstrapOpts {
  readonly nonce?: string;
  readonly dir: string;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
}

const spawnBootstrap = (opts: SpawnBootstrapOpts): number => {
  const child = spawn(
    process.execPath,
    [
      BOOTSTRAP,
      "--nonce",
      opts.nonce ?? "ln-test",
      "--dir",
      opts.dir,
      "--timeout-ms",
      String(opts.timeoutMs ?? 5000),
      "--grace-ms",
      String(opts.graceMs ?? 400),
      "--agent-path",
      AGENT,
      "--argv-hash",
      "hash-1",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
  return child.pid as number;
};

describe("R0-07 inert bootstrap", () => {
  it("RT-LAUNCH-02: writes the durable receipt with full identity before any authorization", async () => {
    const dir = mkDir();
    // Large timeout so the bootstrap stays alive across any vitest worker
    // scheduling jitter while we verify the live identity (#63: a 1200ms
    // timeout raced the parsePs identity check when a busy worker delayed the
    // receipt poll past the bootstrap's self-exit). We abort explicitly
    // afterwards instead of waiting for the timeout — the never-authorized
    // timeout behavior itself is covered by the RT-LAUNCH-06 case below.
    const pid = spawnBootstrap({ dir, timeoutMs: 30_000 });
    expect(await waitFor(() => existsSync(receiptPath(dir, "ln-test")))).toBe(true);
    const receipt = readJson(receiptPath(dir, "ln-test"));
    expect(receipt?.pid).toBe(pid);
    expect(receipt?.pgid).toBe(pid); // own process group leader (detached)
    expect(typeof receipt?.lstart).toBe("string");
    // receipt identity matches the live process (RT-REC-12 full identity)
    const observed = parsePs(pid);
    expect(observed?.lstart).toBe(receipt?.lstart);
    // never authorized → abort explicitly (does not exec); avoids racing the
    // bootstrap timeout exit against the identity check above.
    atomicPublish(abortPath(dir, "ln-test"), JSON.stringify({ nonce: "ln-test" }));
    expect(await waitFor(() => existsSync(bootstrapExitPath(dir, "ln-test")))).toBe(true);
    expect(readJson(bootstrapExitPath(dir, "ln-test"))?.exec).toBe(false);
    expect(existsSync(agentIdentityPath(dir, "ln-test"))).toBe(false);
  });

  it("RT-LAUNCH-06: self-times-out when the Daemon disappears before authorizing", async () => {
    const dir = mkDir();
    // intermediate "daemon" spawns the bootstrap and exits immediately
    const daemon = spawn(
      process.execPath,
      [
        "-e",
        `const{spawn}=require("node:child_process");spawn(process.execPath,${JSON.stringify([
          BOOTSTRAP,
          "--nonce",
          "ln-orphan",
          "--dir",
          dir,
          "--timeout-ms",
          "30000",
          "--grace-ms",
          "300",
          "--agent-path",
          AGENT,
          "--argv-hash",
          "hash-1",
        ])},{stdio:"ignore",detached:true}).unref();`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => daemon.on("exit", r));
    // despite the 30s absolute timeout, the orphan exits within the grace window
    const gone = await waitFor(() => existsSync(bootstrapExitPath(dir, "ln-orphan")), 5000);
    expect(gone).toBe(true);
    const exit = readJson(bootstrapExitPath(dir, "ln-orphan"));
    expect(exit?.reason).toBe("daemon-gone-timeout");
    expect(exit?.exec).toBe(false);
    expect(existsSync(agentIdentityPath(dir, "ln-orphan"))).toBe(false);
  });

  it("RT-LAUNCH-04: accepts exactly one correct CommitLaunch and execs the structured argv", async () => {
    const dir = mkDir();
    spawnBootstrap({ dir, timeoutMs: 5000 });
    expect(await waitFor(() => existsSync(receiptPath(dir, "ln-test")))).toBe(true);
    atomicPublish(
      commitPath(dir, "ln-test"),
      JSON.stringify({ nonce: "ln-test", argvHash: "hash-1" }),
    );
    expect(await waitFor(() => existsSync(agentIdentityPath(dir, "ln-test")))).toBe(true);
    const exit = readJson(bootstrapExitPath(dir, "ln-test"));
    expect(exit?.reason).toBe("committed");
    expect(exit?.exec).toBe(true);
    const agent = readJson(agentIdentityPath(dir, "ln-test"));
    agentPids.push(agent?.pid as number);
    // heartbeat proves the agent is really alive (independent observation)
    const hbPath = `${dir}/agent-ln-test.hb`;
    expect(await waitFor(() => existsSync(hbPath))).toBe(true);
  });

  it("RT-LAUNCH-04: refuses a CommitLaunch bound to a different nonce / argvHash", async () => {
    const dir = mkDir();
    spawnBootstrap({ dir, timeoutMs: 1500 });
    expect(await waitFor(() => existsSync(receiptPath(dir, "ln-test")))).toBe(true);
    atomicPublish(
      commitPath(dir, "ln-test"),
      JSON.stringify({ nonce: "ln-OTHER", argvHash: "hash-1" }),
    );
    expect(await waitFor(() => existsSync(bootstrapExitPath(dir, "ln-test")))).toBe(true);
    const exit = readJson(bootstrapExitPath(dir, "ln-test"));
    expect(exit?.reason).toBe("commit-nonce-mismatch");
    expect(exit?.exec).toBe(false);
    expect(existsSync(agentIdentityPath(dir, "ln-test"))).toBe(false);
  });

  it("RT-LAUNCH-08: takes AbortLaunch and never execs", async () => {
    const dir = mkDir();
    spawnBootstrap({ dir, timeoutMs: 5000 });
    expect(await waitFor(() => existsSync(receiptPath(dir, "ln-test")))).toBe(true);
    atomicPublish(abortPath(dir, "ln-test"), JSON.stringify({ nonce: "ln-test" }));
    expect(await waitFor(() => existsSync(bootstrapExitPath(dir, "ln-test")))).toBe(true);
    const exit = readJson(bootstrapExitPath(dir, "ln-test"));
    expect(exit?.reason).toBe("aborted");
    expect(exit?.exec).toBe(false);
    expect(existsSync(agentIdentityPath(dir, "ln-test"))).toBe(false);
  });

  it("RT-LAUNCH-02: a second bootstrap bearing the same nonce fails on the O_EXCL receipt", async () => {
    const dir = mkDir();
    writeFileSync(receiptPath(dir, "ln-dup"), JSON.stringify({ nonce: "ln-dup", pid: 1 }));
    spawnBootstrap({ dir, nonce: "ln-dup", timeoutMs: 5000 });
    expect(await waitFor(() => existsSync(bootstrapExitPath(dir, "ln-dup")))).toBe(true);
    const exit = readJson(bootstrapExitPath(dir, "ln-dup"));
    expect(String(exit?.reason)).toContain("receipt-conflict");
    // original receipt untouched
    expect(readJson(receiptPath(dir, "ln-dup"))?.pid).toBe(1);
  });
});
