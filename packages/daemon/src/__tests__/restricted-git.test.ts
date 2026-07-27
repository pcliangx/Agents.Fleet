// R0-05 — executable evidence for the Repository Trust no-execution boundary.
// Covers RT-REPO-02 / SV1-FILE-06 (restricted Git validation), RT-ENV-01 /
// SV1-TRUST-04 (no execution before / outside the plan), SV1-T-01 and the
// Git half of RT-T-29 / RT-T-36.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultGitExec,
  type GitExec,
  type GitExecRequest,
  MAX_ENUMERATED_REFS,
  type RepositoryCandidate,
  type RepositoryValidationFailure,
  type RepositoryValidationResult,
  RestrictedGitRunner,
  readRepositoryCandidateMetadata,
} from "../git/restricted-git.js";

const GIT = "/usr/bin/git";

// --- test-side helpers (plain git, outside the restricted boundary) ---------

const setupGit = (args: readonly string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();

const IDENTITY = ["-c", "user.name=r0-05", "-c", "user.email=r0-05@example.invalid"];

const makeRepo = async (dir: string): Promise<{ root: string; head: string }> => {
  mkdirSync(dir, { recursive: true });
  setupGit(["init", "--initial-branch=main"], dir);
  writeFileSync(join(dir, "README.md"), "r0-05 fixture\n");
  setupGit([...IDENTITY, "add", "README.md"], dir);
  setupGit([...IDENTITY, "commit", "-m", "init"], dir);
  return { root: await realpath(dir), head: setupGit(["rev-parse", "HEAD"], dir) };
};

const withTempRoot = async <T>(cb: (root: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "af-r005-"));
  const root = await realpath(dir);
  try {
    return await cb(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Records every call, then delegates to the runner's real exec. */
const recordingExec = (calls: GitExecRequest[]): GitExec => {
  return async (req) => {
    calls.push({ argv: [...req.argv], cwd: req.cwd, env: { ...req.env } });
    return await defaultGitExec(req);
  };
};

const candidateOf = async (root: string): Promise<RepositoryCandidate> =>
  await readRepositoryCandidateMetadata(root);

const expectFailure = (result: RepositoryValidationResult): RepositoryValidationFailure => {
  if (result.ok) expect.unreachable(`expected validation failure, got ${JSON.stringify(result)}`);
  return result.ok === false ? result.failure : expect.unreachable();
};

const EXPECTED_ENV_KEYS = [
  "PATH",
  "LANG",
  "TMPDIR",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GIT_PAGER",
  "PAGER",
  "GIT_EDITOR",
  "EDITOR",
].sort();

// --- environment scrubbing ---------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};
const hostileEnv: Record<string, string> = {
  GIT_DIR: "/nonexistent/evil.git",
  GIT_WORK_TREE: "/nonexistent/evil",
  GIT_EXEC_PATH: "/nonexistent",
  GIT_PAGER: "/bin/sh -c 'echo pwned >> /tmp/r005-pwned' #",
  PAGER: "/bin/sh -c 'echo pwned >> /tmp/r005-pwned' #",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/nonexistent/hooks",
  GIT_SSH_COMMAND: "/nonexistent/ssh",
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

// --- tests -------------------------------------------------------------------

describe("readRepositoryCandidateMetadata (pre-Trust, RT-REPO-01 / RT-ENV-01)", () => {
  it("returns canonical path + filesystem identity for a directory", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const c = await candidateOf(repo.root);
      expect(c.canonicalRoot).toBe(repo.root);
      expect(c.filesystemIdentity.dev).toBeTypeOf("number");
      expect(c.filesystemIdentity.ino).toBeTypeOf("number");
    });
  });

  it("canonicalizes symlinked paths without touching the repository", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const link = join(root, "link");
      execFileSync("/bin/ln", ["-s", repo.root, link]);
      const c = await candidateOf(link);
      expect(c.canonicalRoot).toBe(repo.root);
    });
  });

  it("rejects non-directories", async () => {
    await withTempRoot(async (root) => {
      const file = join(root, "file");
      writeFileSync(file, "x");
      await expect(candidateOf(file)).rejects.toThrow(/not a directory/);
    });
  });
});

