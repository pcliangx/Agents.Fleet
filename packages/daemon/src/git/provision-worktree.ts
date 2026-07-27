// SV1-FILE-11 / RT-WORKTREE-11 — Worktree provision: no-external-program checkout.
//
// Sister boundary to restricted-git.ts (R0-05). The PendingValidation plan
// never materializes a working tree; checkout/materialization reaches strictly
// more external-program entry points: post-checkout hooks (core.hooksPath),
// smudge/process filters (repo .gitattributes + repo config filter.*),
// fsmonitor hooks on index write, pager, credential helper, submodule
// recursion. Evidence: docs/probes/r0-11-no-external-checkout.md.
//
// Selected materialization path (probed on Apple Git 2.50.1, /usr/bin/git):
//
//   preflight filter-attribute scan + `git worktree add --detach <path> <sha>`
//   under the shared restricted-Git overrides and scrubbed environment.
//
// Why this path (probe IDs refer to the probe doc):
// - `git worktree add` runs the post-checkout hook (P1); `-c
//   core.hooksPath=/dev/null` provably neutralizes it (P2). Same for
//   fsmonitor (P9), pager / credential helper / external diff (P11).
// - Filters are attribute-driven: a `filter.<name>` config executes only for
//   paths whose attributes set `filter=<name>` (P3, S3). Names cannot be
//   wildcard-disabled via `-c`, so instead the preflight scan proves NO path
//   in the target commit carries a `filter` attribute — then no filter can
//   execute regardless of config. Any path with a set `filter` attribute
//   means the repository needs an external filter for a correct checkout (or
//   we cannot prove the checkout complete), so we fail closed with
//   CapabilityUnavailable BEFORE any materialization (SV1-FILE-11, P4/S4).
// - Rejected candidates: pure plumbing fill (`read-tree` + `checkout-index`)
//   still executes smudge filters (P7) and buys nothing once hooks are
//   provably neutralized; `git archive | tar` also executes smudge filters
//   (P8) AND diverges from checkout semantics (export-subst rewrites content,
//   export-ignore drops files).
//
// Fail-closed contract (RT-WORKTREE-11 / SV1-T-27): CapabilityUnavailable is
// returned before any Worktree metadata or file is created — this module
// creates no LaunchIntent, starts no Agent, and never marks a partial
// Worktree Ready (those transitions are the caller's transaction,
// RT-WORKTREE-05/10). On a materialization failure the `leftover` field tells
// the caller whether "no side effect" can be proven (Failed) or not
// (Orphaned); this module never deletes an unproven path (RT-WORKTREE-06).
//
// Active Trust or Launch Confirmation is NOT a substitute for this boundary
// (SV1-FILE-11): the checks here are structural, not confirmation-gated.

import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { FilesystemIdentity, GitExec, GitExecRequest } from "./restricted-git.js";
import {
  buildRestrictedGitEnvironment,
  RESTRICTED_GIT_CONFIG_OVERRIDES,
} from "./restricted-git-policy.js";

export interface ProvisionRepository {
  /** canonical working-tree root of the validated Repository (SV1-FILE-10). */
  readonly workingTreeRoot: string;
  /** identity captured at validation; re-verified before any Git call. */
  readonly filesystemIdentity: FilesystemIdentity;
}

export interface ProvisionRequest {
  readonly repository: ProvisionRepository;
  /** The confirmed baseCommitSha (RT-WORKTREE-01) — a full commit SHA, never a ref name. */
  readonly baseCommitSha: string;
  /** Planned canonical Worktree path. Must not exist; never created on failure. */
  readonly targetPath: string;
  /**
   * R1 managed branch. Omit only for the R0 detached-checkout fixture.
   * `git worktree add -b` fails on collision and never reuses/deletes a branch.
   */
  readonly branchName?: string;
}

export interface FilterFinding {
  /** Tree path carrying a set `filter` attribute. */
  readonly path: string;
  /** The attribute value (driver name, or "set" for a bare `filter` attribute). */
  readonly driver: string;
  /** Whether repo config declares any `filter.<driver>.*` key. */
  readonly configured: boolean;
  /** LFS-style pointer blob heuristic; null when not a readable small blob. */
  readonly lfsPointer: boolean | null;
}

