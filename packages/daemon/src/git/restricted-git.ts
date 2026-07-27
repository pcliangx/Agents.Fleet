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
import type { FilesystemIdentity } from "@agents-fleet/contracts";
import {
  buildRestrictedGitEnvironment,
  RESTRICTED_GIT_CONFIG_OVERRIDES,
  RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
} from "./restricted-git-policy.js";

export type { FilesystemIdentity };

export interface RepositoryCandidate {
  readonly canonicalRoot: string;
  readonly filesystemIdentity: FilesystemIdentity;
}

/** RT-REPO-04 — one ref resolved to its SHA. */
export interface ResolvedRef {
  readonly name: string;
  readonly sha: string;
}

export interface ValidatedRepository {
  readonly workingTreeRoot: string;
  readonly gitDir: string;
  /** realpath of the common Git directory — the common Repository identity anchor. */
  readonly commonGitDir: string;
  /**
   * dev/ino of the realpath'd commonGitDir. A path string alone is not
   * identity: a replaced `.git` at the same path is a different Repository
   * (SV1-FILE-10).
   */
  readonly commonGitDirIdentity: FilesystemIdentity;
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
  /** Every ref resolved to a SHA (RT-REPO-04), bounded by MAX_ENUMERATED_REFS. */
  readonly refs: readonly ResolvedRef[];
  /** true when the repository has more refs than MAX_ENUMERATED_REFS — explicit truncation, never silent (RT-LIMIT-02). */
  readonly refsTruncated: boolean;
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

// RT-REPO-06 — the validation plan the Trust challenge displays and binds.
// A bounded, structured list of the exact plumbing steps validateRepository
// runs (SV1-TRUST-02: the dialog must show what PendingValidation will do);
// it is data, never shell text. Frozen so the displayed plan, the bound
// validationPlanHash and the executed plan cannot drift apart.
export const VALIDATION_PLAN: readonly {
  readonly step: string;
  readonly argv: readonly string[];
}[] = Object.freeze([
  Object.freeze({ step: "git-version", argv: Object.freeze(["--version"]) }),
  Object.freeze({ step: "bare-check", argv: Object.freeze(["rev-parse", "--is-bare-repository"]) }),
  Object.freeze({
    step: "working-tree-root",
    argv: Object.freeze(["rev-parse", "--show-toplevel"]),
  }),
  Object.freeze({ step: "git-dir", argv: Object.freeze(["rev-parse", "--absolute-git-dir"]) }),
  Object.freeze({ step: "common-git-dir", argv: Object.freeze(["rev-parse", "--git-common-dir"]) }),
  Object.freeze({ step: "head-symbolic-ref", argv: Object.freeze(["symbolic-ref", "-q", "HEAD"]) }),
  Object.freeze({
    step: "head-commit",
    argv: Object.freeze(["rev-parse", "--verify", "HEAD^{commit}"]),
  }),
  Object.freeze({
    step: "enumerate-refs",
    argv: Object.freeze(["for-each-ref", "--format=%(refname) %(objectname)"]),
  }),
  Object.freeze({
    step: "default-base-ref",
    argv: Object.freeze(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
  }),
  Object.freeze({
    step: "default-base-commit",
    argv: Object.freeze(["rev-parse", "--verify", "<defaultBaseRef>^{commit}"]),
  }),
]);

// RT-REPO-04 — the declared post-Active read-only inspection shape
// (SV1-FILE-06): current commit and branch, default base ref and its SHA,
// the common Repository identity and the observation time.
export interface RepositoryInspection {
  readonly currentCommitSha: string;
  /** null when HEAD is detached (RT-REPO-04). */
  readonly currentBranch: string | null;
  readonly defaultBaseRef: string | null;
  readonly defaultBaseRefSha: string | null;
  /** Every ref resolved to a SHA (RT-REPO-04), bounded by MAX_ENUMERATED_REFS. */
  readonly refs: readonly ResolvedRef[];
  readonly refsTruncated: boolean;
  readonly commonGitDir: string;
  readonly commonGitDirIdentity: FilesystemIdentity;
  readonly gitVersion: string;
  readonly observedAt: string;
}

export type RepositoryInspectionResult =
  | { ok: true; inspection: RepositoryInspection }
  | { ok: false; failure: RepositoryValidationFailure };

export type CommitObjectVerificationResult =
  | { readonly ok: true; readonly commitSha: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-sha"
        | "not-a-commit"
        | "repository-identity-drift"
        | "repository-validation-failed";
      readonly detail: string;
    };

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

const GIT_MAX_BUFFER = 1024 * 1024;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// RT-REPO-04 / RT-LIMIT-02 — bound on the enumerated ref list. The frozen
// RuntimeLimitProfile has no dedicated field for ref counts, so the bound is
// this frozen constant; beyond it the list is truncated with an explicit
// refsTruncated marker, never silently.
export const MAX_ENUMERATED_REFS = 1024;

// for-each-ref output lines: refnames cannot contain spaces (git-check-ref-format),
// so "<name> <sha>" splits unambiguously.
const REF_LINE_RE = /^(refs\/\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/;

// stderr signatures that mean the repository itself is damaged, as opposed to
// absent (not a git repository) or valid-but-unsupported (bare / unborn).
// Probed on Apple Git 2.50.1 — see docs/probes/r0-05.
const CORRUPT_RE = /bad config|missing object|bad object|bad ref|corrupt|loose object/i;

export const defaultGitExec: GitExec = async ({ argv, cwd, env }) => {
  const file = argv[0];
  if (file === undefined) throw new Error("empty argv");
  return await promisify(execFile)(file, argv.slice(1), {
    cwd,
    env,
    timeout: RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
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
    const preDrift = await recheckCandidateIdentity(candidate);
    if (preDrift !== null) return preDrift;

    const env = buildRestrictedGitEnvironment();

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
    // SV1-FILE-10 — the common Repository identity is path AND dev/ino; a
    // common Git directory that cannot be statted cannot prove identity and
    // fails closed with a stable classification (RT-REPO-02).
    let commonGitDirIdentity: FilesystemIdentity;
    try {
      const commonSt = await lstat(commonGitDir);
      commonGitDirIdentity = { dev: commonSt.dev, ino: commonSt.ino };
    } catch (e) {
      return invalid("identity-drift", `cannot stat common Git directory: ${message(e)}`);
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
        ["-C", root, "for-each-ref", "--format=%(refname) %(objectname)"],
        root,
        env,
      );
      if (!refs.ok) {
        return invalid("corrupt", `cannot enumerate refs: ${failureDetail(refs)}`);
      }
      const refNames = refs.stdout.split("\n").map((l) => l.trim().split(" ")[0] ?? "");
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

    // Step 5b — every ref resolved to a SHA (RT-REPO-04). Bounded by
    // MAX_ENUMERATED_REFS with an explicit truncation marker; a malformed
    // line means the output cannot be trusted and fails closed.
    const refsOut = await this.runGit(
      ["-C", root, "for-each-ref", "--format=%(refname) %(objectname)"],
      root,
      env,
    );
    if (!refsOut.ok) return refsOut;
    const parsedRefs = parseRefEnumeration(refsOut.stdout);
    if ("failure" in parsedRefs) return { ok: false, failure: parsedRefs.failure };

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

    // SV1-FILE-10 — identity is re-verified after the Git plan too: a swap of
    // the root or the common Git directory during the run fails closed
    // instead of binding facts gathered from two different Repositories.
    const postDrift = await recheckCandidateIdentity(candidate);
    if (postDrift !== null) return postDrift;
    try {
      const commonAfter = await lstat(commonGitDir);
      if (
        commonAfter.dev !== commonGitDirIdentity.dev ||
        commonAfter.ino !== commonGitDirIdentity.ino
      ) {
        return invalid("identity-drift", "common Git directory identity changed during validation");
      }
    } catch (e) {
      return invalid("identity-drift", `cannot re-stat common Git directory: ${message(e)}`);
    }

    return {
      ok: true,
      repository: {
        workingTreeRoot,
        gitDir,
        commonGitDir,
        commonGitDirIdentity,
        headCommitSha,
        currentBranch,
        defaultBaseRef,
        defaultBaseRefSha,
        refs: parsedRefs.refs,
        refsTruncated: parsedRefs.truncated,
        gitVersion,
        observedAt: new Date().toISOString(),
      },
    };
  }

  // RT-REPO-04 / SV1-FILE-06 — the declared read-only inspection allowed once
  // the Trust is Active. It runs the same bounded plumbing queries as
  // validateRepository (still the restricted interface: explicit binary,
  // structured argv, scrubbed environment) but changes NO state: a drift or a
  // failure comes back as the same stable classification and it is the
  // caller's decision what to do with it — inspection never revokes.
  //
  // `bound` carries the identity frozen when the Trust went Active; the live
  // root (re-checked inside validateRepository, before AND after the plan)
  // and the common Git directory are both compared against it, and any drift
  // is the stable `identity-drift` classification (SV1-FILE-10).
  async inspectValidatedRepository(
    candidate: RepositoryCandidate,
    bound?: {
      readonly commonGitDir: string;
      readonly commonGitDirIdentity: FilesystemIdentity;
    },
  ): Promise<RepositoryInspectionResult> {
    const result = await this.validateRepository(candidate);
    if (!result.ok) return result;
    if (
      bound !== undefined &&
      (result.repository.commonGitDir !== bound.commonGitDir ||
        result.repository.commonGitDirIdentity.dev !== bound.commonGitDirIdentity.dev ||
        result.repository.commonGitDirIdentity.ino !== bound.commonGitDirIdentity.ino)
    ) {
      return {
        ok: false,
        failure: {
          kind: "RepositoryInvalid",
          reason: "identity-drift",
          detail: "common Repository identity drifted since the Trust went Active",
        },
      };
    }
    return {
      ok: true,
      inspection: {
        currentCommitSha: result.repository.headCommitSha,
        currentBranch: result.repository.currentBranch,
        defaultBaseRef: result.repository.defaultBaseRef,
        defaultBaseRefSha: result.repository.defaultBaseRefSha,
        refs: result.repository.refs,
        refsTruncated: result.repository.refsTruncated,
        commonGitDir: result.repository.commonGitDir,
        commonGitDirIdentity: result.repository.commonGitDirIdentity,
        gitVersion: result.repository.gitVersion,
        observedAt: result.repository.observedAt,
      },
    };
  }

  // RT-WORKTREE-01/04 — resolve a user-selected full SHA through the Active
  // Repository's object database and require that the SHA names a commit
  // object itself. Comparing the peeled result with the input rejects both
  // non-commit objects and annotated-tag object IDs.
  async verifyCommitObject(
    candidate: RepositoryCandidate,
    bound: {
      readonly commonGitDir: string;
      readonly commonGitDirIdentity: FilesystemIdentity;
    },
    commitSha: string,
  ): Promise<CommitObjectVerificationResult> {
    if (!SHA_RE.test(commitSha)) {
      return { ok: false, reason: "invalid-sha", detail: "commit SHA must be full lowercase hex" };
    }
    const inspected = await this.inspectValidatedRepository(candidate, bound);
    if (!inspected.ok) {
      return {
        ok: false,
        reason:
          inspected.failure.kind === "RepositoryInvalid" &&
          inspected.failure.reason === "identity-drift"
            ? "repository-identity-drift"
            : "repository-validation-failed",
        detail: inspected.failure.detail,
      };
    }
    const resolved = await this.runGit(
      ["-C", candidate.canonicalRoot, "rev-parse", "--verify", `${commitSha}^{commit}`],
      candidate.canonicalRoot,
      buildRestrictedGitEnvironment(),
    );
    if (!resolved.ok) {
      return {
        ok: false,
        reason:
          resolved.failure.kind === "RepositoryInvalid" && resolved.failure.reason === "git-failed"
            ? "not-a-commit"
            : "repository-validation-failed",
        detail:
          resolved.failure.kind === "RepositoryInvalid" && resolved.failure.reason === "git-failed"
            ? `SHA ${commitSha} is not a commit object in the Active Repository`
            : resolved.failure.detail,
      };
    }
    if (resolved.stdout.trim() !== commitSha) {
      return {
        ok: false,
        reason: "not-a-commit",
        detail: `SHA ${commitSha} is not a commit object in the Active Repository`,
      };
    }

    const postDrift = await recheckCandidateIdentity(candidate);
    if (postDrift !== null) {
      return {
        ok: false,
        reason: "repository-identity-drift",
        detail: postDrift.ok ? "Repository identity changed" : postDrift.failure.detail,
      };
    }
    try {
      const commonPath = await realpath(bound.commonGitDir);
      const commonIdentity = await lstat(commonPath);
      if (
        commonPath !== bound.commonGitDir ||
        commonIdentity.dev !== bound.commonGitDirIdentity.dev ||
        commonIdentity.ino !== bound.commonGitDirIdentity.ino
      ) {
        return {
          ok: false,
          reason: "repository-identity-drift",
          detail: "common Repository identity changed while verifying commit",
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "repository-identity-drift",
        detail: `cannot re-stat common Git directory: ${message(error)}`,
      };
    }
    return { ok: true, commitSha };
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
      ...RESTRICTED_GIT_CONFIG_OVERRIDES.flatMap((entry) => ["-c", entry]),
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

// SV1-FILE-10 — re-canonicalize + stat the candidate root. Runs before the
// Git plan (RT-REPO-06 drift rule) and again after it, so a swap at any
// point fails closed with the stable identity-drift classification. Returns
// null when identity holds.
const recheckCandidateIdentity = async (
  candidate: RepositoryCandidate,
): Promise<RepositoryValidationResult | null> => {
  const root = candidate.canonicalRoot;
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
  return null;
};

// RT-REPO-04 — parse `for-each-ref --format=%(refname) %(objectname)` into a
// bounded ref/SHA list. Any line that is not exactly "<refs/...> <sha>" is
// output-unparseable; beyond MAX_ENUMERATED_REFS the list truncates with an
// explicit marker (RT-LIMIT-02).
const parseRefEnumeration = (
  stdout: string,
): { refs: ResolvedRef[]; truncated: boolean } | { failure: RepositoryValidationFailure } => {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  const refs: ResolvedRef[] = [];
  for (const line of lines) {
    const m = REF_LINE_RE.exec(line.trim());
    if (m === null || m[1] === undefined || m[2] === undefined) {
      const failure: RepositoryValidationFailure = {
        kind: "RepositoryInvalid",
        reason: "output-unparseable",
        detail: `unexpected for-each-ref line: ${line.trim().slice(0, 200)}`,
      };
      return { failure };
    }
    refs.push({ name: m[1], sha: m[2] });
  }
  const truncated = refs.length > MAX_ENUMERATED_REFS;
  return { refs: truncated ? refs.slice(0, MAX_ENUMERATED_REFS) : refs, truncated };
};

const failureDetail = (
  result: { ok: true; stdout: string } | { ok: false; failure: RepositoryValidationFailure },
): string => (result.ok ? "" : result.failure.detail);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
