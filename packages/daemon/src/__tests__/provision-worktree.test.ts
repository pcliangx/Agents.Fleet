// R0-11 — executable evidence for the Worktree provision no-external-program
// checkout boundary. Covers SV1-FILE-11 / RT-WORKTREE-11 and SV1-T-27:
// every config-declared external program entry point (post-checkout hook,
// smudge / clean / process filter, external diff, textconv, fsmonitor,
// submodule, pager, credential helper) attempts a canary write and a network
// connection; all must stay silent. Repositories that need an external filter
// for a correct checkout get CapabilityUnavailable with no partial Worktree,
// no LaunchIntent and no Agent (this module cannot create either by
// construction).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProvisionGitExec,
  type ProvisionFailure,
  type ProvisionRepository,
  type ProvisionResult,
  WorktreeProvisioner,
} from "../git/provision-worktree.js";
import {
  type GitExec,
  type GitExecRequest,
  readRepositoryCandidateMetadata,
} from "../git/restricted-git.js";

const GIT = "/usr/bin/git";

// --- test-side helpers (plain git, outside the restricted boundary) ---------

// Fixture setup runs OUTSIDE the boundary but must be hermetic: the ambient
// user-global git config may itself declare filters (e.g. git-lfs), which
// would hijack fixture commits. Neutralize it exactly like the boundary does.
const SETUP_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const setupGit = (args: readonly string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8", env: SETUP_ENV }).trim();

const IDENTITY = ["-c", "user.name=r0-11", "-c", "user.email=r0-11@example.invalid"];

const makeRepo = async (dir: string): Promise<{ root: string; head: string }> => {
  mkdirSync(dir, { recursive: true });
  setupGit(["init", "--initial-branch=main"], dir);
  writeFileSync(join(dir, "README.md"), "r0-11 fixture\n");
  writeFileSync(join(dir, "a.txt"), "plain content\n");
  setupGit([...IDENTITY, "add", "."], dir);
  setupGit([...IDENTITY, "commit", "-m", "init"], dir);
  return { root: await realpath(dir), head: setupGit(["rev-parse", "HEAD"], dir) };
};

const commitFile = (repo: string, path: string, content: string): string => {
  writeFileSync(join(repo, path), content);
  setupGit([...IDENTITY, "add", "."], repo);
  setupGit([...IDENTITY, "commit", "-m", `add ${path}`], repo);
  return setupGit(["rev-parse", "HEAD"], repo);
};

const withTempRoot = async <T>(cb: (root: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "af-r011-"));
  const root = await realpath(dir);
  try {
    return await cb(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Records every call, then delegates to the real exec. */
const recordingExec = (calls: GitExecRequest[]): GitExec => {
  return async (req) => {
    calls.push({ argv: [...req.argv], cwd: req.cwd, env: { ...req.env } });
    return await defaultProvisionGitExec(req);
  };
};

const repoOf = async (root: string): Promise<ProvisionRepository> => {
  const c = await readRepositoryCandidateMetadata(root);
  return { workingTreeRoot: c.canonicalRoot, filesystemIdentity: c.filesystemIdentity };
};

const expectFailure = (result: ProvisionResult): ProvisionFailure => {
  if (result.ok) expect.unreachable(`expected provision failure, got ${JSON.stringify(result)}`);
  return result.ok === false ? result.failure : expect.unreachable();
};

const EXPECTED_ENV_KEYS = [
  "PATH",
  "LANG",
  "TMPDIR",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_ATTR_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_PAGER",
  "PAGER",
  "GIT_EDITOR",
  "EDITOR",
].sort();

const REQUIRED_OVERRIDES = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "credential.helper=",
  "submodule.recurse=false",
];

// --- hostile environment (ambient-process half) ------------------------------

const savedEnv: Record<string, string | undefined> = {};
const hostileEnv: Record<string, string> = {
  GIT_DIR: "/nonexistent/evil.git",
  GIT_WORK_TREE: "/nonexistent/evil",
  GIT_EXEC_PATH: "/nonexistent",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/nonexistent/hooks",
  GIT_ATTR_SOURCE: "HEAD",
  SSH_ASKPASS: "/nonexistent/askpass",
};

afterEach(() => {
  for (const k of Object.keys(hostileEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const setHostileEnv = (): void => {
  for (const [k, v] of Object.entries(hostileEnv)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
};

// --- SV1-T-27 hostile fixture ------------------------------------------------

interface HostileFixture {
  readonly sentinel: string;
  readonly networkPort: number;
  readonly connections: string[];
  readonly close: () => Promise<void>;
}

/**
 * A local TCP listener plus canary scripts. Every script appends its name to
 * the sentinel and then attempts a network connection; any single execution
 * of any entry point fails the test twice over.
 */
const startHostileObserver = async (root: string): Promise<HostileFixture> => {
  const connections: string[] = [];
  const server = createServer((socket) => {
    connections.push(`${socket.remoteAddress}:${socket.remotePort}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener address");
  return {
    sentinel: join(root, "executed.log"),
    networkPort: address.port,
    connections,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e === undefined ? resolve() : reject(e))),
      ),
  };
};

const canaryScript = (name: string, sentinel: string, port: number): string =>
  [
    "#!/bin/sh",
    `echo '${name}' >> '${sentinel}'`,
    `/bin/bash -c 'echo pwn > /dev/tcp/127.0.0.1/${port}' 2>/dev/null`,
    "cat",
    "",
  ].join("\n");

const writeScript = (path: string, content: string): void => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

/**
 * The SV1-T-27 fixture: a repo whose config (and an include.path second
 * config) declares every external program entry point, plus an executable
 * file inside the working tree. Config is appended AFTER the fixture commits
 * so no setup command can execute any of it. The filter driver is declared in
 * config only — nothing in the tree carries the attribute — so it is provably
 * inert and provision must SUCCEED with zero executions.
 */
const makeHostileRepo = async (
  root: string,
  observer: HostileFixture,
): Promise<{ root: string; head: string }> => {
  const repo = await makeRepo(join(root, "repo"));
  const hostile = join(root, "hostile");
  mkdirSync(join(hostile, "hooks"), { recursive: true });
  const { sentinel, networkPort } = observer;

  const scripts: Record<string, string> = {
    "fsmonitor.sh": "fsmonitor",
    "pager.sh": "pager",
    "diff.sh": "diff.external",
    "textconv.sh": "textconv",
    "filter.sh": "filter",
    "cred.sh": "credential.helper",
  };
  for (const [file, name] of Object.entries(scripts)) {
    writeScript(join(hostile, file), canaryScript(name, sentinel, networkPort));
  }
  for (const hook of ["post-checkout", "post-merge", "pre-commit"]) {
    writeScript(join(hostile, "hooks", hook), canaryScript(`hook:${hook}`, sentinel, networkPort));
  }

  // A Repository-controlled executable sitting in the working tree: provision
  // must materialize it as data, never run it (SV1-FILE-11).
  const head = commitFile(
    repo.root,
    "build.sh",
    `#!/bin/sh\necho 'build.sh' >> '${sentinel}'\nexit 0\n`,
  );
  chmodSync(join(repo.root, "build.sh"), 0o755);

  const included = join(hostile, "included-config");
  writeFileSync(
    included,
    [
      "[core]",
      `\thooksPath = ${hostile}/hooks`,
      `\tpager = ${hostile}/pager.sh`,
      '[filter "evil"]',
      `\tsmudge = ${hostile}/filter.sh`,
      "",
    ].join("\n"),
  );

  await appendFile(
    join(repo.root, ".git", "config"),
    [
      "",
      "[core]",
      `\thooksPath = ${hostile}/hooks`,
      `\tfsmonitor = ${hostile}/fsmonitor.sh`,
      `\tpager = ${hostile}/pager.sh`,
      "[diff]",
      `\texternal = ${hostile}/diff.sh`,
      '[diff "evil"]',
      `\tcommand = ${hostile}/diff.sh`,
      `\ttextconv = ${hostile}/textconv.sh`,
      '[filter "evil"]',
      `\tclean = ${hostile}/filter.sh`,
      `\tsmudge = ${hostile}/filter.sh`,
      `\tprocess = ${hostile}/filter.sh`,
      "[credential]",
      `\thelper = ${hostile}/cred.sh`,
      "[include]",
      `\tpath = ${included}`,
      "[submodule]",
      "\trecurse = true",
      "",
    ].join("\n"),
  );
  return { root: repo.root, head };
};

// --- tests -------------------------------------------------------------------

describe("WorktreeProvisioner.provisionWorktree (SV1-FILE-11 / RT-WORKTREE-11)", () => {
  it("materializes the managed branch without deleting or reusing an existing branch", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const target = join(root, "wt-managed");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
        branchName: "fleet/managed",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.worktree.branchName).toBe("fleet/managed");
      expect(setupGit(["-C", target, "branch", "--show-current"], root)).toBe("fleet/managed");

      const collision = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: join(root, "wt-collision"),
        branchName: "fleet/managed",
      });
      expect(expectFailure(collision)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "branch-collision",
        leftover: "none",
      });
      expect(existsSync(join(root, "wt-collision"))).toBe(false);
      expect(setupGit(["show-ref", "--verify", "refs/heads/fleet/managed"], repo.root)).toContain(
        repo.head,
      );
    });
  });

  it("materializes a clean repository at the confirmed SHA", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const target = join(root, "wt");
      const neutral = join(root, "neutral");
      mkdirSync(neutral);
      const calls: GitExecRequest[] = [];
      const provisioner = new WorktreeProvisioner({
        exec: recordingExec(calls),
        neutralCwd: neutral,
      });
      const result = await provisioner.provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.worktree.worktreePath).toBe(target);
      expect(result.worktree.headCommitSha).toBe(repo.head);
      expect(result.worktree.materializedBy).toBe("git-worktree-add");
      expect(result.worktree.gitVersion).toMatch(/^git version \d+\.\d+/);
      expect(result.worktree.filesystemIdentity.ino).toBeTypeOf("number");
      // checkout content is the blob content, byte for byte
      expect(execFileSync("/bin/cat", [join(target, "a.txt")], { encoding: "utf8" })).toBe(
        "plain content\n",
      );
      // git itself agrees the worktree is registered and at the SHA
      expect(setupGit(["worktree", "list", "--porcelain"], repo.root)).toContain(target);
      expect(setupGit(["-C", target, "rev-parse", "HEAD"], root)).toBe(repo.head);

      // frozen invocation audit: explicit binary, structured argv, overrides,
      // 12-key env allowlist, no shell metacharacters
      const commands: string[] = [];
      for (const call of calls) {
        expect(call.argv[0]).toBe(GIT);
        expect(call.argv[1]).toBe("--no-pager");
        const joined = call.argv.join(" ");
        for (const override of REQUIRED_OVERRIDES) {
          expect(joined).toContain(`-c ${override}`);
        }
        const cmd = call.argv.find((a) =>
          [
            "--version",
            "ls-tree",
            "check-attr",
            "config",
            "cat-file",
            "worktree",
            "rev-parse",
          ].includes(a),
        );
        expect(cmd, `unexpected command in ${joined}`).toBeDefined();
        commands.push(cmd as string);
        for (const arg of call.argv) expect(arg).not.toMatch(/[|;&`$]/);
        expect(Object.keys(call.env).sort()).toEqual(EXPECTED_ENV_KEYS);
      }
      expect(commands).toEqual([
        "--version",
        "ls-tree",
        "check-attr",
        "worktree",
        "rev-parse",
        "rev-parse",
      ]);
      expect(calls[0]?.cwd).toBe(neutral);
    });
  });

  it("SV1-T-27: executes nothing a fully hostile repository declares", async () => {
    await withTempRoot(async (root) => {
      const observer = await startHostileObserver(root);
      try {
        const repo = await makeHostileRepo(root, observer);
        const target = join(root, "wt");
        const result = await new WorktreeProvisioner().provisionWorktree({
          repository: await repoOf(repo.root),
          baseCommitSha: repo.head,
          targetPath: target,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // zero external program execution, zero network
        expect(existsSync(observer.sentinel)).toBe(false);
        expect(observer.connections).toEqual([]);
        // the in-tree executable was materialized as data, not run
        expect(existsSync(join(target, "build.sh"))).toBe(true);
        expect(existsSync(observer.sentinel)).toBe(false);
      } finally {
        await observer.close();
      }
    });
  });

  it("SV1-T-27: submodule entry — no recursion, no canary execution", async () => {
    await withTempRoot(async (root) => {
      const observer = await startHostileObserver(root);
      try {
        const sub = await makeRepo(join(root, "subsrc"));
        const repo = await makeRepo(join(root, "repo"));
        setupGit(
          [
            ...IDENTITY,
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.root,
            "sub",
          ],
          repo.root,
        );
        setupGit([...IDENTITY, "commit", "-qm", "add submodule"], repo.root);
        const head = setupGit(["rev-parse", "HEAD"], repo.root);
        // Wire the submodule entry point to a canary, like every other entry
        // in this fixture: a custom update command executes whenever git
        // recurses into this submodule, writing the sentinel and attempting
        // a network connection. Config is set after the commit so setup
        // itself cannot execute it. (No trailing `cat` here — that passthrough
        // is only for filter scripts, which receive blob content on stdin.)
        writeScript(
          join(root, "submodule-update.sh"),
          [
            "#!/bin/sh",
            `echo 'submodule-update' >> '${observer.sentinel}'`,
            `/bin/bash -c 'echo pwn > /dev/tcp/127.0.0.1/${observer.networkPort}' 2>/dev/null`,
            "exit 0",
            "",
          ].join("\n"),
        );
        setupGit(
          ["config", "submodule.sub.update", `!${join(root, "submodule-update.sh")}`],
          repo.root,
        );
        setupGit(["config", "submodule.recurse", "true"], repo.root);

        const target = join(root, "wt");
        const result = await new WorktreeProvisioner().provisionWorktree({
          repository: await repoOf(repo.root),
          baseCommitSha: head,
          targetPath: target,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // probed (P10): worktree add does not recurse even with
        // submodule.recurse=true; assert the boundary pins that behavior
        expect(existsSync(join(target, "sub", "a.txt"))).toBe(false);
        // the submodule canary never executed: no sentinel write, no network
        expect(existsSync(observer.sentinel)).toBe(false);
        expect(observer.connections).toEqual([]);
      } finally {
        await observer.close();
      }
    });
  });

  it("never inherits ambient GIT_* environment", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const target = join(root, "wt");
      setHostileEnv();
      const calls: GitExecRequest[] = [];
      const result = await new WorktreeProvisioner({
        exec: recordingExec(calls),
      }).provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.worktree.worktreePath).toBe(target);
      for (const call of calls) {
        for (const [key, hostileValue] of Object.entries(hostileEnv)) {
          expect(call.env[key], `${key} inherited from ambient env`).not.toBe(hostileValue);
        }
      }
    });
  });

  it("fails closed on repository identity drift before any git invocation", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const valid = await repoOf(repo.root);
      const drifted: ProvisionRepository = {
        ...valid,
        filesystemIdentity: {
          dev: valid.filesystemIdentity.dev,
          ino: valid.filesystemIdentity.ino + 1,
        },
      };
      const calls: GitExecRequest[] = [];
      const result = await new WorktreeProvisioner({
        exec: recordingExec(calls),
      }).provisionWorktree({
        repository: drifted,
        baseCommitSha: repo.head,
        targetPath: join(root, "wt"),
      });
      expect(expectFailure(result)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "identity-drift",
        leftover: "none",
      });
      expect(calls).toEqual([]);
    });
  });

  it("refuses an existing target path before any git invocation", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const target = join(root, "wt");
      mkdirSync(target);
      writeFileSync(join(target, "preexisting.txt"), "not ours\n");
      const calls: GitExecRequest[] = [];
      const result = await new WorktreeProvisioner({
        exec: recordingExec(calls),
      }).provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
      });
      expect(expectFailure(result)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "target-exists",
        leftover: "none",
      });
      expect(calls).toEqual([]);
      // the foreign path is untouched (RT-WORKTREE-06)
      expect(
        execFileSync("/bin/cat", [join(target, "preexisting.txt")], { encoding: "utf8" }),
      ).toBe("not ours\n");
    });
  });

  it("rejects a non-SHA baseCommitSha without invoking git", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const calls: GitExecRequest[] = [];
      const result = await new WorktreeProvisioner({
        exec: recordingExec(calls),
      }).provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: "main; rm -rf /",
        targetPath: join(root, "wt"),
      });
      expect(expectFailure(result)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "invalid-request",
        leftover: "none",
      });
      expect(calls).toEqual([]);
    });
  });

  it("reports a well-formed but missing commit with leftover none (RT-WORKTREE-11 Failed input)", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        targetPath: target,
      });
      expect(expectFailure(result)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "git-failed",
        leftover: "none",
      });
      expect(existsSync(target)).toBe(false);
    });
  });

  it("classifies git timeout", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const timeoutExec: GitExec = () => Promise.reject({ killed: true, message: "timeout" });
      const result = await new WorktreeProvisioner({ exec: timeoutExec }).provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: join(root, "wt"),
      });
      expect(expectFailure(result)).toMatchObject({
        kind: "ProvisionFailed",
        reason: "git-timeout",
      });
    });
  });
});

describe("external filter detection (SV1-FILE-11 fail-closed / SV1-T-27)", () => {
  const LFS_POINTER =
    "version https://git-lfs.github.com/spec/v1\n" +
    "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
    "size 12345\n";

  const expectCU = (
    result: ProvisionResult,
  ): Extract<ProvisionFailure, { kind: "CapabilityUnavailable" }> => {
    const failure = expectFailure(result);
    if (failure.kind !== "CapabilityUnavailable") {
      expect.unreachable(`expected CapabilityUnavailable, got ${JSON.stringify(failure)}`);
    }
    return failure as Extract<ProvisionFailure, { kind: "CapabilityUnavailable" }>;
  };

  it("filter attr + configured smudge driver -> CapabilityUnavailable, zero execution, no partial Worktree", async () => {
    await withTempRoot(async (root) => {
      const observer = await startHostileObserver(root);
      try {
        const repo = await makeRepo(join(root, "repo"));
        commitFile(repo.root, ".gitattributes", "*.bin filter=lfs\n");
        const head = commitFile(repo.root, "asset.bin", LFS_POINTER);
        // declared after the commits so setup cannot execute it
        const hostile = join(root, "hostile");
        mkdirSync(hostile, { recursive: true });
        writeScript(
          join(hostile, "lfs.sh"),
          canaryScript("lfs-filter", observer.sentinel, observer.networkPort),
        );
        await appendFile(
          join(repo.root, ".git", "config"),
          `\n[filter "lfs"]\n\tsmudge = ${hostile}/lfs.sh\n\tclean = ${hostile}/lfs.sh\n\tprocess = ${hostile}/lfs.sh\n\trequired = true\n`,
        );

        const target = join(root, "wt");
        const result = await new WorktreeProvisioner().provisionWorktree({
          repository: await repoOf(repo.root),
          baseCommitSha: head,
          targetPath: target,
        });
        const failure = expectCU(result);
        expect(failure.reason).toBe("external-filter-required");
        expect(failure.findings).toHaveLength(1);
        expect(failure.findings[0]).toMatchObject({
          path: "asset.bin",
          driver: "lfs",
          configured: true,
          lfsPointer: true,
        });
        // SV1-T-27: no canary, no network, no partial Worktree registered
        expect(existsSync(observer.sentinel)).toBe(false);
        expect(observer.connections).toEqual([]);
        expect(existsSync(target)).toBe(false);
        expect(setupGit(["worktree", "list", "--porcelain"], repo.root)).not.toContain(target);
      } finally {
        await observer.close();
      }
    });
  });

  it("filter attr + long-running process filter -> CapabilityUnavailable", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      commitFile(repo.root, ".gitattributes", "*.dat filter=proc\n");
      const head = commitFile(repo.root, "data.dat", "payload\n");
      const hostile = join(root, "hostile");
      mkdirSync(hostile, { recursive: true });
      const sentinel = join(root, "executed.log");
      writeScript(
        join(hostile, "proc.sh"),
        `#!/bin/sh\necho 'process-filter' >> '${sentinel}'\ncat\n`,
      );
      await appendFile(
        join(repo.root, ".git", "config"),
        `\n[filter "proc"]\n\tprocess = ${hostile}/proc.sh\n`,
      );
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: head,
        targetPath: target,
      });
      const failure = expectCU(result);
      expect(failure.findings[0]).toMatchObject({
        path: "data.dat",
        driver: "proc",
        configured: true,
      });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  });

  it("filter attr + driver config missing + LFS pointer blob -> CapabilityUnavailable (incomplete checkout)", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      commitFile(repo.root, ".gitattributes", "*.bin filter=lfs\n");
      const head = commitFile(repo.root, "asset.bin", LFS_POINTER);
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: head,
        targetPath: target,
      });
      const failure = expectCU(result);
      expect(failure.reason).toBe("external-filter-required");
      expect(failure.findings[0]).toMatchObject({
        path: "asset.bin",
        driver: "lfs",
        configured: false,
        lfsPointer: true,
      });
      expect(existsSync(target)).toBe(false);
    });
  });

  it("filter attr + driver config missing + plain blob -> CapabilityUnavailable (completeness unprovable)", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      commitFile(repo.root, ".gitattributes", "*.md filter=ghost\n");
      const head = setupGit(["rev-parse", "HEAD"], repo.root);
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: head,
        targetPath: target,
      });
      const failure = expectCU(result);
      expect(failure.findings[0]).toMatchObject({
        path: "README.md",
        driver: "ghost",
        configured: false,
        lfsPointer: false,
      });
      expect(existsSync(target)).toBe(false);
    });
  });

  it("filter attr declared via .git/info/attributes -> CapabilityUnavailable", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      // attributes hidden from the committed tree: only the repo's
      // .git/info/attributes declares the filter (P5b)
      writeFileSync(join(repo.root, ".git", "info", "attributes"), "a.txt filter=evil\n");
      const hostile = join(root, "hostile");
      mkdirSync(hostile, { recursive: true });
      const sentinel = join(root, "executed.log");
      writeScript(join(hostile, "f.sh"), `#!/bin/sh\necho ran >> '${sentinel}'\ncat\n`);
      await appendFile(
        join(repo.root, ".git", "config"),
        `\n[filter "evil"]\n\tsmudge = ${hostile}/f.sh\n`,
      );
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
      });
      const failure = expectCU(result);
      expect(failure.findings[0]).toMatchObject({
        path: "a.txt",
        driver: "evil",
        configured: true,
      });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  });

  it("filter attr declared via core.attributesFile -> CapabilityUnavailable", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const hostile = join(root, "hostile");
      mkdirSync(hostile, { recursive: true });
      const sentinel = join(root, "executed.log");
      writeFileSync(join(hostile, "attrs"), "*.md filter=evil\n");
      writeScript(join(hostile, "f.sh"), `#!/bin/sh\necho ran >> '${sentinel}'\ncat\n`);
      await appendFile(
        join(repo.root, ".git", "config"),
        `\n[core]\n\tattributesFile = ${hostile}/attrs\n[filter "evil"]\n\tsmudge = ${hostile}/f.sh\n`,
      );
      const target = join(root, "wt");
      const result = await new WorktreeProvisioner().provisionWorktree({
        repository: await repoOf(repo.root),
        baseCommitSha: repo.head,
        targetPath: target,
      });
      const failure = expectCU(result);
      expect(failure.findings[0]).toMatchObject({
        path: "README.md",
        driver: "evil",
        configured: true,
      });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  });

  it("filter driver configured but referenced by no in-tree path -> provision succeeds, zero execution", async () => {
    await withTempRoot(async (root) => {
      const observer = await startHostileObserver(root);
      try {
        const repo = await makeRepo(join(root, "repo"));
        // the attribute pattern matches nothing in the tree (S3 precision)
        commitFile(repo.root, ".gitattributes", "*.dat filter=evil\n");
        const head = setupGit(["rev-parse", "HEAD"], repo.root);
        const hostile = join(root, "hostile");
        mkdirSync(hostile, { recursive: true });
        writeScript(
          join(hostile, "f.sh"),
          canaryScript("evil-filter", observer.sentinel, observer.networkPort),
        );
        await appendFile(
          join(repo.root, ".git", "config"),
          `\n[filter "evil"]\n\tsmudge = ${hostile}/f.sh\n\tclean = ${hostile}/f.sh\n`,
        );
        const target = join(root, "wt");
        const result = await new WorktreeProvisioner().provisionWorktree({
          repository: await repoOf(repo.root),
          baseCommitSha: head,
          targetPath: target,
        });
        expect(result.ok).toBe(true);
        expect(existsSync(observer.sentinel)).toBe(false);
        expect(observer.connections).toEqual([]);
      } finally {
        await observer.close();
      }
    });
  });
});