export type ProvisionFailure =
  | {
      // SV1-FILE-11: no verifiable no-external-program path for this
      // repository, or checkout would be incomplete without external filters.
      kind: "CapabilityUnavailable";
      reason: "external-filter-required" | "cannot-prove-no-external-program";
      detail: string;
      findings: readonly FilterFinding[];
    }
  | {
      kind: "ProvisionFailed";
      reason:
        | "invalid-request"
        | "identity-drift"
        | "target-exists"
        | "branch-collision"
        | "not-a-repository"
        | "git-failed"
        | "git-timeout"
        | "output-unparseable";
      detail: string;
      /**
       * RT-WORKTREE-05/11 input: "none" proves no side effect was left (record
       * may go Failed); "unknown" means a partial result may exist (Orphaned).
       */
      leftover: "none" | "unknown";
    };

export interface ProvisionedWorktree {
  readonly worktreePath: string;
  readonly filesystemIdentity: FilesystemIdentity;
  readonly headCommitSha: string;
  readonly branchName: string | null;
  readonly materializedBy: "git-worktree-add" | "reconciled";
  /** Number of tree paths the preflight filter scan covered. */
  readonly scannedPaths: number;
  readonly gitVersion: string;
  readonly observedAt: string;
}

export type ProvisionResult =
  | { ok: true; worktree: ProvisionedWorktree }
  | { ok: false; failure: ProvisionFailure };

export interface WorktreeProvisionerOptions {
  /** Explicit git binary. Never resolved through the ambient PATH. */
  readonly gitPath?: string;
  /** Test seam: records/audits every call. Defaults to `defaultProvisionGitExec`. */
  readonly exec?: GitExec;
  /** App-owned neutral directory for repo-independent invocations (RT-ENV-02 shape). */
  readonly neutralCwd?: string;
}

// Materialization is unbounded in tree size, unlike the bounded validation
// plan; the limits are generous but still hard caps.
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// git-lfs pointer files are small text blobs with a fixed first line.
const LFS_POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
const LFS_POINTER_MAX_BYTES = 4096;

// Paths per `check-attr` invocation — keeps argv far below ARG_MAX without a
// stdin channel (GitExec is argv-only by design).
const CHECK_ATTR_CHUNK = 256;

// Shared `-c` overrides carry the highest config precedence (above system,
// global, Repository and include.path config). They are exactly the
// SV1-FILE-11 disable list.
// Filters are absent here on purpose: they cannot be wildcard-disabled by
// name, so they are excluded by the preflight scan instead — a repository
// whose tree carries any `filter` attribute gets CapabilityUnavailable.

