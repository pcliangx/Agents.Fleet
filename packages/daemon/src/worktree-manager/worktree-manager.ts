// RT-MOD-04 — Worktree Manager Module Implementation.
//
// This class is the sole public Daemon seam for provision / inspect / dispose.
// The R0 materializer, restricted Git operations, FileBroker and SQLite stores
// remain private Implementation details.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AttemptId,
  CommandId,
  DisposeBlocker,
  DisposePreview,
  DisposePreviewResult,
  DisposeWorktreeResult,
  FilesystemIdentity,
  InspectWorktreeResult,
  IntegrationTarget,
  ProvisionWorktreeResult,
  SessionId,
  TaskId,
  WorktreeId,
  WorktreeManager,
  WorktreeManagerFailure,
} from "@agents-fleet/contracts";
import { FROZEN_RUNTIME_LIMIT_PROFILE, sameFilesystemIdentity } from "@agents-fleet/contracts";
import {
  type ProvisionFailure,
  type ProvisionResult,
  WorktreeProvisioner,
} from "../git/provision-worktree.js";
import { transact } from "../storage/database.js";
import { hashCommandPayload, type IdempotencyStore } from "../storage/idempotency.js";
import { StoreError } from "../storage/task-store.js";
import type { ManagedWorktreeContext, WorktreeStore } from "../storage/worktree-store.js";
import { WorktreeDisposer } from "./worktree-disposer.js";
import { WorktreeInspector } from "./worktree-inspector.js";
import { WorktreeReadyVerifier } from "./worktree-ready-verifier.js";

export interface WorktreeManagerOptions {
  readonly db: DatabaseSync;
  readonly store: WorktreeStore;
  readonly idempotency: IdempotencyStore;
  readonly provisioner?: WorktreeProvisioner;
  readonly inspector?: WorktreeInspector;
  readonly disposer?: WorktreeDisposer;
  readonly now?: () => number;
}

interface InflightProvision {
  readonly payloadHash: string;
  readonly result: Promise<ProvisionWorktreeResult>;
}

const failureKind = (failure: ProvisionFailure): WorktreeManagerFailure["kind"] => {
  if (failure.kind === "CapabilityUnavailable") return "CapabilityUnavailable";
  switch (failure.reason) {
    case "invalid-request":
      return "InvalidRequest";
    case "identity-drift":
      return "IdentityDrift";
    case "target-exists":
    case "branch-collision":
      return "Conflict";
    case "not-a-repository":
    case "git-failed":
    case "git-timeout":
    case "output-unparseable":
      return "GitFailure";
  }
};

const publicFailure = (failure: ProvisionFailure): WorktreeManagerFailure => ({
  kind: failureKind(failure),
  // Stable and deliberately path-free. Detailed Git stderr remains private
  // diagnostic data (SV1-DATA-05 / RT-ERR-01).
  detail:
    failure.kind === "CapabilityUnavailable"
      ? failure.reason
      : `Worktree provision failed: ${failure.reason}`,
});

export class WorktreeManagerImpl implements WorktreeManager {
  readonly #db: DatabaseSync;
  readonly #store: WorktreeStore;
  readonly #idempotency: IdempotencyStore;
  readonly #provisioner: WorktreeProvisioner;
  readonly #inspector: WorktreeInspector;
  readonly #disposer: WorktreeDisposer;
  readonly #readyVerifier: WorktreeReadyVerifier;
  readonly #now: () => number;
  readonly #inflightProvision = new Map<string, InflightProvision>();

