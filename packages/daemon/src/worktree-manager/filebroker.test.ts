// SV1-T-02 / SV1-T-17 / SV1-T-26 — FileBroker 拒绝与竞态 fixture。
//
// 竞态测试用独立攻击者进程高频替换 symlink / root 目录（OS 级真并发，
// 不受 Node 单线程交错限制），统计落点：一次读到攻击者内容即失败。

import { type ChildProcess, fork } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBroker, FileBrokerError, type RegisteredRoot, type RootKind } from "./filebroker.js";

let base: string;
let broker: FileBroker;
const attackers: ChildProcess[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "r011-filebroker-"));
  broker = new FileBroker();
});

afterEach(async () => {
  for (const a of attackers.splice(0)) {
    if (a.exitCode === null && a.signalCode === null) {
      const exited = new Promise((resolve) => a.once("exit", resolve));
      a.kill();
      // wait for the attacker to actually die before removing the tree it
      // keeps swapping, else rmSync races it into ENOTEMPTY
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setupRoot = (name: string): { dir: string; root: RegisteredRoot } => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.txt"), `${name}-content`);
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "nested.txt"), `${name}-nested`);
  return { dir, root: broker.registerRoot("repository", dir) };
};

const expectBrokerError = (fn: () => unknown, reason: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FileBrokerError);
    expect((e as FileBrokerError).reason).toBe(reason);
    return;
  }
  expect.unreachable(`expected FileBrokerError ${reason}`);
};

describe("happy path", () => {
  it("reads a top-level file relative to the declared root", () => {
    const { root } = setupRoot("repo");
    expect(broker.readFile(root.id, "file.txt").toString("utf8")).toBe("repo-content");
  });

  it("reads a nested file and restores cwd afterwards", () => {
    const { root } = setupRoot("repo");
    const cwd = process.cwd();
    expect(broker.readFile(root.id, "sub/nested.txt").toString("utf8")).toBe("repo-nested");
    expect(process.cwd()).toBe(cwd);
  });

  it("writes a new file with 0600 and re-reads it", () => {
    const { root } = setupRoot("repo");
    broker.writeFile(root.id, "sub/new.txt", "fresh");
    expect(broker.readFile(root.id, "sub/new.txt").toString("utf8")).toBe("fresh");
    expect(lstatSync(join(realpathSync(base), "repo", "sub", "new.txt")).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing file only when identity matches", () => {
    const { root } = setupRoot("repo");
    broker.writeFile(root.id, "file.txt", "updated");
    expect(broker.readFile(root.id, "file.txt").toString("utf8")).toBe("updated");
  });
});

// SV1-T-02 — symlink 替换、`..`、绝对路径、NUL 均失败。
describe("SV1-T-02 path rejection", () => {
  it("rejects absolute paths", () => {
    const { root, dir } = setupRoot("repo");
    expectBrokerError(() => broker.readFile(root.id, join(dir, "file.txt")), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, "/etc/passwd"), "invalid-path");
  });

  it("rejects .. segments, including ones that stay inside the root", () => {
    const { root } = setupRoot("repo");
    expectBrokerError(() => broker.readFile(root.id, "../repo/file.txt"), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, "sub/../file.txt"), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, ".."), "invalid-path");
  });

  it("rejects NUL bytes and empty/dot segments", () => {
    const { root } = setupRoot("repo");
    expectBrokerError(() => broker.readFile(root.id, "file.txt\u0000"), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, ""), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, "./file.txt"), "invalid-path");
    expectBrokerError(() => broker.readFile(root.id, "sub//nested.txt"), "invalid-path");
  });

  it("rejects a symlink leaf even when it points inside the root", () => {
    const { root, dir } = setupRoot("repo");
    symlinkSync(join(dir, "file.txt"), join(dir, "alias.txt"));
    expectBrokerError(() => broker.readFile(root.id, "alias.txt"), "symlink-rejected");
  });

  it("rejects a symlink escape pointing outside the root", () => {
    const { root, dir } = setupRoot("repo");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
    symlinkSync(outside, join(dir, "escape"));
    expectBrokerError(() => broker.readFile(root.id, "escape/secret.txt"), "symlink-rejected");
    symlinkSync(join(outside, "secret.txt"), join(dir, "leaf-escape"));
    expectBrokerError(() => broker.readFile(root.id, "leaf-escape"), "symlink-rejected");
  });

  it("rejects a symlink swapped in for the registered root itself", () => {
    const { root, dir } = setupRoot("repo");
    const moved = join(base, "repo-moved");
    rmSync(moved, { recursive: true, force: true });
    // canonicalRoot 是 realpath 后的路径；在其父目录里替换为 symlink。
    const canonical = root.canonicalRoot;
    expect(canonical).toBe(realpathSync(dir));
    renameSync(canonical, moved);
    symlinkSync(moved, canonical);
    expectBrokerError(() => broker.readFile(root.id, "file.txt"), "identity-drift");
  });

  it("fails closed when the root is replaced by another directory (identity drift)", () => {
    const { root } = setupRoot("repo");
    const canonical = root.canonicalRoot;
    const attackerDir = join(base, "attacker-root");
    mkdirSync(attackerDir);
    writeFileSync(join(attackerDir, "file.txt"), "ATTACKER");
    renameSync(canonical, join(base, "repo-moved"));
    renameSync(attackerDir, canonical);
    expectBrokerError(() => broker.readFile(root.id, "file.txt"), "identity-drift");
  });
});

