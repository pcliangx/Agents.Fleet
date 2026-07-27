// RT-MOD-04 — Worktree Manager Module Interface.
//
// Callers see bounded, stable provision / inspect / dispose results. Git
// commands, common Git directory access, FileBroker handles and filesystem
// traversal stay private to the Daemon Implementation.

import type { AttemptId, CommandId, SessionId, TaskId, WorktreeId } from "../identity.js";
import type { ProcessDisposition } from "../lifecycle/process-disposition.js";
import type { FilesystemIdentity, WorktreeRole, WorktreeState } from "../lifecycle/worktree.js";

export type GitChangeStatus =
  | "Added"
  | "Copied"
  | "Deleted"
  | "Modified"
  | "Renamed"
  | "TypeChanged"
  | "Unmerged";

export interface GitChange {
  readonly path: string;
  readonly status: GitChangeStatus;
}

export type WorktreeEntryType = "file" | "symlink";

export interface UntrackedEntry {
  readonly path: string;
  readonly type: WorktreeEntryType;
  /** SHA-256 of regular-file bytes or symlink target bytes. */
  readonly contentHash: string;
  readonly bytes: number;
}

export interface GitObservation {
  readonly worktreeId: WorktreeId;
  readonly worktreeIdentity: FilesystemIdentity;
  readonly headSha: string;
  readonly baseSha: string;
  readonly comparisonRef: string | null;
  readonly comparisonSha: string | null;
  readonly stateFingerprint: string;
  readonly observedAt: string;
  readonly refSource: "LocalOnly";
  readonly refFreshness: "LocalObservationOnly";
  readonly staged: readonly GitChange[];
  readonly unstaged: readonly GitChange[];
  readonly untracked: readonly UntrackedEntry[];
}

export type FingerprintBlockerReason =
  | "file-count-limit"
  | "byte-limit"
  | "duration-limit"
  | "unsupported-entry"
  | "read-failed";

export interface FingerprintBlocker {
  readonly reason: FingerprintBlockerReason;
  readonly detail: string;
  readonly filesObserved: number;
  readonly bytesObserved: number;
}

export interface WorktreeDiffView {
  readonly staged: string;
  readonly unstaged: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly totalBytesAtLeast: number;
}

export interface WorktreeAliveSessionObservation {
  readonly sessionId: SessionId;
  readonly attemptId: AttemptId;
  readonly observedAt: string;
}

export interface WorktreeProcessDispositionObservation {
  readonly attemptId: AttemptId;
  readonly disposition: ProcessDisposition;
  readonly observedAt: string;
}

export type DisposeBlockerKind =
  | "not-ready"
  | "nonterminal-attempt"
  | "alive-session"
  | "pending-process-disposition"
  | "dirty"
  | "unmerged-commit"
  | "identity-drift"
  | "target-missing"
  | "target-drift"
  | "fingerprint-incomplete"
  | "state-changed"
  | "externally-occupied"
  | "branch-delete-requested"
  | "reclaim-estimate-incomplete";

export interface DisposeBlocker {
  readonly kind: DisposeBlockerKind;
  readonly detail: string;
  readonly relatedAttemptIds: readonly string[];
  readonly relatedSessionIds: readonly SessionId[];
}

export interface WorktreeInspection {
  readonly worktreeId: WorktreeId;
  readonly taskId: TaskId;
  readonly state: WorktreeState;
  readonly role: WorktreeRole;
  readonly canonicalPath: string;
  readonly filesystemIdentity: FilesystemIdentity;
  readonly branchName: string | null;
  readonly detached: boolean;
  readonly headSha: string;
  readonly baseSha: string;
  readonly comparisonRef: string | null;
  readonly comparisonSha: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly observedAt: string;
  readonly refFreshness: "LocalObservationOnly";
  readonly diff: WorktreeDiffView;
  /** Null means fingerprintBlocker is present; never a partial fingerprint. */
  readonly gitObservation: GitObservation | null;
  readonly fingerprintBlocker: FingerprintBlocker | null;
  readonly aliveSessions: readonly WorktreeAliveSessionObservation[];
  readonly processDispositions: readonly WorktreeProcessDispositionObservation[];
  readonly disposeBlockers: readonly DisposeBlocker[];
}

export interface IntegrationTarget {
  /** Local ref shown in preview; null when the user selected a raw commit SHA. */
  readonly ref: string | null;
  readonly sha: string;
}

export interface DisposePreview {
  readonly worktreeId: WorktreeId;
  readonly stateVersion: number;
  readonly canonicalPath: string;
  readonly filesystemIdentity: FilesystemIdentity;
  readonly stateFingerprint: string | null;
  readonly integrationTarget: IntegrationTarget;
  readonly preservedBranch: string | null;
  readonly relatedTaskIds: readonly TaskId[];
  readonly relatedSessionIds: readonly SessionId[];
  readonly estimatedReclaimBytes: number | null;
  readonly observedAt: string;
  readonly blockers: readonly DisposeBlocker[];
}

export type WorktreeManagerFailureKind =
  | "InvalidRequest"
  | "NotFound"
  | "Conflict"
  | "CapabilityUnavailable"
  | "IdentityDrift"
  | "FingerprintIncomplete"
  | "GitFailure";

export interface WorktreeManagerFailure {
  readonly kind: WorktreeManagerFailureKind;
  readonly detail: string;
}

export type ProvisionWorktreeResult =
  | {
      readonly ok: true;
      readonly worktreeId: WorktreeId;
      readonly state: "Ready";
      readonly role: "Active" | "Historical";
      readonly filesystemIdentity: FilesystemIdentity;
      readonly observedAt: string;
    }
  | {
      readonly ok: false;
      readonly worktreeId: WorktreeId;
      readonly state: "Failed" | "Orphaned";
      readonly failure: WorktreeManagerFailure;
    };

export type InspectWorktreeResult =
  | { readonly ok: true; readonly inspection: WorktreeInspection }
  | { readonly ok: false; readonly failure: WorktreeManagerFailure };

export type DisposePreviewResult =
  | { readonly ok: true; readonly preview: DisposePreview }
  | { readonly ok: false; readonly failure: WorktreeManagerFailure };

export type DisposeWorktreeResult =
  | {
      readonly ok: true;
      readonly worktreeId: WorktreeId;
      readonly state: "Disposed";
      readonly preservedBranch: string | null;
      readonly disposedAt: string;
    }
  | {
      readonly ok: false;
      readonly worktreeId: WorktreeId;
      readonly blockers: readonly DisposeBlocker[];
    };

export interface WorktreeManager {
  provision(input: {
    readonly commandId: CommandId;
    readonly worktreeId: WorktreeId;
  }): Promise<ProvisionWorktreeResult>;

  inspect(input: {
    readonly worktreeId: WorktreeId;
    readonly comparison?: IntegrationTarget;
  }): Promise<InspectWorktreeResult>;

  previewDispose(input: {
    readonly worktreeId: WorktreeId;
    readonly integrationTarget: IntegrationTarget;
  }): Promise<DisposePreviewResult>;

  dispose(input: {
    readonly commandId: CommandId;
    readonly worktreeId: WorktreeId;
    readonly expectedStateVersion: number;
    readonly expectedFilesystemIdentity: FilesystemIdentity;
    readonly expectedStateFingerprint: string;
    readonly integrationTarget: IntegrationTarget;
    /** v1 exposes preserve only; branch deletion requests fail closed. */
    readonly branchDisposition: "preserve";
  }): Promise<DisposeWorktreeResult>;
}