  constructor(options: WorktreeManagerOptions) {
    this.#db = options.db;
    this.#store = options.store;
    this.#idempotency = options.idempotency;
    this.#provisioner = options.provisioner ?? new WorktreeProvisioner();
    this.#inspector =
      options.inspector ??
      new WorktreeInspector(options.now === undefined ? {} : { now: options.now });
    this.#disposer =
      options.disposer ??
      new WorktreeDisposer(options.now === undefined ? {} : { now: options.now });
    this.#readyVerifier = new WorktreeReadyVerifier(
      options.now === undefined ? {} : { now: options.now },
    );
    this.#now = options.now ?? (() => Date.now());
  }

  async provision(input: {
    readonly commandId: CommandId;
    readonly worktreeId: WorktreeId;
  }): Promise<ProvisionWorktreeResult> {
    const payload = { kind: "worktree-provision", worktreeId: input.worktreeId };
    const payloadHash = hashCommandPayload(payload);
    const replay = this.#idempotency.lookup(input.commandId, payloadHash);
    if (replay !== null) return replay as ProvisionWorktreeResult;

    const inflight = this.#inflightProvision.get(input.commandId);
    if (inflight !== undefined) {
      if (inflight.payloadHash !== payloadHash) {
        throw new StoreError(
          "IdempotencyConflict",
          `commandId ${input.commandId} was used with a different payload`,
        );
      }
      return await inflight.result;
    }

    const result = this.#provisionAndCommit(input, payloadHash);
    this.#inflightProvision.set(input.commandId, { payloadHash, result });
    try {
      return await result;
    } finally {
      this.#inflightProvision.delete(input.commandId);
    }
  }

  async #provisionAndCommit(
    input: { readonly commandId: CommandId; readonly worktreeId: WorktreeId },
    payloadHash: string,
  ): Promise<ProvisionWorktreeResult> {
    const context = this.#store.context(input.worktreeId);
    if (context.record.state !== "Planned" || context.record.role !== "Pending") {
      throw new StoreError(
        "Conflict",
        `Worktree ${input.worktreeId} is ${context.record.state}/${context.record.role}`,
      );
    }
    const provisionRequest = {
      repository: {
        workingTreeRoot: context.repository.workingTreeRoot,
        filesystemIdentity: context.repository.filesystemIdentity,
      },
      baseCommitSha: context.record.baseCommitSha,
      targetPath: context.record.canonicalPath,
      branchName: context.record.branchName,
    };
    let targetExists = false;
    try {
      lstatSync(context.record.canonicalPath);
      targetExists = true;
    } catch {
      // Planned target is absent: normal materialization path.
    }
    const provisioned = targetExists
      ? await this.#provisioner.inspectExistingWorktree(provisionRequest)
      : await this.#provisioner.provisionWorktree(provisionRequest);

    return transact(
      this.#db,
      () => {
        const readyContext = this.#store.context(input.worktreeId);
        let verifiedProvision: ProvisionResult = provisioned;
        if (provisioned.ok) {
          const verification = this.#readyVerifier.verify(readyContext, provisioned.worktree);
          verifiedProvision = verification.ok
            ? {
                ok: true,
                worktree: {
                  ...provisioned.worktree,
                  filesystemIdentity: verification.filesystemIdentity,
                  observedAt: verification.observedAt,
                },
              }
            : { ok: false, failure: verification.failure };
        }

        let result: ProvisionWorktreeResult;
        if (verifiedProvision.ok) {
          const ready = this.#store.commitProvisioned(input.worktreeId, {
            canonicalPath: verifiedProvision.worktree.worktreePath,
            repositoryIdentity: readyContext.record.repositoryIdentity,
            branchName: verifiedProvision.worktree.branchName ?? "",
            baseCommitSha: readyContext.record.baseCommitSha,
            headCommitSha: verifiedProvision.worktree.headCommitSha,
            filesystemIdentity: verifiedProvision.worktree.filesystemIdentity,
            observedAt: verifiedProvision.worktree.observedAt,
          });
          if (ready.state !== "Ready" || ready.filesystemIdentity === null) {
            throw new StoreError(
              "DataIntegrityFailure",
              "complete provision did not produce a Ready Worktree",
            );
          }
          result = {
            ok: true,
            worktreeId: ready.worktreeId,
            state: "Ready",
            role: ready.role as "Active" | "Historical",
            filesystemIdentity: ready.filesystemIdentity,
            observedAt: ready.observedAt ?? new Date(this.#now()).toISOString(),
          };
        } else {
          const failure = verifiedProvision.failure;
          const collision =
            targetExists ||
            (failure.kind === "ProvisionFailed" &&
              (failure.reason === "target-exists" || failure.reason === "branch-collision"));
          const failed = this.#store.commitProvisionFailure(input.worktreeId, {
            reason: failure.reason,
            detail: failure.detail,
            leftover:
              failure.kind === "CapabilityUnavailable"
                ? "none"
                : collision
                  ? "unknown"
                  : failure.leftover,
          });
          if (failed.state !== "Failed" && failed.state !== "Orphaned") {
            throw new StoreError(
              "DataIntegrityFailure",
              "provision failure produced an invalid Worktree state",
            );
          }
          result = {
            ok: false,
            worktreeId: failed.worktreeId,
            state: failed.state,
            failure: publicFailure(failure),
          };
        }
        this.#idempotency.record(input.commandId, payloadHash, result, {
          type: "Worktree",
          id: input.worktreeId,
        });
        return result;
      },
      this.#now,
    );
  }

  async inspect(input: {
    readonly worktreeId: WorktreeId;
    readonly comparison?: IntegrationTarget;
  }): Promise<InspectWorktreeResult> {
    const context = this.#store.context(input.worktreeId);
    const inspected = await this.#inspector.inspect(context, input.comparison);
    if (!inspected.ok) return inspected;
    const lifecycle = this.#store.disposeLifecycleFacts(input.worktreeId);
    const blockers = [
      ...lifecycleBlockers(lifecycle),
      ...inspected.inspection.disposeBlockers,
      ...unmergedCommitBlockers(inspected.inspection.ahead, lifecycle),
    ];
    return {
      ok: true,
      inspection: {
        ...inspected.inspection,
        taskId: context.record.taskId as TaskId,
        aliveSessions: lifecycle.aliveSessions.map((session) => ({
          sessionId: session.sessionId as SessionId,
          attemptId: session.attemptId as AttemptId,
          observedAt: session.observedAt,
        })),
        processDispositions: lifecycle.processDispositions.map((fact) => ({
          attemptId: fact.attemptId as AttemptId,
          disposition: fact.disposition,
          observedAt: fact.observedAt,
        })),
        disposeBlockers: dedupeBlockers(blockers),
      },
    };
  }

  async previewDispose(input: {
    readonly worktreeId: WorktreeId;
    readonly integrationTarget: IntegrationTarget;
  }): Promise<DisposePreviewResult> {
    let context: ManagedWorktreeContext;
    try {
      context = this.#store.context(input.worktreeId);
    } catch (error) {
      if (error instanceof StoreError) {
        return {
          ok: false,
          failure: {
            kind: error.code === "NotFound" ? "NotFound" : "Conflict",
            detail: error.message,
          },
        };
      }
      throw error;
    }
    const { record } = context;
    if (record.state !== "Ready" || record.filesystemIdentity === null) {
      return {
        ok: false,
        failure: { kind: "Conflict", detail: "Worktree is not Ready" },
      };
    }

    const lifecycle = this.#store.disposeLifecycleFacts(input.worktreeId);
    const blockers: DisposeBlocker[] = [...lifecycleBlockers(lifecycle)];

    const inspected = await this.#inspector.inspect(context, input.integrationTarget);
    let stateFingerprint: string | null = null;
    let observedAt = new Date(this.#now()).toISOString();
    if (inspected.ok) {
      observedAt = inspected.inspection.observedAt;
      stateFingerprint = inspected.inspection.gitObservation?.stateFingerprint ?? null;
      blockers.push(...inspected.inspection.disposeBlockers);
      blockers.push(...unmergedCommitBlockers(inspected.inspection.ahead, lifecycle));
      if (inspected.inspection.detached || inspected.inspection.branchName !== record.branchName) {
        blockers.push({
          kind: "externally-occupied",
          detail: "managed branch binding drifted",
          relatedAttemptIds: lifecycle.attemptIds,
          relatedSessionIds: [],
        });
      }
    } else if (inspected.failure.detail === "comparison target drifted") {
      blockers.push({
        kind: "target-drift",
        detail: inspected.failure.detail,
        relatedAttemptIds: lifecycle.attemptIds,
        relatedSessionIds: [],
      });
    } else if (inspected.failure.detail === "comparison target missing") {
      blockers.push({
        kind: "target-missing",
        detail: inspected.failure.detail,
        relatedAttemptIds: lifecycle.attemptIds,
        relatedSessionIds: [],
      });
    } else if (inspected.failure.kind === "IdentityDrift") {
      blockers.push({
        kind: "identity-drift",
        detail: inspected.failure.detail,
        relatedAttemptIds: lifecycle.attemptIds,
        relatedSessionIds: [],
      });
    } else {
      return inspected;
    }

    const estimatedReclaimBytes = estimateTreeBytes(
      record.canonicalPath,
      record.filesystemIdentity,
    );
    if (estimatedReclaimBytes === null) {
      blockers.push({
        kind: "reclaim-estimate-incomplete",
        detail: "Worktree reclaim estimate could not be completed safely",
        relatedAttemptIds: lifecycle.attemptIds,
        relatedSessionIds: [],
      });
    }
    const preview: DisposePreview = {
      worktreeId: record.worktreeId,
      stateVersion: record.stateVersion,
      canonicalPath: record.canonicalPath,
      filesystemIdentity: record.filesystemIdentity,
      stateFingerprint,
      integrationTarget: input.integrationTarget,
      preservedBranch: record.branchName,
      relatedTaskIds: lifecycle.taskIds as readonly TaskId[],
      relatedSessionIds: lifecycle.aliveSessionIds as readonly SessionId[],
      estimatedReclaimBytes,
      observedAt,
      blockers: dedupeBlockers(blockers),
    };
    return { ok: true, preview };
  }

  async dispose(input: {
    readonly commandId: CommandId;
    readonly worktreeId: WorktreeId;
    readonly expectedStateVersion: number;
    readonly expectedFilesystemIdentity: FilesystemIdentity;
    readonly expectedStateFingerprint: string;
    readonly integrationTarget: IntegrationTarget;
    readonly branchDisposition: "preserve";
  }): Promise<DisposeWorktreeResult> {
    const payload = { kind: "worktree-dispose", ...input };
    const payloadHash = hashCommandPayload(payload);
    const replay = this.#idempotency.lookup(input.commandId, payloadHash);
    if (replay !== null) return replay as DisposeWorktreeResult;

    if (input.branchDisposition !== "preserve") {
      return this.#recordDisposeResult(input, payloadHash, {
        ok: false,
        worktreeId: input.worktreeId,
        blockers: [
          {
            kind: "branch-delete-requested",
            detail: "v1 preserves the managed branch",
            relatedAttemptIds: [],
            relatedSessionIds: [],
          },
        ],
      });
    }

    const previewed = await this.previewDispose({
      worktreeId: input.worktreeId,
      integrationTarget: input.integrationTarget,
    });
    if (!previewed.ok) {
      throw new StoreError(
        previewed.failure.kind === "NotFound" ? "NotFound" : "Conflict",
        previewed.failure.detail,
      );
    }
    const blockers = [...previewed.preview.blockers];
    if (
      previewed.preview.stateVersion !== input.expectedStateVersion ||
      previewed.preview.stateFingerprint !== input.expectedStateFingerprint
    ) {
      blockers.push({
        kind: "state-changed",
        detail: "Worktree state changed after dispose preview",
        relatedAttemptIds: [],
        relatedSessionIds: previewed.preview.relatedSessionIds,
      });
    }
    if (
      !sameFilesystemIdentity(
        previewed.preview.filesystemIdentity,
        input.expectedFilesystemIdentity,
      )
    ) {
      blockers.push({
        kind: "identity-drift",
        detail: "Worktree identity changed after dispose preview",
        relatedAttemptIds: [],
        relatedSessionIds: previewed.preview.relatedSessionIds,
      });
    }
    if (blockers.length > 0) {
      return this.#recordDisposeResult(input, payloadHash, {
        ok: false,
        worktreeId: input.worktreeId,
        blockers: dedupeBlockers(blockers),
      });
    }

    return transact(
      this.#db,
      () => {
        const context = this.#store.context(input.worktreeId);
        const lifecycle = this.#store.disposeLifecycleFacts(input.worktreeId);
        const lateBlockers = lifecycleBlockers(lifecycle);
        if (
          context.record.stateVersion !== input.expectedStateVersion ||
          context.record.filesystemIdentity === null ||
          !sameFilesystemIdentity(
            context.record.filesystemIdentity,
            input.expectedFilesystemIdentity,
          )
        ) {
          lateBlockers.push({
            kind: "state-changed",
            detail: "Worktree state changed before removal",
            relatedAttemptIds: lifecycle.attemptIds,
            relatedSessionIds: lifecycle.aliveSessionIds as readonly SessionId[],
          });
        }
        if (lateBlockers.length > 0) {
          const result: DisposeWorktreeResult = {
            ok: false,
            worktreeId: input.worktreeId,
            blockers: dedupeBlockers(lateBlockers),
          };
          this.#idempotency.record(input.commandId, payloadHash, result, {
            type: "Worktree",
            id: input.worktreeId,
          });
          return result;
        }

        const removed = this.#disposer.dispose(context);
        if (!removed.ok) {
          const result: DisposeWorktreeResult = {
            ok: false,
            worktreeId: input.worktreeId,
            blockers: [
              {
                kind: "externally-occupied",
                detail: removed.detail,
                relatedAttemptIds: lifecycle.attemptIds,
                relatedSessionIds: [],
              },
            ],
          };
          this.#idempotency.record(input.commandId, payloadHash, result, {
            type: "Worktree",
            id: input.worktreeId,
          });
          return result;
        }
        const disposed = this.#store.markDisposed(input.worktreeId, {
          expectedStateVersion: input.expectedStateVersion,
          observedAt: removed.disposedAt,
        });
        const result: DisposeWorktreeResult = {
          ok: true,
          worktreeId: disposed.worktreeId,
          state: "Disposed",
          preservedBranch: disposed.branchName,
          disposedAt: removed.disposedAt,
        };
        this.#idempotency.record(input.commandId, payloadHash, result, {
          type: "Worktree",
          id: input.worktreeId,
        });
        return result;
      },
      this.#now,
    );
  }

  #recordDisposeResult(
    input: { readonly commandId: CommandId; readonly worktreeId: WorktreeId },
    payloadHash: string,
    result: DisposeWorktreeResult,
  ): DisposeWorktreeResult {
    return transact(
      this.#db,
      () => {
        this.#idempotency.record(input.commandId, payloadHash, result, {
          type: "Worktree",
          id: input.worktreeId,
        });
        return result;
      },
      this.#now,
    );
  }
}

