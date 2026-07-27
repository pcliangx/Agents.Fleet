// RT-WORKTREE-05/10 + SV1-FILE-10 — synchronous Ready-transaction verifier.
//
// The provisioner observes a complete Worktree before the SQLite Ready
// transaction starts. This verifier repeats the identity and Git-binding
// observations inside that transaction so stale provision facts cannot be
// persisted as Ready. These observations detect drift; they are not a lock.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { FROZEN_RUNTIME_LIMIT_PROFILE, sameFilesystemIdentity } from "@agents-fleet/contracts";
import type { ProvisionedWorktree, ProvisionFailure } from "../git/provision-worktree.js";
import type { FilesystemIdentity } from "../git/restricted-git.js";
import {
  buildRestrictedGitEnvironment,
  RESTRICTED_GIT_CONFIG_OVERRIDES,
  RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
} from "../git/restricted-git-policy.js";
import type { ManagedWorktreeContext } from "../storage/worktree-store.js";

export type ReadyVerificationResult =
  | {
      readonly ok: true;
      readonly filesystemIdentity: FilesystemIdentity;
      readonly observedAt: string;
    }
  | { readonly ok: false; readonly failure: ProvisionFailure };

export interface WorktreeReadyVerifierOptions {
  readonly gitPath?: string;
  readonly now?: () => number;
}

const identityAt = (path: string): FilesystemIdentity | null => {
  try {
    const stat = lstatSync(path);
    if (realpathSync(path) !== path || !stat.isDirectory()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
};

const failed = (
  reason: Extract<ProvisionFailure, { kind: "ProvisionFailed" }>["reason"],
  detail: string,
): ReadyVerificationResult => ({
  ok: false,
  failure: { kind: "ProvisionFailed", reason, detail, leftover: "unknown" },
});

export class WorktreeReadyVerifier {
  readonly #gitPath: string;
  readonly #now: () => number;
  readonly #env = buildRestrictedGitEnvironment({ neutralizeSystemAttributes: true });

  constructor(options: WorktreeReadyVerifierOptions = {}) {
    this.#gitPath = options.gitPath ?? "/usr/bin/git";
    this.#now = options.now ?? (() => Date.now());
  }

  #exec(cwd: string, args: readonly string[]): string {
    return execFileSync(
      this.#gitPath,
      ["--no-pager", ...RESTRICTED_GIT_CONFIG_OVERRIDES.flatMap((entry) => ["-c", entry]), ...args],
      {
        cwd,
        env: this.#env,
        encoding: "utf8",
        timeout: RESTRICTED_GIT_OPERATION_TIMEOUT_MS,
        maxBuffer: FROZEN_RUNTIME_LIMIT_PROFILE.diffBytes,
      },
    );
  }

  verify(
    context: ManagedWorktreeContext,
    provisioned: ProvisionedWorktree,
  ): ReadyVerificationResult {
    const { record, repository } = context;
    const repositoryIdentity = identityAt(repository.workingTreeRoot);
    const commonGitIdentity = identityAt(repository.commonGitDir);
    const worktreeIdentity = identityAt(record.canonicalPath);
    if (
      repositoryIdentity === null ||
      !sameFilesystemIdentity(repositoryIdentity, repository.filesystemIdentity) ||
      commonGitIdentity === null ||
      !sameFilesystemIdentity(commonGitIdentity, repository.commonGitDirIdentity) ||
      worktreeIdentity === null ||
      !sameFilesystemIdentity(worktreeIdentity, provisioned.filesystemIdentity)
    ) {
      return failed("identity-drift", "filesystem identity drifted before Ready commit");
    }

    try {
      const commonRaw = this.#exec(record.canonicalPath, [
        "-C",
        record.canonicalPath,
        "rev-parse",
        "--git-common-dir",
      ]).trim();
      const commonPath = realpathSync(
        isAbsolute(commonRaw) ? commonRaw : resolve(record.canonicalPath, commonRaw),
      );
      if (commonPath !== repository.commonGitDir) {
        return failed("identity-drift", "Worktree Repository binding drifted before Ready commit");
      }

      const headSha = this.#exec(record.canonicalPath, [
        "-C",
        record.canonicalPath,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]).trim();
      const branchName = this.#exec(record.canonicalPath, [
        "-C",
        record.canonicalPath,
        "symbolic-ref",
        "--short",
        "HEAD",
      ]).trim();
      if (
        headSha !== record.baseCommitSha ||
        headSha !== provisioned.headCommitSha ||
        branchName !== record.branchName ||
        branchName !== provisioned.branchName
      ) {
        return failed("output-unparseable", "Worktree Git binding drifted before Ready commit");
      }
    } catch {
      return failed("git-failed", "restricted Git could not verify the Ready binding");
    }

    const repositoryAfter = identityAt(repository.workingTreeRoot);
    const commonGitAfter = identityAt(repository.commonGitDir);
    const worktreeAfter = identityAt(record.canonicalPath);
    if (
      repositoryAfter === null ||
      !sameFilesystemIdentity(repositoryAfter, repository.filesystemIdentity) ||
      commonGitAfter === null ||
      !sameFilesystemIdentity(commonGitAfter, repository.commonGitDirIdentity) ||
      worktreeAfter === null ||
      !sameFilesystemIdentity(worktreeAfter, worktreeIdentity)
    ) {
      return failed("identity-drift", "filesystem identity drifted during Ready verification");
    }

    return {
      ok: true,
      filesystemIdentity: worktreeAfter,
      observedAt: new Date(this.#now()).toISOString(),
    };
  }
}