export const defaultProvisionGitExec: GitExec = async ({ argv, cwd, env }) => {
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

export class WorktreeProvisioner {
  private readonly gitPath: string;
  private readonly exec: GitExec;
  private readonly neutralCwd: string;
  /** Scrubbed environment for every Git invocation; fixed at construction. */
  private readonly env: Record<string, string>;

  constructor(options: WorktreeProvisionerOptions = {}) {
    this.gitPath = options.gitPath ?? "/usr/bin/git";
    this.exec = options.exec ?? defaultProvisionGitExec;
    this.neutralCwd = options.neutralCwd ?? process.env.TMPDIR ?? tmpdir();
    this.env = buildRestrictedGitEnvironment({ neutralizeSystemAttributes: true });
  }

  /**
   * RT-WORKTREE-06 — observe the exact target left by a crash after
   * `git worktree add` but before the Ready transaction. This never creates,
   * rewrites or removes anything. Only an exact path / Repository / branch /
   * HEAD match is returned as complete; every mismatch remains unowned.
   */
  async inspectExistingWorktree(request: ProvisionRequest): Promise<ProvisionResult> {
    const { repository, baseCommitSha, targetPath, branchName } = request;
    if (!SHA_RE.test(baseCommitSha) || branchName === undefined || branchName.length === 0) {
      return failed("invalid-request", "reconciliation requires full managed plan facts");
    }
    try {
      const canonicalRepository = await realpath(repository.workingTreeRoot);
      const repositoryStat = await lstat(repository.workingTreeRoot);
      if (
        canonicalRepository !== repository.workingTreeRoot ||
        !repositoryStat.isDirectory() ||
        repositoryStat.dev !== repository.filesystemIdentity.dev ||
        repositoryStat.ino !== repository.filesystemIdentity.ino
      ) {
        return failed("identity-drift", "repository identity changed", "unknown");
      }
      const canonicalTarget = await realpath(targetPath);
      const targetStat = await lstat(targetPath);
      if (canonicalTarget !== targetPath || !targetStat.isDirectory()) {
        return failed("identity-drift", "planned target identity cannot be proven", "unknown");
      }

      const version = await this.runGit(["--version"], this.neutralCwd);
      if (!version.ok) return withUnknownLeftover(version);
      const rootCommon = await this.runGit(
        ["-C", repository.workingTreeRoot, "rev-parse", "--git-common-dir"],
        repository.workingTreeRoot,
      );
      if (!rootCommon.ok) return withUnknownLeftover(rootCommon);
      const targetCommon = await this.runGit(
        ["-C", targetPath, "rev-parse", "--git-common-dir"],
        repository.workingTreeRoot,
      );
      if (!targetCommon.ok) return withUnknownLeftover(targetCommon);
      const rootCommonPath = await realpath(
        resolveGitPath(repository.workingTreeRoot, rootCommon.stdout.trim()),
      );
      const targetCommonPath = await realpath(
        resolveGitPath(targetPath, targetCommon.stdout.trim()),
      );
      if (rootCommonPath !== targetCommonPath) {
        return failed("identity-drift", "target belongs to another Repository", "unknown");
      }

      const toplevel = await this.runGit(
        ["-C", targetPath, "rev-parse", "--show-toplevel"],
        repository.workingTreeRoot,
      );
      if (!toplevel.ok) return withUnknownLeftover(toplevel);
      const head = await this.runGit(
        ["-C", targetPath, "rev-parse", "--verify", "HEAD^{commit}"],
        repository.workingTreeRoot,
      );
      if (!head.ok) return withUnknownLeftover(head);
      const branch = await this.runGit(
        ["-C", targetPath, "symbolic-ref", "--short", "HEAD"],
        repository.workingTreeRoot,
      );
      if (!branch.ok) return withUnknownLeftover(branch);
      if (
        toplevel.stdout.trim() !== targetPath ||
        head.stdout.trim() !== baseCommitSha ||
        branch.stdout.trim() !== branchName
      ) {
        return failed(
          "output-unparseable",
          "existing target does not match managed plan",
          "unknown",
        );
      }
      return {
        ok: true,
        worktree: {
          worktreePath: targetPath,
          filesystemIdentity: { dev: targetStat.dev, ino: targetStat.ino },
          headCommitSha: baseCommitSha,
          branchName,
          materializedBy: "reconciled",
          scannedPaths: 0,
          gitVersion: version.stdout.trim(),
          observedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return failed(
        "identity-drift",
        `existing target cannot be reconciled: ${message(error)}`,
        "unknown",
      );
    }
  }

  // SV1-FILE-11 / RT-WORKTREE-11 — materialize a Fleet-managed Worktree at a
  // confirmed commit without executing any Repository- or user-config-declared
  // external program, or fail closed before creating anything.
  async provisionWorktree(request: ProvisionRequest): Promise<ProvisionResult> {
    const { repository, baseCommitSha, targetPath, branchName } = request;

    if (!SHA_RE.test(baseCommitSha)) {
      return failed("invalid-request", `baseCommitSha is not a full commit SHA: ${baseCommitSha}`);
    }
    if (targetPath.includes("\0")) {
      return failed("invalid-request", "targetPath contains NUL");
    }
    if (branchName !== undefined && (branchName.length === 0 || branchName.includes("\0"))) {
      return failed("invalid-request", "branchName is empty or contains NUL");
    }

    // SV1-FILE-10 — re-verify the declared Repository identity immediately
    // before any Git invocation; fail closed with zero Git calls on drift.
    try {
      const canonicalAgain = await realpath(repository.workingTreeRoot);
      if (canonicalAgain !== repository.workingTreeRoot) {
        return failed(
          "identity-drift",
          `canonical root moved: ${repository.workingTreeRoot} -> ${canonicalAgain}`,
        );
      }
      const st = await lstat(repository.workingTreeRoot);
      if (
        !st.isDirectory() ||
        st.dev !== repository.filesystemIdentity.dev ||
        st.ino !== repository.filesystemIdentity.ino
      ) {
        return failed("identity-drift", "repository filesystem identity changed since validation");
      }
    } catch (e) {
      return failed("identity-drift", `cannot re-stat repository root: ${message(e)}`);
    }

    // The planned path must not exist; we never overwrite or remove a path we
    // cannot prove ours (RT-WORKTREE-06). Checked before any Git call.
    if (await exists(targetPath)) {
      return failed("target-exists", `planned worktree path already exists: ${targetPath}`);
    }

    const root = repository.workingTreeRoot;

    // Step 0 — record the binary version as evidence, from the app-owned
    // neutral cwd. Does not touch the Repository.
    const version = await this.runGit(["--version"], this.neutralCwd);
    if (!version.ok) return version;
    const gitVersion = version.stdout.trim();
    if (!/git version \d+\.\d+/.test(gitVersion)) {
      return failed("output-unparseable", `unexpected git --version output: ${gitVersion}`);
    }

    // Step 1 — preflight: enumerate the target commit's tree and prove that no
    // path carries a `filter` attribute. Only then is `worktree add` a
    // verifiable no-external-program checkout (filters are attribute-driven;
    // probed P3/S3). check-attr reads attributes as data and never executes a
    // filter. --source makes it read the commit's .gitattributes, not the
    // current working tree's (P5); .git/info/attributes and core.attributesFile
    // stay in the stack for scan and checkout alike, so both see the same set
    // (P5b/S1).
    const tree = await this.runGit(["-C", root, "ls-tree", "-r", "-z", baseCommitSha], root);
    if (!tree.ok) return tree;
    const treeEntries = parseLsTree(tree.stdout);

    const findings: FilterFinding[] = [];
    for (const chunk of chunks(
      treeEntries.map((e) => e.path),
      CHECK_ATTR_CHUNK,
    )) {
      const attr = await this.runGit(
        ["-C", root, "check-attr", "--source", baseCommitSha, "-z", "filter", "--", ...chunk],
        root,
      );
      if (!attr.ok) {
        // git < 2.40 has no check-attr --source: the no-external-program path
        // is not verifiable on this binary — fail closed (SV1-FILE-11; the
        // version floor itself belongs to SupportedPlatformMatrix, R0-15).
        if (
          attr.failure.kind === "ProvisionFailed" &&
          /unknown option|usage:/i.test(attr.failure.detail)
        ) {
          return {
            ok: false,
            failure: {
              kind: "CapabilityUnavailable",
              reason: "cannot-prove-no-external-program",
              detail: `git check-attr --source unsupported: ${attr.failure.detail}`,
              findings: [],
            },
          };
        }
        return attr;
      }
      for (const [path, value] of parseCheckAttr(attr.stdout)) {
        if (value === "unspecified" || value === "unset") continue;
        findings.push({ path, driver: value, configured: false, lfsPointer: null });
      }
    }

    if (findings.length > 0) {
      // Classify each finding for evidence: does repo config declare the
      // driver, and is the blob an LFS-style pointer (i.e. the real content
      // exists only behind an external filter)?
      const filterConfig = await this.runGit(
        ["-C", root, "config", "--local", "--get-regexp", "^filter\\."],
        root,
        { allowExitCodes: [1] },
      );
      if (!filterConfig.ok) return filterConfig;
      const configuredDrivers = new Set(
        filterConfig.stdout
          .split("\n")
          .map((l) => /^filter\.([^.]+)\./.exec(l.trim())?.[1])
          .filter((d): d is string => d !== undefined),
      );
      const blobByPath = new Map(treeEntries.map((e) => [e.path, e] as const));
      const enriched: FilterFinding[] = [];
      for (const f of findings) {
        const entry = blobByPath.get(f.path);
        const configured = configuredDrivers.has(f.driver);
        const lfsPointer = entry?.type === "blob" ? await this.isLfsPointer(root, entry.sha) : null;
        enriched.push({ ...f, configured, lfsPointer });
      }
      // SV1-FILE-11: the repository needs an external filter for a correct
      // checkout (driver configured), or checkout completeness cannot be
      // proven (driver undeclared here — it may live in disabled user-global
      // config — or the blob is a pointer). Either way: fail closed BEFORE
      // any Worktree metadata, LaunchIntent, or Agent exists (SV1-T-27).
      return {
        ok: false,
        failure: {
          kind: "CapabilityUnavailable",
          reason: "external-filter-required",
          detail:
            `tree at ${baseCommitSha} declares filter attributes on ${enriched.length} path(s); ` +
            "materialization would require an external filter program or cannot be proven complete",
          findings: enriched,
        },
      };
    }

    // Step 2 — materialize. --detach because the SHA is the confirmed
    // baseCommitSha; branch strategy is the caller's (RT-WORKTREE-04), not
    // this boundary's. No checkout of Repository files is executed: hooks go
    // to /dev/null, no path carries a filter attribute (proven above),
    // fsmonitor/pager/diff/credential/submodule are pinned off.
    const add = await this.runGit(
      branchName === undefined
        ? ["-C", root, "worktree", "add", "--detach", targetPath, baseCommitSha]
        : ["-C", root, "worktree", "add", "-b", branchName, targetPath, baseCommitSha],
      root,
    );
    if (!add.ok) {
      // RT-WORKTREE-11: only a proven-clean failure may become Failed.
      const leftover = (await exists(targetPath)) ? "unknown" : "none";
      if (add.failure.kind === "ProvisionFailed") {
        return { ok: false, failure: { ...add.failure, leftover } };
      }
      return add;
    }

    // Step 3 — verify what was materialized before reporting it: canonical
    // path matches the planned binding, HEAD is the confirmed SHA, and the
    // worktree root is exactly the target (SV1-FILE-10 / RT-WORKTREE-10
    // inputs). rev-parse only — status/diff could reach clean filters and are
    // the inspection slice's business, not provision's.
    // From here on the Worktree may exist: any failure has unproven side
    // effects and must not be reported as cleanly Failed (RT-WORKTREE-11).
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(targetPath);
    } catch (e) {
      return failed(
        "git-failed",
        `worktree target missing after successful add: ${message(e)}`,
        "unknown",
      );
    }
    if (canonicalTarget !== targetPath) {
      return failed(
        "identity-drift",
        `materialized path ${canonicalTarget} != planned ${targetPath}`,
        "unknown",
      );
    }
    const head = await this.runGit(["-C", targetPath, "rev-parse", "--verify", "HEAD"], root);
    if (!head.ok) return withUnknownLeftover(head);
    if (head.stdout.trim() !== baseCommitSha) {
      return failed(
        "output-unparseable",
        `materialized HEAD ${head.stdout.trim()} != ${baseCommitSha}`,
        "unknown",
      );
    }
    const toplevel = await this.runGit(["-C", targetPath, "rev-parse", "--show-toplevel"], root);
    if (!toplevel.ok) return withUnknownLeftover(toplevel);
    if (toplevel.stdout.trim() !== targetPath) {
      return failed(
        "output-unparseable",
        `materialized toplevel ${toplevel.stdout.trim()} != ${targetPath}`,
        "unknown",
      );
    }
    if (branchName !== undefined) {
      const branch = await this.runGit(["-C", targetPath, "symbolic-ref", "--short", "HEAD"], root);
      if (!branch.ok) return withUnknownLeftover(branch);
      if (branch.stdout.trim() !== branchName) {
        return failed(
          "output-unparseable",
          `materialized branch ${branch.stdout.trim()} != ${branchName}`,
          "unknown",
        );
      }
    }

    const st = await lstat(targetPath);
    return {
      ok: true,
      worktree: {
        worktreePath: targetPath,
        filesystemIdentity: { dev: st.dev, ino: st.ino },
        headCommitSha: baseCommitSha,
        branchName: branchName ?? null,
        materializedBy: "git-worktree-add",
        scannedPaths: treeEntries.length,
        gitVersion,
        observedAt: new Date().toISOString(),
      },
    };
  }

  // Bounded pointer check on a small blob: cat-file reads raw object data and
  // never runs filters (no --filters/--textconv/--path flags).
  private async isLfsPointer(root: string, blobSha: string): Promise<boolean | null> {
    if (!SHA_RE.test(blobSha)) return null;
    const size = await this.runGit(["-C", root, "cat-file", "-s", blobSha], root);
    if (!size.ok) return null;
    const bytes = Number.parseInt(size.stdout.trim(), 10);
    if (!Number.isFinite(bytes) || bytes > LFS_POINTER_MAX_BYTES) return null;
    const blob = await this.runGit(["-C", root, "cat-file", "blob", blobSha], root);
    if (!blob.ok) return null;
    return LFS_POINTER_RE.test(blob.stdout);
  }

  private async runGit(
    args: readonly string[],
    cwd: string,
    opts: { allowExitCodes?: readonly number[] } = {},
  ): Promise<{ ok: true; stdout: string } | { ok: false; failure: ProvisionFailure }> {
    const argv = [
      this.gitPath,
      "--no-pager",
      ...RESTRICTED_GIT_CONFIG_OVERRIDES.flatMap((entry) => ["-c", entry]),
      ...args,
    ];
    try {
      const { stdout } = await this.exec({ argv, cwd, env: this.env });
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
        return failed("git-timeout", argv.join(" "));
      }
      if (typeof err.code === "number" && opts.allowExitCodes?.includes(err.code)) {
        return { ok: true, stdout: String(err.stdout ?? "") };
      }
      const stderr = String(err.stderr ?? err.message ?? "unknown git failure").trim();
      if (/not a git repository/i.test(stderr)) {
        return failed("not-a-repository", stderr.slice(0, 500));
      }
      if (/a branch named .* already exists|already checked out at/i.test(stderr)) {
        return failed("branch-collision", stderr.slice(0, 500));
      }
      return failed("git-failed", stderr.slice(0, 500));
    }
  }
}

// `git ls-tree -r -z <commit>` records: "<mode> <type> <sha>\t<path>\0".
const parseLsTree = (
  out: string,
): { readonly path: string; readonly type: string; readonly sha: string }[] => {
  const entries: { path: string; type: string; sha: string }[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    const [, type, sha] = meta;
    if (type === undefined || sha === undefined) continue;
    entries.push({ path: record.slice(tab + 1), type, sha });
  }
  return entries;
};

// `git check-attr -z ... -- <paths>` triples: "<path>\0filter\0<value>\0".
const parseCheckAttr = (out: string): [string, string][] => {
  const fields = out.split("\0");
  const pairs: [string, string][] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    const value = fields[i + 2];
    if (path === undefined || value === undefined || path === "") continue;
    pairs.push([path, value]);
  }
  return pairs;
};

const chunks = function* (items: readonly string[], size: number): Generator<readonly string[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const failed = (
  reason: Extract<ProvisionFailure, { kind: "ProvisionFailed" }>["reason"],
  detail: string,
  leftover: "none" | "unknown" = "none",
): { ok: false; failure: ProvisionFailure } => ({
  ok: false,
  failure: { kind: "ProvisionFailed", reason, detail, leftover },
});

// runGit reports leftover "none" — correct only before materialization. Once
// `worktree add` has run, every failure must be re-labeled: the Worktree may
// exist and "no side effect" can no longer be proven (RT-WORKTREE-11).
const withUnknownLeftover = (result: { ok: false; failure: ProvisionFailure }): ProvisionResult => {
  if (result.failure.kind !== "ProvisionFailed") return result;
  return { ok: false, failure: { ...result.failure, leftover: "unknown" } };
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const resolveGitPath = (cwd: string, path: string): string =>
  path.startsWith("/") ? path : `${cwd}/${path}`;

// GitExecRequest re-exported for test-side exec seams (same shape as R0-05).
export type { GitExecRequest };