describe("RestrictedGitRunner.validateRepository (RT-REPO-02)", () => {
  it("validates a normal repository and reports branch + HEAD", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.workingTreeRoot).toBe(repo.root);
      expect(result.repository.headCommitSha).toBe(repo.head);
      expect(result.repository.currentBranch).toBe("main");
      expect(result.repository.gitDir).toBe(join(repo.root, ".git"));
      expect(result.repository.commonGitDir).toBe(join(repo.root, ".git"));
      // the common Repository identity is path AND dev/ino (SV1-FILE-10)
      expect(result.repository.commonGitDirIdentity.dev).toBeTypeOf("number");
      expect(result.repository.commonGitDirIdentity.ino).toBeTypeOf("number");
      // RT-REPO-04 — every ref resolved to a SHA
      expect(result.repository.refs).toContainEqual({ name: "refs/heads/main", sha: repo.head });
      expect(result.repository.refsTruncated).toBe(false);
      // no clone-recorded origin/HEAD — never guessed (RT-REPO-04)
      expect(result.repository.defaultBaseRef).toBeNull();
      expect(result.repository.defaultBaseRefSha).toBeNull();
      expect(result.repository.gitVersion).toMatch(/^git version \d+\.\d+/);
    });
  });

  it("imports a detached HEAD with currentBranch null (RT-REPO-04)", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      setupGit(["checkout", "--detach", repo.head], repo.root);
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.currentBranch).toBeNull();
      expect(result.repository.headCommitSha).toBe(repo.head);
    });
  });

  it("reports the clone-recorded origin/HEAD as defaultBaseRef (RT-REPO-04)", async () => {
    await withTempRoot(async (root) => {
      const origin = await makeRepo(join(root, "origin"));
      const dest = join(root, "cloned");
      setupGit(["clone", origin.root, dest], root);
      const clonedRoot = await realpath(dest);
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(clonedRoot),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.currentBranch).toBe("main");
      expect(result.repository.defaultBaseRef).toBe("refs/remotes/origin/main");
      expect(result.repository.defaultBaseRefSha).toBe(origin.head);
    });
  });

  it("rejects a bare repository as UnsupportedRepository/bare", async () => {
    await withTempRoot(async (root) => {
      const dir = join(root, "bare.git");
      mkdirSync(dir);
      setupGit(["init", "--bare"], dir);
      const result = await new RestrictedGitRunner().validateRepository(await candidateOf(dir));
      expect(expectFailure(result)).toMatchObject({
        kind: "UnsupportedRepository",
        reason: "bare",
      });
    });
  });

  it("rejects an unborn HEAD as UnsupportedRepository/unborn-head", async () => {
    await withTempRoot(async (root) => {
      const dir = join(root, "unborn");
      mkdirSync(dir);
      setupGit(["init", "--initial-branch=main"], dir);
      const result = await new RestrictedGitRunner().validateRepository(await candidateOf(dir));
      expect(expectFailure(result)).toMatchObject({
        kind: "UnsupportedRepository",
        reason: "unborn-head",
      });
    });
  });

  it("classifies an unborn HEAD target as unborn even when other refs exist", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      // HEAD -> a branch that has no commit, while refs/heads/main exists.
      setupGit(["symbolic-ref", "HEAD", "refs/heads/nonexistent"], repo.root);
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({
        kind: "UnsupportedRepository",
        reason: "unborn-head",
      });
    });
  });

  it("rejects a plain directory that is not inside any repository", async () => {
    await withTempRoot(async (root) => {
      const plain = join(root, "plain");
      mkdirSync(plain);
      const result = await new RestrictedGitRunner().validateRepository(await candidateOf(plain));
      expect(expectFailure(result)).toMatchObject({
        kind: "RepositoryInvalid",
        reason: "not-a-repository",
      });
    });
  });

  it("rejects a subdirectory of a repository as root-mismatch", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const sub = join(repo.root, "src");
      mkdirSync(sub);
      const result = await new RestrictedGitRunner().validateRepository(await candidateOf(sub));
      expect(expectFailure(result)).toMatchObject({
        kind: "UnsupportedRepository",
        reason: "root-mismatch",
      });
    });
  });

  it("validates a linked worktree and resolves the common repository identity", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "main"));
      const wt = join(root, "linked");
      setupGit(["worktree", "add", "-b", "linked-branch", wt], repo.root);
      const wtRoot = await realpath(wt);
      const result = await new RestrictedGitRunner().validateRepository(await candidateOf(wtRoot));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.workingTreeRoot).toBe(wtRoot);
      expect(result.repository.currentBranch).toBe("linked-branch");
      expect(result.repository.commonGitDir).toBe(join(repo.root, ".git"));
      expect(result.repository.gitDir).toContain(join(repo.root, ".git", "worktrees"));
    });
  });

  it("fails closed on filesystem identity drift before invoking git", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const candidate = await candidateOf(repo.root);
      const drifted: RepositoryCandidate = {
        canonicalRoot: candidate.canonicalRoot,
        filesystemIdentity: {
          dev: candidate.filesystemIdentity.dev,
          ino: candidate.filesystemIdentity.ino + 1,
        },
      };
      const calls: GitExecRequest[] = [];
      const result = await new RestrictedGitRunner({
        exec: recordingExec(calls),
      }).validateRepository(drifted);
      expect(expectFailure(result)).toMatchObject({
        kind: "RepositoryInvalid",
        reason: "identity-drift",
      });
      expect(calls).toEqual([]); // no Git CLI on drift (RT-REPO-06)
    });
  });

  it("classifies git timeout", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const candidate = await candidateOf(repo.root);
      const timeoutExec: GitExec = () => Promise.reject({ killed: true, message: "timeout" });
      const result = await new RestrictedGitRunner({ exec: timeoutExec }).validateRepository(
        candidate,
      );
      expect(expectFailure(result)).toMatchObject({
        kind: "RepositoryInvalid",
        reason: "git-timeout",
      });
    });
  });
});