// SV1-T-26 — 四类 root 各自的 absolute/`..`/symlink/identity fixture +
// 跨 root handle 复用拒绝。
describe("SV1-T-26 per-root-kind fixtures", () => {
  const kinds: readonly RootKind[] = ["repository", "worktree", "app-data", "common-git-dir"];

  for (const kind of kinds) {
    it(`${kind}: absolute/.. /symlink/identity-replacement all fail`, () => {
      const dir = join(base, kind);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "f.txt"), kind);
      const root = broker.registerRoot(kind, dir);
      expect(root.kind).toBe(kind);
      expect(broker.readFile(root.id, "f.txt").toString("utf8")).toBe(kind);
      expectBrokerError(() => broker.readFile(root.id, join(dir, "f.txt")), "invalid-path");
      expectBrokerError(() => broker.readFile(root.id, `../${kind}/f.txt`), "invalid-path");
      symlinkSync(join(dir, "f.txt"), join(dir, "link.txt"));
      expectBrokerError(() => broker.readFile(root.id, "link.txt"), "symlink-rejected");
      const replacement = join(base, `${kind}-replacement`);
      mkdirSync(replacement);
      writeFileSync(join(replacement, "f.txt"), "REPLACED");
      renameSync(root.canonicalRoot, join(base, `${kind}-moved`));
      renameSync(replacement, root.canonicalRoot);
      expectBrokerError(() => broker.readFile(root.id, "f.txt"), "identity-drift");
    });
  }

  it("rejects unknown / forged root ids (cross-root handle reuse)", () => {
    setupRoot("repo-a");
    expectBrokerError(() => broker.readFile("root-999", "file.txt"), "unknown-root");
    expectBrokerError(() => broker.readFile("repo-a", "file.txt"), "unknown-root");
  });

  it("resolves strictly inside the declared root — sibling root content unreachable", () => {
    const a = setupRoot("repo-a");
    setupRoot("repo-b");
    // 路径存在于 B 但 A 没有：对 A 声明的解析必须 not-found，不能借道。
    expectBrokerError(() => broker.readFile(a.root.id, "only-in-b.txt"), "not-found");
    writeFileSync(join(realpathSync(base), "repo-b", "only-in-b.txt"), "B");
    expectBrokerError(() => broker.readFile(a.root.id, "only-in-b.txt"), "not-found");
  });
});

// SV1-T-17 — 检查与 open 的每个边界并发替换 symlink / root identity。
describe("SV1-T-17 race fixtures", () => {
  const ITERATIONS = 2000;

  it("symlink swap race: never lands on the attacker path", { timeout: 60_000 }, () => {
    const { root, dir } = setupRoot("repo");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "nested.txt"), "OUTSIDE-SECRET");
    const attacker = fork(
      fileURLToPath(new URL("./race-attacker.mjs", import.meta.url)),
      [join(dir, "sub"), join(dir, "sub-real"), outside],
      { stdio: "ignore" },
    );
    attackers.push(attacker);

    const stats = {
      ok: 0,
      notFound: 0,
      symlinkRejected: 0,
      raceLost: 0,
      identityDrift: 0,
      escapes: 0,
    };
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const content = broker.readFile(root.id, "sub/nested.txt").toString("utf8");
        if (content === "OUTSIDE-SECRET") stats.escapes++;
        else if (content === "repo-nested") stats.ok++;
        else stats.escapes++; // 任何非预期内容都算逃逸
      } catch (e) {
        const reason = e instanceof FileBrokerError ? e.reason : "other";
        if (reason === "not-found") stats.notFound++;
        else if (reason === "symlink-rejected") stats.symlinkRejected++;
        else if (reason === "race-lost") stats.raceLost++;
        else if (reason === "identity-drift") stats.identityDrift++;
        else throw e;
      }
    }
    console.log("symlink-swap race stats:", { ITERATIONS, ...stats });
    expect(stats.escapes).toBe(0);
    expect(stats.ok + stats.notFound + stats.symlinkRejected + stats.raceLost).toBe(ITERATIONS);
  });

  it("root replacement race: operate on the original identity or fail closed", {
    timeout: 60_000,
  }, () => {
    const { root, dir } = setupRoot("repo");
    const attackerRoot = join(base, "attacker-root");
    mkdirSync(attackerRoot);
    writeFileSync(join(attackerRoot, "file.txt"), "ATTACKER-ROOT-CONTENT");
    const attacker = fork(
      fileURLToPath(new URL("./race-root-attacker.mjs", import.meta.url)),
      [dir, join(base, "repo-real"), attackerRoot],
      { stdio: "ignore" },
    );
    attackers.push(attacker);

    const stats = { ok: 0, identityDrift: 0, raceLost: 0, notFound: 0, escapes: 0 };
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const content = broker.readFile(root.id, "file.txt").toString("utf8");
        if (content === "ATTACKER-ROOT-CONTENT") stats.escapes++;
        else if (content === "repo-content") stats.ok++;
        else stats.escapes++;
      } catch (e) {
        const reason = e instanceof FileBrokerError ? e.reason : "other";
        if (reason === "identity-drift") stats.identityDrift++;
        else if (reason === "race-lost") stats.raceLost++;
        else if (reason === "not-found") stats.notFound++;
        else throw e;
      }
    }
    console.log("root-replacement race stats:", { ITERATIONS, ...stats });
    expect(stats.escapes).toBe(0);
    expect(stats.ok + stats.identityDrift + stats.raceLost + stats.notFound).toBe(ITERATIONS);
    // 竞态必须真实发生：攻击者至少赢过一些回合（否则 fixture 无效）。
    expect(stats.identityDrift + stats.raceLost + stats.notFound).toBeGreaterThan(0);
  });
});
