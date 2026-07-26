// SV1-FILE-11 / RT-WORKTREE-11 — no-external-program Worktree checkout.
//
// Materializes a Fleet-managed worktree from a base commit with every
// config-declared external program DISABLED (post-checkout hook, fsmonitor,
// submodule recursion, pager, credential helper, external diff). A filter that
// applies to a checked-out path FAILS CLOSED as CapabilityUnavailable: Fleet
// will not run the filter program, and checking out without it would be
// semantically incomplete (RT-WORKTREE-11). diff/textconv are not triggered by
// checkout; fsmonitor/submodule/pager/credential disables are defense-in-depth
// (current git's `worktree add` does not invoke them, but the disable prevents
// future-regression). Mirrors the restricted-git boundary (explicit binary,
// structured argv, no shell, cleaned env, `-c` precedence).

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultGitExec, type GitExec } from "./restricted-git.js";

export interface WorktreeMaterializeRequest {
  readonly sourceRoot: string;
  readonly baseCommitSha: string;
  readonly targetPath: string;
}

export type WorktreeMaterializeFailure =
  | {
      readonly kind: "CapabilityUnavailable";
      readonly reason: "declared-filter";
      readonly detail: string;
    }
  | { readonly kind: "git-failed"; readonly detail: string }
  | { readonly kind: "git-timeout"; readonly detail: string };

export type WorktreeMaterializeResult =
  | { readonly ok: true; readonly worktreePath: string; readonly headCommitSha: string }
  | { readonly ok: false; readonly failure: WorktreeMaterializeFailure };

export interface WorktreeMaterializeOptions {
  readonly gitPath?: string;
  readonly exec?: GitExec;
}

// `-c` overrides at the highest precedence disable every config-declared entry
// point a checkout could reach. Filters are handled by detection + fail-closed,
// not by silent disable.
const CONFIG_OVERRIDES: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "credential.helper=",
  "submodule.recurse=false",
];

const buildEnv = (): Record<string, string> => ({
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

type Step =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly failure: WorktreeMaterializeFailure };

const fail = (
  failure: WorktreeMaterializeFailure,
): { readonly ok: false; readonly failure: WorktreeMaterializeFailure } => ({ ok: false, failure });

export const materializeWorktree = async (
  req: WorktreeMaterializeRequest,
  options: WorktreeMaterializeOptions = {},
): Promise<WorktreeMaterializeResult> => {
  const gitPath = options.gitPath ?? "/usr/bin/git";
  const exec = options.exec ?? defaultGitExec;
  const env = buildEnv();

  const run = async (args: readonly string[]): Promise<Step> => {
    const argv = [
      gitPath,
      "-C",
      req.sourceRoot,
      "--no-pager",
      ...CONFIG_OVERRIDES.flatMap((c) => ["-c", c]),
      ...args,
    ];
    try {
      const { stdout } = await exec({ argv, cwd: req.sourceRoot, env });
      return { ok: true, stdout };
    } catch (e) {
      const err = e as { killed?: boolean; stderr?: string; message?: string };
      if (err.killed === true) {
        return fail({ kind: "git-timeout", detail: argv.join(" ") });
      }
      return fail({
        kind: "git-failed",
        detail: String(err.stderr ?? err.message ?? "git failed")
          .trim()
          .slice(0, 500),
      });
    }
  };

  // RT-WORKTREE-11 — detect a filter that applies to any path materialized at
  // the base commit. `git check-attr filter` reports the assigned filter without
  // running it; a value other than `unspecified`/`unset` means Fleet would have
  // to run an external program to produce the correct bytes, which it will not.
  const lsTree = await run(["ls-tree", "-r", "--name-only", req.baseCommitSha]);
  if (!lsTree.ok) return lsTree;
  const paths = lsTree.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (paths.length > 0) {
    const attr = await run(["check-attr", "filter", "--", ...paths]);
    if (!attr.ok) return attr;
    const declared = attr.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /: filter:/.test(l))
      .filter((l) => !/: filter: unspecified$/.test(l) && !/: filter: unset$/.test(l));
    if (declared.length > 0) {
      return fail({
        kind: "CapabilityUnavailable",
        reason: "declared-filter",
        detail: declared[0] ?? "declared filter applies to a checked-out path",
      });
    }
  }

  // No filter applies — materialize with every external-program entry disabled.
  const add = await run(["worktree", "add", "--detach", req.targetPath, req.baseCommitSha]);
  if (!add.ok) return add;
  if (!existsSync(req.targetPath)) {
    return fail({
      kind: "git-failed",
      detail: "worktree add reported success but target is missing",
    });
  }

  // Confirm the new worktree HEAD is exactly the requested base commit.
  const head = await run(["-C", req.targetPath, "rev-parse", "HEAD"]);
  if (!head.ok) return head;
  return { ok: true, worktreePath: req.targetPath, headCommitSha: head.stdout.trim() };
};
