// SV1-FILE-04/05/09/10 — final synchronous Worktree removal primitive.
//
// Called inside the Worktree Manager's SQLite transaction after every
// blocker and preview fact has been rechecked. It never passes --force and
// never deletes the managed branch.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { FROZEN_RUNTIME_LIMIT_PROFILE, sameFilesystemIdentity } from "@agents-fleet/contracts";
import type { FilesystemIdentity } from "../git/restricted-git.js";
import {
  buildRestrictedGitEnvironment,
  RESTRICTED_GIT_CONFIG_OVERRIDES,
  RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
} from "../git/restricted-git-policy.js";
import type { ManagedWorktreeContext } from "../storage/worktree-store.js";

const recheckDirectory = (path: string, expected: FilesystemIdentity, label: string): void => {
  try {
    const st = lstatSync(path);
    if (realpathSync(path) !== path || !st.isDirectory() || !sameFilesystemIdentity(st, expected)) {
      throw new Error(`${label} identity drifted`);
    }
  } catch {
    throw new Error(`${label} identity drifted`);
  }
};

export type WorktreeDisposeExecution =
  | { readonly ok: true; readonly disposedAt: string }
  | { readonly ok: false; readonly detail: string };

export interface WorktreeDisposerOptions {
  readonly gitPath?: string;
  readonly now?: () => number;
}

export class WorktreeDisposer {
  readonly #gitPath: string;
  readonly #now: () => number;
  readonly #env = buildRestrictedGitEnvironment({ neutralizeSystemAttributes: true });

  constructor(options: WorktreeDisposerOptions = {}) {
    this.#gitPath = options.gitPath ?? "/usr/bin/git";
    this.#now = options.now ?? (() => Date.now());
  }

  #exec(cwd: string, overrides: readonly string[], args: readonly string[]): string {
    return execFileSync(
      this.#gitPath,
      ["--no-pager", ...overrides.flatMap((entry) => ["-c", entry]), ...args],
      {
        cwd,
        env: this.#env,
        encoding: "utf8",
        timeout: RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
        maxBuffer: FROZEN_RUNTIME_LIMIT_PROFILE.diffBytes,
      },
    );
  }

  #filterOverrides(worktreePath: string): readonly string[] {
    let output = "";
    try {
      output = this.#exec(worktreePath, RESTRICTED_GIT_CONFIG_OVERRIDES, [
        "-C",
        worktreePath,
        "config",
        "--local",
        "--get-regexp",
        "^filter\\.",
      ]);
    } catch (error) {
      const gitError = error as { readonly status?: number; readonly stdout?: string | Buffer };
      if (gitError.status !== 1) throw error;
      output = String(gitError.stdout ?? "");
    }
    const drivers = new Set<string>();
    for (const line of output.split("\n")) {
      if (line === "") continue;
      const key = line.trimStart().split(/\s+/, 1)[0] ?? "";
      const match = /^filter\.([A-Za-z0-9_-]+)\.(?:clean|smudge|process|required)$/.exec(key);
      if (match?.[1] !== undefined) {
        drivers.add(match[1]);
      } else if (key.startsWith("filter.")) {
        throw new Error("Repository filter name cannot be safely neutralized");
      }
    }
    return [
      ...RESTRICTED_GIT_CONFIG_OVERRIDES,
      ...[...drivers].flatMap((driver) => [
        `filter.${driver}.clean=`,
        `filter.${driver}.smudge=`,
        `filter.${driver}.process=`,
        `filter.${driver}.required=false`,
      ]),
    ];
  }

  dispose(context: ManagedWorktreeContext): WorktreeDisposeExecution {
    const { record, repository } = context;
    if (record.filesystemIdentity === null) {
      return { ok: false, detail: "Worktree has no verified filesystem identity" };
    }
    try {
      recheckDirectory(repository.workingTreeRoot, repository.filesystemIdentity, "Repository");
      recheckDirectory(repository.commonGitDir, repository.commonGitDirIdentity, "Repository");
      recheckDirectory(record.canonicalPath, record.filesystemIdentity, "Worktree");
      const overrides = this.#filterOverrides(record.canonicalPath);

      const commonRaw = this.#exec(record.canonicalPath, overrides, [
        "-C",
        record.canonicalPath,
        "rev-parse",
        "--git-common-dir",
      ]).trim();
      const commonPath = realpathSync(
        isAbsolute(commonRaw) ? commonRaw : resolve(record.canonicalPath, commonRaw),
      );
      if (commonPath !== repository.commonGitDir) {
        return { ok: false, detail: "Worktree Repository identity drifted" };
      }
      const branch = this.#exec(record.canonicalPath, overrides, [
        "-C",
        record.canonicalPath,
        "symbolic-ref",
        "--short",
        "HEAD",
      ]).trim();
      if (branch !== record.branchName) {
        return { ok: false, detail: "managed branch drifted" };
      }

      // No --force and no branch deletion. Git performs its own final dirty /
      // submodule checks; any refusal leaves the Worktree record Ready.
      this.#exec(repository.workingTreeRoot, overrides, [
        "-C",
        repository.workingTreeRoot,
        "worktree",
        "remove",
        "--",
        record.canonicalPath,
      ]);
      try {
        lstatSync(record.canonicalPath);
        return { ok: false, detail: "Worktree path remains after Git remove" };
      } catch {
        // Expected: target path is gone.
      }
      const branchSha = this.#exec(repository.workingTreeRoot, overrides, [
        "-C",
        repository.workingTreeRoot,
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${record.branchName}`,
      ]).trim();
      if (branchSha === "") {
        return { ok: false, detail: "managed branch was not preserved" };
      }
      recheckDirectory(repository.workingTreeRoot, repository.filesystemIdentity, "Repository");
      recheckDirectory(repository.commonGitDir, repository.commonGitDirIdentity, "Repository");
      return { ok: true, disposedAt: new Date(this.#now()).toISOString() };
    } catch {
      return { ok: false, detail: "restricted Git refused Worktree removal" };
    }
  }
}
