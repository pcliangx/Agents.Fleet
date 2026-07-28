// RT-MOD-03 — Session Runtime public seam.
//
// ProcessSupervisor, ByteJournal, chunk paths, SQLite and PTY types are
// intentionally absent (RT-MOD-13).

import type { AttachmentMode, AttachmentStatus } from "../lifecycle/attachment.js";
import type { SessionAvailability } from "../lifecycle/session.js";
import type { ConfirmationChallenge, ConfirmationReceipt } from "../protocol/confirmation.js";
import type {
  AttachResult,
  ControlLease,
  InputIntent,
  InputSource,
  SessionDeltaBatch,
  Snapshot,
} from "../protocol/stream.js";
import type { PreparedLaunch } from "./task-orchestrator.js";

export type LaunchFailedReason =
  | "bootstrap-receipt-lost"
  | "bootstrap-lost-before-authorize"
  | "commit-never-sent-after-restart"
  | "launch-facts-drifted"
  | "launch-facts-unverifiable";

export type LaunchUncertainReason =
  | "agent-not-observed-after-commit"
  | "commit-delivery-unknown-after-restart";

export type LaunchSessionResult =
  | {
      readonly kind: "running";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly generation: number;
    }
  | { readonly kind: "failed"; readonly attemptId: string; readonly reason: LaunchFailedReason }
  | {
      readonly kind: "uncertain";
      readonly attemptId: string;
      readonly reason: LaunchUncertainReason;
    };

export interface LaunchValidation {
  readonly revalidate: () => Promise<boolean>;
}

export interface DurableFrameRef {
  readonly sessionId: string;
  readonly generation: number;
  readonly seq: number;
}

export interface SessionRuntimeRecord {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly availability: SessionAvailability;
}

export interface AttachmentRuntimeRecord {
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly status: AttachmentStatus;
  readonly mode: AttachmentMode;
}

export interface WriteSessionInputRequest {
  readonly commandId: string;
  readonly lease: ControlLease;
  readonly source: InputSource;
  readonly bytes: Uint8Array;
}

export interface ResizeSessionRequest {
  readonly lease: ControlLease;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminateSessionRequest {
  /** RT-CMD-16 — present on the routed production path and bound by the challenge. */
  readonly commandId?: string;
  readonly lease: ControlLease;
  readonly confirmationReceipt: ConfirmationReceipt;
}

export interface TakeoverControlRequest {
  readonly attachmentId: string;
  readonly confirmedHolder: ControlLease;
  readonly confirmationReceipt: ConfirmationReceipt;
}

export type ResumableAttemptStatus = "Starting" | "Running" | "Stopping";

export interface StoragePressureWait {
  readonly attemptId: string;
  readonly waitingReason: "StoragePressure";
  readonly resumeStatus: ResumableAttemptStatus;
}

export type RestartReconciliationAction =
  | {
      readonly action: "marked-lost";
      readonly attemptId: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "resume-prepared";
      readonly attemptId: string;
      readonly launchNonce: string;
      readonly preparedLaunch: PreparedLaunch;
    }
  | {
      readonly action: "aborted-before-commit";
      readonly attemptId: string;
      readonly launchNonce: string;
    }
  | {
      readonly action: "marked-uncertain";
      readonly attemptId: string;
      readonly launchNonce: string;
    }
  | {
      readonly action: "aborted-bootstrap-lost";
      readonly attemptId: string;
      readonly launchNonce: string;
    };

export interface RestartReconciliationReport {
  readonly actions: readonly RestartReconciliationAction[];
  readonly dataIntegrity: {
    readonly adoptedOrphanCount: number;
    readonly isolatedOrphanCount: number;
    readonly dataGapCount: number;
    readonly verifiedChunks: number;
    readonly uncertainInputIntentCount: number;
    readonly inputDataGapCount: number;
    readonly isolatedInputOrphanCount: number;
  };
}

export interface RebuiltSessionSnapshot {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly coversThroughSeq: number;
}

export interface SnapshotRebuildSkippedForDataGap {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly generation: number;
}

export interface RestartSnapshotRecoveryReport {
  readonly rebuilt: readonly RebuiltSessionSnapshot[];
  readonly skippedForDataGap: readonly SnapshotRebuildSkippedForDataGap[];
}

export interface SessionRuntime {
  launch(prepared: PreparedLaunch, validation: LaunchValidation): Promise<LaunchSessionResult>;
  attach(sessionId: string): AttachResult;
  acquireControl(attachmentId: string): ControlLease;
  renewControl(lease: ControlLease): ControlLease;
  issueTakeoverControlChallenge(
    attachmentId: string,
    confirmedHolder: ControlLease,
  ): ConfirmationChallenge;
  takeoverControl(request: TakeoverControlRequest): ControlLease;
  closeAttachment(attachmentId: string): void;
  invalidateAttachment(attachmentId: string): void;
  inspectAttachment(attachmentId: string): AttachmentRuntimeRecord | null;
  writeSessionInput(request: WriteSessionInputRequest): Promise<InputIntent>;
  inspectInputIntent(commandId: string): InputIntent | null;
  resizeSession(request: ResizeSessionRequest): Promise<void>;
  issueTerminateSessionChallenge(
    lease: ControlLease,
    targetCommandId?: string,
  ): ConfirmationChallenge;
  authorizeTerminateSession(request: TerminateSessionRequest): void;
  terminateSession(request: TerminateSessionRequest): Promise<void>;
  readSessionDelta(attachmentId: string, fromSeq: number): SessionDeltaBatch;
  createSessionSnapshot(sessionId: string): Promise<Snapshot>;
  readSessionSnapshot(sessionId: string): Snapshot;
  pauseForStoragePressure(attemptId: string): Promise<StoragePressureWait>;
  resumeFromStoragePressure(
    attemptId: string,
    validation: LaunchValidation,
  ): Promise<ResumableAttemptStatus>;
  terminate(sessionId: string): Promise<void>;
  inspectSession(sessionId: string): SessionRuntimeRecord | null;
  readDurableFrame(frame: DurableFrameRef): Uint8Array | null;
  reconcileAfterRestart(): RestartReconciliationReport;
  rebuildInvalidSnapshotsAfterRestart(): Promise<RestartSnapshotRecoveryReport>;
}
