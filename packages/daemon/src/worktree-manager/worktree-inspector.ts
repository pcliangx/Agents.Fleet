// RT-WORKTREE-07 / RT-EVIDENCE-03 / SV1-FILE-06..07/10 — bounded,
// read-only Worktree inspection and canonical stateFingerprint.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type FingerprintBlocker,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type GitChange,
  type GitChangeStatus,
  type InspectWorktreeResult,
  type IntegrationTarget,
  type UntrackedEntry,
  type WorktreeInspection,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import type { FilesystemIdentity, GitExec, GitExecRequest } from "../git/restricted-git.js";
import type { ManagedWorktreeContext } from "../storage/worktree-store.js";
import { FileBroker } from "./filebroker.js";

const GIT_TIMEOUT_MS = 10_000;
const CONFIG_BUFFER_BYTES = 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_REF_RE = /^refs\/(?!.*(?:\.\.|[~^:?*[\]\\]))[^\0\s]+$/;

const BASE_OVERRIDES: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "credential.helper=",
  "submodule.recurse=false",
];

const buildGitEnv = (): Record<string, string> => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "/usr/bin/true",
  EDITOR: "/usr/bin/true",
});

const defaultExec: GitExec = async ({ argv, cwd, env }) => {
  const executable = argv[0];
  if (executable === undefined) throw new Error("empty argv");
  return await promisify(execFile)(executable, argv.slice(1), {
    cwd,
    env,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintBytes + 1,
    encoding: "utf8",
  });
};

interface GitOutput {
  readonly stdout: string;
  readonly bytes: number;
}

class InspectionFailure extends Error {
  readonly kind:
    | "InvalidRequest"
    | "Conflict"
    | "IdentityDrift"
    | "CapabilityUnavailable"
    | "GitFailure";

  constructor(kind: InspectionFailure["kind"], message: string) {
    super(message);
    this.name = "InspectionFailure";
    this.kind = kind;
  }
}