const lifecycleBlockers = (
  lifecycle: ReturnType<WorktreeStore["disposeLifecycleFacts"]>,
): DisposeBlocker[] => [
  ...(lifecycle.nonterminalAttemptIds.length === 0
    ? []
    : [
        {
          kind: "nonterminal-attempt" as const,
          detail: "Worktree has a nonterminal Attempt",
          relatedAttemptIds: lifecycle.nonterminalAttemptIds,
          relatedSessionIds: [],
        },
      ]),
  ...(lifecycle.aliveSessionIds.length === 0
    ? []
    : [
        {
          kind: "alive-session" as const,
          detail: "Worktree has an Alive Session",
          relatedAttemptIds: lifecycle.attemptIds,
          relatedSessionIds: lifecycle.aliveSessionIds as readonly SessionId[],
        },
      ]),
  ...(lifecycle.pendingProcessAttemptIds.length === 0
    ? []
    : [
        {
          kind: "pending-process-disposition" as const,
          detail: "Worktree has a pending Process Disposition",
          relatedAttemptIds: lifecycle.pendingProcessAttemptIds,
          relatedSessionIds: [],
        },
      ]),
];

const unmergedCommitBlockers = (
  ahead: number | null,
  lifecycle: ReturnType<WorktreeStore["disposeLifecycleFacts"]>,
): DisposeBlocker[] =>
  ahead !== null && ahead > 0
    ? [
        {
          kind: "unmerged-commit",
          detail: "HEAD is not contained in the selected integration target",
          relatedAttemptIds: lifecycle.attemptIds,
          relatedSessionIds: [],
        },
      ]
    : [];

const dedupeBlockers = (blockers: readonly DisposeBlocker[]): readonly DisposeBlocker[] => {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.kind}:${blocker.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const estimateTreeBytes = (root: string, expectedIdentity: FilesystemIdentity): number | null => {
  const deadline = performance.now() + FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintDurationMs;
  let entries = 0;
  let bytes = 0;
  const visit = (path: string): void => {
    if (performance.now() > deadline) throw new Error("estimate timed out");
    const st = lstatSync(path);
    entries++;
    if (entries > FROZEN_RUNTIME_LIMIT_PROFILE.fileTreeEntries) {
      throw new Error("estimate entry limit exceeded");
    }
    bytes += st.size;
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    }
  };
  try {
    const before = lstatSync(root);
    if (!before.isDirectory() || !sameFilesystemIdentity(before, expectedIdentity)) return null;
    visit(root);
    const after = lstatSync(root);
    if (!sameFilesystemIdentity(after, expectedIdentity)) return null;
    return bytes;
  } catch {
    return null;
  }
};
