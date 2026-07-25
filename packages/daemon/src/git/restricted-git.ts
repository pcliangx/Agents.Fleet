// RT-REPO-02 / SV1-FILE-06 — Restricted Git Interface.
//
// The ONLY Git entry point allowed while Repository Trust is PendingValidation
// (SV1-TRUST-04 / SV1-TRUST-08 / RT-ENV-01). Before the first Trust
// confirmation nothing here may run: `readRepositoryCandidateMetadata` does
// canonicalize + stat only and has no process-spawning capability by
// construction. After confirmation, `validateRepository` runs the frozen
// RT-REPO-02 plan below and nothing else.
//
// Boundary design (evidence: docs/probes/r0-05-repository-trust-no-exec.md):
// - explicit git binary path, structured argv, no shell (SV1-PERM-03 shape);
// - plumbing builtins only (rev-parse / symbolic-ref / for-each-ref). A
//   builtin always beats a same-named alias, so Repository config cannot
//   redirect the plan;
// - cleaned environment: no GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_PARAMETERS /
//   GIT_CONFIG_COUNT / GIT_EXEC_PATH inheritance; system and global config are
//   neutralized so only Repository config remains — and only as data;
// - `-c` overrides hold the highest config precedence (above include.path) and
//   disable every config-declared external program the frozen plan could
//   otherwise reach (hooksPath, fsmonitor, pager, external diff, credential
//   helper, submodule recursion — the SV1-FILE-06 list);
// - no GIT_CEILING_DIRECTORIES trick: discovery may ascend, but the
//   working-tree root must match the confirmed candidate exactly — anything
//   else is a stable root-mismatch rejection (RT-REPO-02);
// - no fetch, no credential access, no network-capable command (SV1-FILE-07).

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

export interface FilesystemIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface RepositoryCandidate {
  readonly canonicalRoot: string;
  readonly filesystemIdentity: FilesystemIdentity;
}

export interface ValidatedRepository {
  readonly workingTreeRoot: string;
  readonly gitDir: string;
  /** realpath of the common Git directory — the common Repository identity anchor. */
  readonly commonGitDir: string;
  readonly headCommitSha: string;
  /** null when HEAD is detached (RT-REPO-04). */
  readonly currentBranch: string | null;
  /**
   * `refs/remotes/origin/HEAD` target, or null when the repository has no
   * reliably determinable default base — never guessed (RT-REPO-04).
   */
  readonly defaultBaseRef: string | null;
  /** Resolved SHA of `defaultBaseRef`; null together with it. */
  readonly defaultBaseRefSha: string | null;
  /** Raw `git --version` output, recorded as evidence for R0-15's matrix. */
  readonly gitVersion: string;
  readonly observedAt: string;
}

export type RepositoryValidationFailure =
  | {
      kind: "UnsupportedRepository";
      reason: "bare" | "unborn-head" | "root-mismatch";
      detail: string;
    }
  | {
      kind: "RepositoryInvalid";
      reason:
        | "not-a-repository"
        | "corrupt"
        | "identity-drift"
        | "git-failed"
        | "git-timeout"
        | "output-unparseable";
      detail: string;
    };

export type RepositoryValidationResult =
  | { ok: true; repository: ValidatedRepository }
  | { ok: false; failure: RepositoryValidationFailure };

export interface GitExecRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type GitExec = (request: GitExecRequest) => Promise<{ stdout: string; stderr: string }>;

export interface RestrictedGitRunnerOptions {
  /** Explicit git binary. Never resolved through the ambient PATH. */
  readonly gitPath?: string;
  /** Test seam: records/audits every call. Defaults to `defaultGitExec`. */
  readonly exec?: GitExec;
  /** App-owned neutral directory for repo-independent invocations (RT-ENV-02 shape). */
  readonly neutralCwd?: string;
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// stderr signatures that mean the repository itself is damaged, as opposed to
// absent (not a git repository) or valid-but-unsupported (bare / unborn).
// Probed on Apple Git 2.50.1 — see docs/probes/r0-05.
const CORRUPT_RE = /bad config|missing object|bad object|bad ref|corrupt|loose object/i;

// `-c` overrides carry the highest config precedence — above system, global,
// Repository and include.path config — so a malicious Repository cannot
// re-enable any of these entry points. Exactly the SV1-FILE-06 disable list,
// plus pager/credential neutralization required by SV1-FILE-07.
const CONFIG_OVERRIDES: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "credential.helper=",
  "submodule.recurse=false",
];

// Everything git needs and nothing it can be redirected by. In particular no
// HOME, no GIT_DIR / GIT_WORK_TREE, no GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT,
// no GIT_EXEC_PATH, no SSH_ASKPASS.
const buildRestrictedGitEnv = (): Record<string, string> => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "/usr/bin/true",
  EDITOR: "/usr/bin/true",
});

export const defaultGitExec: GitExec = async ({ argv, cwd, env }) => {
  const file = argv[0];
  if (file === undefined) throw new Error("empty argv");
  return await promisify(execFile)(file, argv.slice(1), {
    cwd,
    env,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
  });
};