describe("corrupt repository classification (RT-REPO-02 / RT-T-36)", () => {
  it("bad .git/config is corrupt, not git-failed", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      await appendFile(join(repo.root, ".git", "config"), "[core\nbroken\n");
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({ kind: "RepositoryInvalid", reason: "corrupt" });
    });
  });

  it("a HEAD ref pointing to a missing object is corrupt, not unborn", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      writeFileSync(
        join(repo.root, ".git", "refs", "heads", "main"),
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
      );
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({ kind: "RepositoryInvalid", reason: "corrupt" });
    });
  });

  it("a detached HEAD pointing to a missing object is corrupt", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      writeFileSync(join(repo.root, ".git", "HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({ kind: "RepositoryInvalid", reason: "corrupt" });
    });
  });

  it("a symbolic HEAD outside refs/heads is corrupt, not a branch name", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      setupGit(["tag", "v1"], repo.root);
      setupGit(["symbolic-ref", "HEAD", "refs/tags/v1"], repo.root);
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({ kind: "RepositoryInvalid", reason: "corrupt" });
    });
  });

  it("garbage HEAD content makes git itself refuse the directory", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      writeFileSync(join(repo.root, ".git", "HEAD"), "total garbage not a ref\n");
      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(expectFailure(result)).toMatchObject({
        kind: "RepositoryInvalid",
        reason: "not-a-repository",
      });
    });
  });
});