const sameIdentity = (left: FilesystemIdentity, right: FilesystemIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const recheckIdentity = async (
  path: string,
  expected: FilesystemIdentity,
  label: string,
): Promise<void> => {
  try {
    const canonical = await realpath(path);
    const st = await lstat(path);
    if (canonical !== path || !st.isDirectory() || !sameIdentity(st, expected)) {
      throw new InspectionFailure("IdentityDrift", `${label} identity drifted`);
    }
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure("IdentityDrift", `${label} identity drifted`);
  }
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const statusOf = (raw: string): GitChangeStatus => {
  switch (raw[0]) {
    case "A":
      return "Added";
    case "C":
      return "Copied";
    case "D":
      return "Deleted";
    case "M":
      return "Modified";
    case "R":
      return "Renamed";
    case "T":
      return "TypeChanged";
    case "U":
      return "Unmerged";
    default:
      throw new InspectionFailure("GitFailure", "Git returned an unknown change status");
  }
};

const parseNameStatus = (output: string): readonly GitChange[] => {
  const fields = output.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (status === undefined || status === "") break;
    const path = fields[index++];
    if (path === undefined || path === "") {
      throw new InspectionFailure("GitFailure", "Git returned an incomplete change record");
    }
    const kind = statusOf(status);
    if (kind === "Renamed" || kind === "Copied") {
      const destination = fields[index++];
      if (destination === undefined || destination === "") {
        throw new InspectionFailure("GitFailure", "Git returned an incomplete rename record");
      }
      changes.push({ path: destination, status: kind });
    } else {
      changes.push({ path, status: kind });
    }
  }
  return changes;
};

const parseNulPaths = (output: string): readonly string[] =>
  output.split("\0").filter((path) => path !== "");

const sliceUtf8 = (value: string, maxBytes: number): { text: string; bytes: number } => {
  const bytes = Buffer.from(value, "utf8");
  const slice = bytes.subarray(0, Math.max(0, maxBytes));
  return { text: slice.toString("utf8"), bytes: slice.length };
};

export interface WorktreeInspectorOptions {
  readonly gitPath?: string;
  readonly exec?: GitExec;
  readonly now?: () => number;
}

export class WorktreeInspector {
  readonly #gitPath: string;
  readonly #exec: GitExec;
  readonly #now: () => number;
  readonly #env = buildGitEnv();

  constructor(options: WorktreeInspectorOptions = {}) {
    this.#gitPath = options.gitPath ?? "/usr/bin/git";
    this.#exec = options.exec ?? defaultExec;
    this.#now = options.now ?? (() => Date.now());
  }

  async inspect(
    context: ManagedWorktreeContext,
    comparison?: IntegrationTarget,
  ): Promise<InspectWorktreeResult> {
    try {
      return { ok: true, inspection: await this.#inspect(context, comparison) };
    } catch (error) {
      if (error instanceof InspectionFailure) {
        return { ok: false, failure: { kind: error.kind, detail: error.message } };
      }
      return {
        ok: false,
        failure: { kind: "GitFailure", detail: "Worktree inspection failed" },
      };
    }
  }

  async #runGit(
    cwd: string,
    args: readonly string[],
    overrides: readonly string[],
    options: {
      readonly allowExitCodes?: readonly number[];
      readonly maxBytes?: number;
    } = {},
  ): Promise<GitOutput> {
    const argv = [
      this.#gitPath,
      "--no-pager",
      ...overrides.flatMap((entry) => ["-c", entry]),
      ...args,
    ];
    try {
      const result = await this.#exec({ argv, cwd, env: this.#env });
      const bytes = Buffer.byteLength(result.stdout, "utf8");
      if (bytes > (options.maxBytes ?? FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintBytes)) {
        throw new InspectionFailure("CapabilityUnavailable", "fingerprint byte budget exceeded");
      }
      return { stdout: result.stdout, bytes };
    } catch (error) {
      if (error instanceof InspectionFailure) throw error;
      const gitError = error as {
        readonly code?: number | string;
        readonly killed?: boolean;
        readonly stdout?: string;
      };
      if (typeof gitError.code === "number" && options.allowExitCodes?.includes(gitError.code)) {
        const stdout = String(gitError.stdout ?? "");
        return { stdout, bytes: Buffer.byteLength(stdout, "utf8") };
      }
      if (gitError.killed === true) {
        throw new InspectionFailure(
          "CapabilityUnavailable",
          "fingerprint duration budget exceeded",
        );
      }
      throw new InspectionFailure("GitFailure", "restricted Git inspection failed");
    }
  }

  async #filterOverrides(worktreePath: string): Promise<readonly string[]> {
    const config = await this.#runGit(
      worktreePath,
      ["-C", worktreePath, "config", "--local", "--get-regexp", "^filter\\."],
      BASE_OVERRIDES,
      { allowExitCodes: [1], maxBytes: CONFIG_BUFFER_BYTES },
    );
    const drivers = new Set<string>();
    for (const line of config.stdout.split("\n")) {
      if (line === "") continue;
      const key = line.trimStart().split(/\s+/, 1)[0] ?? "";
      const match = /^filter\.([A-Za-z0-9_-]+)\.(?:clean|smudge|process|required)$/.exec(key);
      if (match?.[1] !== undefined) {
        drivers.add(match[1]);
        continue;
      }
      if (key.startsWith("filter.")) {
        throw new InspectionFailure(
          "CapabilityUnavailable",
          "Repository filter name cannot be safely neutralized",
        );
      }
    }
    return [
      ...BASE_OVERRIDES,
      ...[...drivers].flatMap((driver) => [
        `filter.${driver}.clean=`,
        `filter.${driver}.smudge=`,
        `filter.${driver}.process=`,
        `filter.${driver}.required=false`,
      ]),
    ];
  }

  async #inspect(
    context: ManagedWorktreeContext,
    comparison?: IntegrationTarget,
  ): Promise<WorktreeInspection> {
    const { record, repository } = context;
    if (record.state !== "Ready" || record.filesystemIdentity === null) {
      throw new InspectionFailure("Conflict", "Worktree is not Ready");
    }
    await recheckIdentity(repository.workingTreeRoot, repository.filesystemIdentity, "Repository");
    await recheckIdentity(repository.commonGitDir, repository.commonGitDirIdentity, "Repository");
    await recheckIdentity(record.canonicalPath, record.filesystemIdentity, "Worktree");

    const startedAt = performance.now();
    const deadline = startedAt + FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintDurationMs;
    let bytesObserved = 0;
    const consume = (output: GitOutput): void => {
      bytesObserved += output.bytes;
      if (bytesObserved > FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintBytes) {
        throw new InspectionFailure("CapabilityUnavailable", "fingerprint byte budget exceeded");
      }
      if (performance.now() > deadline) {
        throw new InspectionFailure(
          "CapabilityUnavailable",
          "fingerprint duration budget exceeded",
        );
      }
    };

    const overrides = await this.#filterOverrides(record.canonicalPath);
    const common = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "rev-parse", "--git-common-dir"],
      overrides,
    );
    const commonRaw = common.stdout.trim();
    const commonPath = await realpath(
      isAbsolute(commonRaw) ? commonRaw : resolve(record.canonicalPath, commonRaw),
    );
    if (commonPath !== repository.commonGitDir) {
      throw new InspectionFailure("IdentityDrift", "Repository identity drifted");
    }

    const head = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "rev-parse", "--verify", "HEAD^{commit}"],
      overrides,
    );
    consume(head);
    const headSha = head.stdout.trim();
    if (!SHA_RE.test(headSha)) {
      throw new InspectionFailure("GitFailure", "Git returned an invalid HEAD");
    }
    const branch = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "symbolic-ref", "-q", "--short", "HEAD"],
      overrides,
      { allowExitCodes: [1] },
    );
    consume(branch);
    const branchName = branch.stdout.trim() === "" ? null : branch.stdout.trim();

    let comparisonRef: string | null = null;
    let comparisonSha: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (comparison !== undefined) {
      if (!SHA_RE.test(comparison.sha)) {
        throw new InspectionFailure("InvalidRequest", "comparison SHA is invalid");
      }
      if (comparison.ref !== null && !SAFE_REF_RE.test(comparison.ref)) {
        throw new InspectionFailure("InvalidRequest", "comparison ref is invalid");
      }
      const revision = comparison.ref === null ? comparison.sha : comparison.ref;
      let resolved: GitOutput;
      try {
        resolved = await this.#runGit(
          record.canonicalPath,
          ["-C", record.canonicalPath, "rev-parse", "--verify", `${revision}^{commit}`],
          overrides,
        );
      } catch (error) {
        if (error instanceof InspectionFailure && error.kind === "GitFailure") {
          throw new InspectionFailure("Conflict", "comparison target missing");
        }
        throw error;
      }
      consume(resolved);
      const actual = resolved.stdout.trim();
      if (actual !== comparison.sha) {
        throw new InspectionFailure("Conflict", "comparison target drifted");
      }
      comparisonRef = comparison.ref;
      comparisonSha = actual;
      const counts = await this.#runGit(
        record.canonicalPath,
        [
          "-C",
          record.canonicalPath,
          "rev-list",
          "--left-right",
          "--count",
          `${actual}...${headSha}`,
        ],
        overrides,
      );
      consume(counts);
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
        throw new InspectionFailure("GitFailure", "Git returned invalid ahead/behind counts");
      }
      behind = left as number;
      ahead = right as number;
    }

    const index = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "ls-files", "--stage", "-z"],
      overrides,
    );
    consume(index);
    const indexFileCount = parseNulPaths(index.stdout).length;

    const stagedRaw = await this.#runGit(
      record.canonicalPath,
      [
        "-C",
        record.canonicalPath,
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--no-renames",
        headSha,
        "--",
      ],
      overrides,
    );
    consume(stagedRaw);
    const unstagedRaw = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "diff", "--name-status", "-z", "--no-renames", "--"],
      overrides,
    );
    consume(unstagedRaw);
    const untrackedRaw = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "ls-files", "--others", "--exclude-standard", "-z"],
      overrides,
    );
    consume(untrackedRaw);

    const staged = parseNameStatus(stagedRaw.stdout);
    const unstaged = parseNameStatus(unstagedRaw.stdout);
    const untrackedPaths = parseNulPaths(untrackedRaw.stdout);
    const filesObserved = indexFileCount + untrackedPaths.length;
    let fingerprintBlocker: FingerprintBlocker | null = null;
    if (filesObserved > FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintFiles) {
      fingerprintBlocker = {
        reason: "file-count-limit",
        detail: "fingerprint file count exceeds RuntimeLimitProfile",
        filesObserved,
        bytesObserved,
      };
    }

    const stagedPatch = await this.#runGit(
      record.canonicalPath,
      [
        "-C",
        record.canonicalPath,
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        headSha,
        "--",
      ],
      overrides,
    );
    consume(stagedPatch);
    const unstagedPatch = await this.#runGit(
      record.canonicalPath,
      [
        "-C",
        record.canonicalPath,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--",
      ],
      overrides,
    );
    consume(unstagedPatch);

    const broker = new FileBroker();
    const root = broker.registerRoot("worktree", record.canonicalPath);
    if (!sameIdentity(root.identity, record.filesystemIdentity)) {
      throw new InspectionFailure("IdentityDrift", "Worktree identity drifted");
    }
    const remaining = (): number =>
      Math.max(0, FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintBytes - bytesObserved);
    const contentByPath: {
      readonly path: string;
      readonly contentHash: string;
      readonly bytes: number;
    }[] = [];
    const pathsToHash = new Set(
      unstaged.filter((change) => change.status !== "Deleted").map((change) => change.path),
    );
    for (const path of pathsToHash) {
      if (fingerprintBlocker !== null) break;
      const hashed = broker.hashFile(root.id, path, {
        maxBytes: remaining(),
        deadlineMs: deadline,
      });
      if (!hashed.ok) {
        fingerprintBlocker = {
          reason: hashed.reason,
          detail: hashed.detail,
          filesObserved,
          bytesObserved,
        };
        break;
      }
      bytesObserved += hashed.bytes;
      contentByPath.push({ path, contentHash: hashed.contentHash, bytes: hashed.bytes });
    }

    const untracked: UntrackedEntry[] = [];
    for (const path of untrackedPaths) {
      if (fingerprintBlocker !== null) break;
      const hashed = broker.hashFile(root.id, path, {
        maxBytes: remaining(),
        deadlineMs: deadline,
      });
      if (!hashed.ok) {
        fingerprintBlocker = {
          reason: hashed.reason,
          detail: hashed.detail,
          filesObserved,
          bytesObserved,
        };
        break;
      }
      bytesObserved += hashed.bytes;
      untracked.push({
        path,
        type: hashed.entryType,
        contentHash: hashed.contentHash,
        bytes: hashed.bytes,
      });
    }

    if (
      fingerprintBlocker === null &&
      bytesObserved > FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintBytes
    ) {
      fingerprintBlocker = {
        reason: "byte-limit",
        detail: "fingerprint bytes exceed RuntimeLimitProfile",
        filesObserved,
        bytesObserved,
      };
    }
    if (fingerprintBlocker === null && performance.now() > deadline) {
      fingerprintBlocker = {
        reason: "duration-limit",
        detail: "fingerprint duration exceeds RuntimeLimitProfile",
        filesObserved,
        bytesObserved,
      };
    }

    // Re-read the cheap manifests at the end. This is change detection, not a
    // filesystem lock: the observation still advertises observedAt and the
    // LocalObservationOnly freshness contract.
    const finalHead = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "rev-parse", "--verify", "HEAD^{commit}"],
      overrides,
    );
    const finalIndex = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "ls-files", "--stage", "-z"],
      overrides,
    );
    const finalStaged = await this.#runGit(
      record.canonicalPath,
      [
        "-C",
        record.canonicalPath,
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--no-renames",
        headSha,
        "--",
      ],
      overrides,
    );
    const finalUnstaged = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "diff", "--name-status", "-z", "--no-renames", "--"],
      overrides,
    );
    const finalUntracked = await this.#runGit(
      record.canonicalPath,
      ["-C", record.canonicalPath, "ls-files", "--others", "--exclude-standard", "-z"],
      overrides,
    );
    if (
      finalHead.stdout.trim() !== headSha ||
      finalIndex.stdout !== index.stdout ||
      finalStaged.stdout !== stagedRaw.stdout ||
      finalUnstaged.stdout !== unstagedRaw.stdout ||
      finalUntracked.stdout !== untrackedRaw.stdout
    ) {
      fingerprintBlocker = {
        reason: "read-failed",
        detail: "Worktree changed during inspection",
        filesObserved,
        bytesObserved,
      };
    }

    await recheckIdentity(repository.workingTreeRoot, repository.filesystemIdentity, "Repository");
    await recheckIdentity(repository.commonGitDir, repository.commonGitDirIdentity, "Repository");
    await recheckIdentity(record.canonicalPath, record.filesystemIdentity, "Worktree");

    const observedAt = new Date(this.#now()).toISOString();
    const stateFingerprint =
      fingerprintBlocker === null
        ? canonicalSha256({
            version: 1,
            headSha,
            indexHash: sha256(index.stdout),
            staged,
            stagedPatchHash: sha256(stagedPatch.stdout),
            unstaged,
            unstagedPatchHash: sha256(unstagedPatch.stdout),
            unstagedContent: contentByPath,
            untracked,
          })
        : null;

    const diffLimit = FROZEN_RUNTIME_LIMIT_PROFILE.diffBytes;
    const stagedView = sliceUtf8(stagedPatch.stdout, diffLimit);
    const unstagedView = sliceUtf8(unstagedPatch.stdout, Math.max(0, diffLimit - stagedView.bytes));
    const totalDiffBytes = stagedPatch.bytes + unstagedPatch.bytes;
    const diff = {
      staged: stagedView.text,
      unstaged: unstagedView.text,
      truncated: totalDiffBytes > diffLimit,
      returnedBytes: stagedView.bytes + unstagedView.bytes,
      totalBytesAtLeast: totalDiffBytes,
    };
    const dirty = staged.length > 0 || unstaged.length > 0 || untrackedPaths.length > 0;
    const disposeBlockers = [
      ...(dirty
        ? [
            {
              kind: "dirty" as const,
              detail: "Worktree has staged, unstaged, or untracked changes",
              relatedAttemptIds: [],
              relatedSessionIds: [],
            },
          ]
        : []),
      ...(fingerprintBlocker === null
        ? []
        : [
            {
              kind: "fingerprint-incomplete" as const,
              detail: fingerprintBlocker.detail,
              relatedAttemptIds: [],
              relatedSessionIds: [],
            },
          ]),
    ];

    return {
      worktreeId: record.worktreeId,
      state: record.state,
      role: record.role,
      canonicalPath: record.canonicalPath,
      filesystemIdentity: record.filesystemIdentity,
      branchName,
      detached: branchName === null,
      headSha,
      baseSha: record.baseCommitSha,
      comparisonRef,
      comparisonSha,
      ahead,
      behind,
      observedAt,
      refFreshness: "LocalObservationOnly",
      diff,
      gitObservation:
        stateFingerprint === null
          ? null
          : {
              worktreeId: record.worktreeId,
              worktreeIdentity: record.filesystemIdentity,
              headSha,
              baseSha: record.baseCommitSha,
              comparisonRef,
              comparisonSha,
              stateFingerprint,
              observedAt,
              refSource: "LocalOnly",
              refFreshness: "LocalObservationOnly",
              staged,
              unstaged,
              untracked,
            },
      fingerprintBlocker,
      disposeBlockers,
    };
  }
}

export type { GitExecRequest };