// RT-REPO-01 / RT-ENV-01 — before the first Trust confirmation the candidate
// is only canonical path + filesystem identity. No Git, no shell, no
// Repository content is read or executed; this function cannot spawn by
// construction.
export const readRepositoryCandidateMetadata = async (
  path: string,
): Promise<RepositoryCandidate> => {
  const canonicalRoot = await realpath(path);
  const st = await lstat(canonicalRoot);
  if (!st.isDirectory()) {
    throw new Error(`repository candidate is not a directory: ${canonicalRoot}`);
  }
  return { canonicalRoot, filesystemIdentity: { dev: st.dev, ino: st.ino } };
};

export class RestrictedGitRunner {
  private readonly gitPath: string;
  private readonly exec: GitExec;
  private readonly neutralCwd: string;

  constructor(options: RestrictedGitRunnerOptions = {}) {
    this.gitPath = options.gitPath ?? "/usr/bin/git";
    this.exec = options.exec ?? defaultGitExec;
    this.neutralCwd = options.neutralCwd ?? process.env.TMPDIR ?? tmpdir();
  }

  // RT-REPO-02 — the frozen PendingValidation plan. Bounded, read-only,
  // idempotent. Any failure returns a stable classification; it never leaves
  // an Active Trust or Runnable Workspace behind (that transition is the
  // caller's transaction, RT-REPO-03).
  async validateRepository(candidate: RepositoryCandidate): Promise<RepositoryValidationResult> {
    const root = candidate.canonicalRoot;

    // Re-canonicalize + stat immediately before invoking Git (RT-REPO-06
    // drift rule). A replaced path or changed identity fails closed before
    // any Git call.
    let st: Stats;
    try {
      const canonicalAgain = await realpath(root);
      if (canonicalAgain !== root) {
        return invalid("identity-drift", `canonical root moved: ${root} -> ${canonicalAgain}`);
      }
      st = await lstat(root);
    } catch (e) {
      return invalid("identity-drift", `cannot re-stat candidate root: ${message(e)}`);
    }
    if (
      !st.isDirectory() ||
      st.dev !== candidate.filesystemIdentity.dev ||
      st.ino !== candidate.filesystemIdentity.ino
    ) {
      return invalid("identity-drift", "filesystem identity changed since confirmation");
    }

    const env = buildRestrictedGitEnv();

    // Step 0 — record the binary version as evidence, from the app-owned
    // neutral cwd. This invocation does not touch the Repository.
    const version = await this.runGit(["--version"], this.neutralCwd, env);
    if (!version.ok) return version;
    const gitVersion = version.stdout.trim();
    if (!/git version \d+\.\d+/.test(gitVersion)) {
      return invalid("output-unparseable", `unexpected git --version output: ${gitVersion}`);
    }

    // Step 1 — bare check.
    const bare = await this.runGit(["-C", root, "rev-parse", "--is-bare-repository"], root, env);
    if (!bare.ok) return bare;
    if (bare.stdout.trim() === "true") {
      return {
        ok: false,
        failure: { kind: "UnsupportedRepository", reason: "bare", detail: root },
      };
    }

    // Step 2 — the selected root must be exactly the working-tree root.
    const toplevel = await this.runGit(["-C", root, "rev-parse", "--show-toplevel"], root, env);
    if (!toplevel.ok) return toplevel;
    let workingTreeRoot: string;
    try {
      workingTreeRoot = await realpath(toplevel.stdout.trim());
    } catch (e) {
      return invalid("output-unparseable", `cannot resolve --show-toplevel: ${message(e)}`);
    }
    if (workingTreeRoot !== root) {
      return {
        ok: false,
        failure: {
          kind: "UnsupportedRepository",
          reason: "root-mismatch",
          detail: `git working-tree root ${workingTreeRoot} != confirmed root ${root}`,
        },
      };
    }

    // Step 3 — common Repository identity.
    const gitDirOut = await this.runGit(["-C", root, "rev-parse", "--absolute-git-dir"], root, env);
    if (!gitDirOut.ok) return gitDirOut;
    const commonOut = await this.runGit(["-C", root, "rev-parse", "--git-common-dir"], root, env);
    if (!commonOut.ok) return commonOut;
    const commonRaw = commonOut.stdout.trim();
    const commonAbs = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
    let gitDir: string;
    let commonGitDir: string;
    try {
      gitDir = await realpath(gitDirOut.stdout.trim());
      commonGitDir = await realpath(commonAbs);
    } catch (e) {
      return invalid("output-unparseable", `cannot resolve git directories: ${message(e)}`);
    }

    // Step 4 — HEAD shape: detached (importable, branch null) or a
    // refs/heads/* symbolic target. A symbolic HEAD outside refs/heads is not
    // a branch and is rejected as corrupt rather than mislabeled.
    const symref = await this.runGit(["-C", root, "symbolic-ref", "-q", "HEAD"], root, env, {
      allowExitCodes: [1],
    });
    if (!symref.ok) return symref;
    const headRef = symref.stdout.trim();
    if (headRef !== "" && !headRef.startsWith("refs/heads/")) {
      return invalid("corrupt", `HEAD symbolic target outside refs/heads: ${headRef}`);
    }
    const currentBranch = headRef === "" ? null : headRef.slice("refs/heads/".length);

    // Step 5 — HEAD must resolve to a commit. git prints the same "Needed a
    // single revision" for an unborn branch and for a missing object, so the
    // discriminator is a bounded for-each-ref: empty (or lacking the HEAD
    // target) means unborn; a fatal means the object graph is damaged.
    const head = await this.runGit(
      ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      root,
      env,
    );
    if (!head.ok) {
      if (head.failure.kind !== "RepositoryInvalid" || head.failure.reason !== "git-failed") {
        return head;
      }
      if (headRef === "") {
        return invalid("corrupt", "detached HEAD does not resolve to a commit");
      }
      const refs = await this.runGit(
        ["-C", root, "for-each-ref", "--format=%(refname)"],
        root,
        env,
      );
      if (!refs.ok) {
        return invalid("corrupt", `cannot enumerate refs: ${failureDetail(refs)}`);
      }
      const refNames = refs.stdout.split("\n").map((l) => l.trim());
      if (refNames.every((r) => r === "") || !refNames.includes(headRef)) {
        return {
          ok: false,
          failure: {
            kind: "UnsupportedRepository",
            reason: "unborn-head",
            detail: `HEAD target ${headRef} has no commit`,
          },
        };
      }
      return invalid("corrupt", `HEAD target ${headRef} exists but does not resolve to a commit`);
    }
    const headCommitSha = head.stdout.trim();
    if (!SHA_RE.test(headCommitSha)) {
      return invalid("output-unparseable", `unexpected HEAD revision: ${headCommitSha}`);
    }

    // Step 6 — default base ref: the clone-recorded origin/HEAD target, or
    // null. Never guessed (RT-REPO-04); an origin/HEAD that exists but does
    // not resolve is damaged state and fails closed as corrupt.
    const originHead = await this.runGit(
      ["-C", root, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
      root,
      env,
      { allowExitCodes: [1] },
    );
    if (!originHead.ok) return originHead;
    const defaultBaseRef = originHead.stdout.trim() || null;
    let defaultBaseRefSha: string | null = null;
    if (defaultBaseRef !== null) {
      const baseSha = await this.runGit(
        ["-C", root, "rev-parse", "--verify", `${defaultBaseRef}^{commit}`],
        root,
        env,
      );
      if (baseSha.ok && SHA_RE.test(baseSha.stdout.trim())) {
        defaultBaseRefSha = baseSha.stdout.trim();
      } else {
        return invalid("corrupt", `origin/HEAD target ${defaultBaseRef} does not resolve`);
      }
    }

    return {
      ok: true,
      repository: {
        workingTreeRoot,
        gitDir,
        commonGitDir,
        headCommitSha,
        currentBranch,
        defaultBaseRef,
        defaultBaseRefSha,
        gitVersion,
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async runGit(
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    opts: { allowExitCodes?: readonly number[] } = {},
  ): Promise<{ ok: true; stdout: string } | { ok: false; failure: RepositoryValidationFailure }> {
    const argv = [
      this.gitPath,
      "--no-pager",
      ...CONFIG_OVERRIDES.flatMap((c) => ["-c", c]),
      ...args,
    ];
    try {
      const { stdout } = await this.exec({ argv, cwd, env });
      return { ok: true, stdout };
    } catch (e) {
      const err = e as {
        killed?: boolean;
        code?: number | string;
        stdout?: unknown;
        stderr?: string;
        message?: string;
      };
      if (err.killed === true) {
        return {
          ok: false,
          failure: { kind: "RepositoryInvalid", reason: "git-timeout", detail: argv.join(" ") },
        };
      }
      if (typeof err.code === "number" && opts.allowExitCodes?.includes(err.code)) {
        return { ok: true, stdout: String(err.stdout ?? "") };
      }
      const stderr = String(err.stderr ?? err.message ?? "unknown git failure").trim();
      if (/not a git repository/i.test(stderr)) {
        return {
          ok: false,
          failure: {
            kind: "RepositoryInvalid",
            reason: "not-a-repository",
            detail: stderr.slice(0, 500),
          },
        };
      }
      if (CORRUPT_RE.test(stderr)) {
        return {
          ok: false,
          failure: { kind: "RepositoryInvalid", reason: "corrupt", detail: stderr.slice(0, 500) },
        };
      }
      return {
        ok: false,
        failure: { kind: "RepositoryInvalid", reason: "git-failed", detail: stderr.slice(0, 500) },
      };
    }
  }
}

const invalid = (
  reason: Extract<RepositoryValidationFailure, { kind: "RepositoryInvalid" }>["reason"],
  detail: string,
): RepositoryValidationResult => ({
  ok: false,
  failure: { kind: "RepositoryInvalid", reason, detail },
});

const failureDetail = (
  result: { ok: true; stdout: string } | { ok: false; failure: RepositoryValidationFailure },
): string => (result.ok ? "" : result.failure.detail);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