describe("ref enumeration (RT-REPO-04, bounded per RT-LIMIT-02)", () => {
  // Canned responses for the whole frozen plan; only the for-each-ref output
  // varies per test. Identity checks still run against the real fixture repo.
  const stubExec = (root: string, refsStdout: string): GitExec => {
    return async ({ argv }) => {
      const cmd = argv.join(" ");
      if (cmd.includes("--version")) return { stdout: "git version 2.50.1\n", stderr: "" };
      if (cmd.includes("--is-bare-repository")) return { stdout: "false\n", stderr: "" };
      if (cmd.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "" };
      if (cmd.includes("--absolute-git-dir")) return { stdout: `${root}/.git\n`, stderr: "" };
      if (cmd.includes("--git-common-dir")) return { stdout: `${root}/.git\n`, stderr: "" };
      if (cmd.includes("symbolic-ref -q HEAD")) return { stdout: "refs/heads/main\n", stderr: "" };
      if (cmd.includes("HEAD^{commit}")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (cmd.includes("for-each-ref")) return { stdout: refsStdout, stderr: "" };
      if (cmd.includes("origin/HEAD")) {
        // mirrors execFile's exit-code error shape (allowExitCodes: [1])
        return Promise.reject({ code: 1, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected argv: ${cmd}`);
    };
  };

  it("truncates a ref list beyond MAX_ENUMERATED_REFS with an explicit marker", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const manyRefs = Array.from(
        { length: MAX_ENUMERATED_REFS + 1 },
        (_, i) => `refs/heads/b${i} ${"b".repeat(40)}`,
      ).join("\n");
      const result = await new RestrictedGitRunner({
        exec: stubExec(repo.root, `${manyRefs}\n`),
      }).validateRepository(await candidateOf(repo.root));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.refs).toHaveLength(MAX_ENUMERATED_REFS);
      expect(result.repository.refsTruncated).toBe(true);
    });
  });

  it("a malformed for-each-ref line is output-unparseable", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const result = await new RestrictedGitRunner({
        exec: stubExec(repo.root, `refs/heads/main ${"a".repeat(40)}\ntotal garbage\n`),
      }).validateRepository(await candidateOf(repo.root));
      expect(expectFailure(result)).toMatchObject({
        kind: "RepositoryInvalid",
        reason: "output-unparseable",
      });
    });
  });
});

describe("no-execution boundary (SV1-FILE-06 / RT-T-29 / RT-T-36)", () => {
  it("runs only the frozen plan: explicit binary, structured argv, scrubbed env", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const neutral = join(root, "neutral");
      mkdirSync(neutral);
      const calls: GitExecRequest[] = [];
      const runner = new RestrictedGitRunner({ exec: recordingExec(calls), neutralCwd: neutral });
      const result = await runner.validateRepository(await candidateOf(repo.root));
      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(0);

      const commands: string[] = [];
      for (const call of calls) {
        expect(call.argv[0]).toBe(GIT); // explicit binary, never PATH-resolved
        expect(call.argv[1]).toBe("--no-pager");
        const cmd = call.argv.find(
          (a) =>
            a === "--version" || a === "rev-parse" || a === "symbolic-ref" || a === "for-each-ref",
        );
        expect(cmd, `unexpected command in ${call.argv.join(" ")}`).toBeDefined();
        commands.push(cmd as string);
        // no shell anywhere: argv is an array, no string concatenation
        for (const arg of call.argv) expect(arg).not.toMatch(/[|;&`$]/);
        expect(Object.keys(call.env).sort()).toEqual(EXPECTED_ENV_KEYS);
      }
      // the frozen plan and nothing else (normal repo: no discriminator, no
      // origin/HEAD resolution)
      expect(commands).toEqual([
        "--version",
        "rev-parse",
        "rev-parse",
        "rev-parse",
        "rev-parse",
        "symbolic-ref",
        "rev-parse",
        "for-each-ref",
        "symbolic-ref",
      ]);
      // version probe runs from the app-owned neutral cwd, not the repository
      expect(calls[0]?.cwd).toBe(neutral);
      for (const call of calls.slice(1)) expect(call.cwd).toBe(repo.root);
    });
  });

  it("never inherits ambient GIT_* / pager / ssh environment", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      setHostileEnv();
      const calls: GitExecRequest[] = [];
      const result = await new RestrictedGitRunner({
        exec: recordingExec(calls),
      }).validateRepository(await candidateOf(repo.root));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // GIT_DIR pointing elsewhere must not redirect discovery
      expect(result.repository.workingTreeRoot).toBe(repo.root);
      for (const call of calls) {
        for (const [key, hostileValue] of Object.entries(hostileEnv)) {
          // either absent entirely, or replaced by our own safe value
          expect(call.env[key], `${key} inherited from ambient env`).not.toBe(hostileValue);
        }
      }
    });
  });

  it("never sources shell init files (RT-T-29 shell rc fixture)", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const hostileHome = join(root, "home");
      mkdirSync(hostileHome);
      const sentinel = join(root, "rc-executed.log");
      for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
        writeFileSync(join(hostileHome, rc), `echo '${rc}' >> '${sentinel}'\n`);
      }
      const savedHome = process.env.HOME;
      process.env.HOME = hostileHome;
      try {
        const calls: GitExecRequest[] = [];
        const result = await new RestrictedGitRunner({
          exec: recordingExec(calls),
        }).validateRepository(await candidateOf(repo.root));
        expect(result.ok).toBe(true);
        expect(existsSync(sentinel)).toBe(false);
        for (const call of calls) expect(call.env).not.toHaveProperty("HOME");
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    });
  });

  it("executes nothing a hostile repository declares", async () => {
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const hostile = join(root, "hostile");
      mkdirSync(join(hostile, "hooks"), { recursive: true });
      const sentinel = join(hostile, "executed.log");

      // every script appends its name to the sentinel; any single execution
      // fails the test
      const scripts: Record<string, string> = {
        "hook.sh": "pre-commit/post-checkout stand-in via core.hooksPath",
        "fsmonitor.sh": "core.fsmonitor hook",
        "pager.sh": "core.pager / pager.*",
        "editor.sh": "core.editor / GIT_EDITOR",
        "diff.sh": "diff.external",
        "diffdriver.sh": "diff.<driver>.command",
        "textconv.sh": "diff.<driver>.textconv",
        "filter.sh": "filter.<driver>.clean/smudge",
        "cred.sh": "credential.helper",
        "alias.sh": "alias shadowing a plumbing builtin",
        "ssh.sh": "core.sshCommand",
      };
      for (const [name, role] of Object.entries(scripts)) {
        writeFileSync(
          join(hostile, name),
          `#!/bin/sh\necho '${name} (${role})' >> '${sentinel}'\nexit 0\n`,
        );
        chmodSync(join(hostile, name), 0o755);
      }
      for (const hook of ["pre-commit", "post-checkout", "post-merge", "pre-push"]) {
        writeFileSync(
          join(hostile, "hooks", hook),
          `#!/bin/sh\necho 'hook:${hook}' >> '${sentinel}'\nexit 0\n`,
        );
        chmodSync(join(hostile, "hooks", hook), 0o755);
      }

      // a Repository-controlled executable sitting in the working tree
      // (RT-T-29 Repository executable fixture): validation must never run it
      writeFileSync(join(repo.root, "build.sh"), `#!/bin/sh\necho 'build.sh' >> '${sentinel}'\n`);
      chmodSync(join(repo.root, "build.sh"), 0o755);

      // include.path pulls in a second config that re-declares the same
      // program entry points — `-c` overrides must still win
      const included = join(hostile, "included-config");
      writeFileSync(
        included,
        [
          "[core]",
          `\thooksPath = ${hostile}/hooks`,
          `\tpager = ${hostile}/pager.sh`,
          "[alias]",
          `\trev-parse = !${hostile}/alias.sh`,
          "",
        ].join("\n"),
      );

      // NOTE: written after the fixture commits, so no setup command can
      // execute any of it either.
      await appendFile(
        join(repo.root, ".git", "config"),
        [
          "",
          "[core]",
          `\thooksPath = ${hostile}/hooks`,
          `\tfsmonitor = ${hostile}/fsmonitor.sh`,
          `\tpager = ${hostile}/pager.sh`,
          `\teditor = ${hostile}/editor.sh`,
          `\tsshCommand = ${hostile}/ssh.sh`,
          "[alias]",
          `\trev-parse = !${hostile}/alias.sh`,
          `\tsymbolic-ref = !${hostile}/alias.sh`,
          `\tfor-each-ref = !${hostile}/alias.sh`,
          "[diff]",
          `\texternal = ${hostile}/diff.sh`,
          '[diff "evil"]',
          `\tcommand = ${hostile}/diffdriver.sh`,
          `\ttextconv = ${hostile}/textconv.sh`,
          '[filter "evil"]',
          `\tclean = ${hostile}/filter.sh`,
          `\tsmudge = ${hostile}/filter.sh`,
          "[credential]",
          `\thelper = ${hostile}/cred.sh`,
          "[include]",
          `\tpath = ${included}`,
          '[url "https://evil.invalid/"]',
          "\tinsteadOf = https://github.com/",
          "[submodule]",
          "\trecurse = true",
          "",
        ].join("\n"),
      );

      const result = await new RestrictedGitRunner().validateRepository(
        await candidateOf(repo.root),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repository.headCommitSha).toBe(repo.head);
      expect(result.repository.currentBranch).toBe("main");
      expect(existsSync(sentinel)).toBe(false);
    });
  });

  it("alias shadowing cannot redirect a plumbing builtin (probe)", async () => {
    // Direct probe of the precedence claim: alias.rev-parse is ignored because
    // rev-parse is a builtin; alias expansion only applies to unknown commands.
    await withTempRoot(async (root) => {
      const repo = await makeRepo(join(root, "repo"));
      const sentinel = join(root, "alias-ran");
      setupGit(["config", "alias.rev-parse", `!echo ran >> ${sentinel}`], repo.root);
      const out = setupGit(["rev-parse", "--is-inside-work-tree"], repo.root);
      expect(out).toBe("true");
      expect(existsSync(sentinel)).toBe(false);
    });
  });
});
