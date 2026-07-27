// RT-CMD-09 — command envelope, plus the CommandKind union + payload map (D7).
// Each command's authoritative target and required identity are encoded per
// RT-CMD-10..18; payloads are fleshed out by the tickets that implement them.

import type {
  AttachmentId,
  AttemptId,
  CommandId,
  FencingToken,
  Generation,
  Receipt,
  SessionId,
  TaskId,
  WorkspaceId,
} from "../identity.js";
import type { ConfirmationReceipt } from "./confirmation.js";

export interface CommandEnvelope<P = unknown> {
  readonly commandId: CommandId;
  readonly schemaVersion: number;
  readonly workspaceId: WorkspaceId | undefined;
  readonly taskId: TaskId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly sessionId: SessionId | undefined;
  readonly expectedStateVersion: number | undefined;
  readonly expectedGeneration: Generation | undefined;
  readonly attachmentId: AttachmentId | undefined;
  readonly fencingToken: FencingToken | undefined;
  readonly confirmationReceipt: Receipt | undefined;
  // RT-REPO-06 — the Main-signed one-time repository-trust receipt is a
  // structured object (challengeId + proof + confirmedAt), not a bare string.
  readonly repositoryTrustReceipt: ConfirmationReceipt | undefined;
  readonly launchConfirmationReceipt: Receipt | undefined;
  readonly payload: P;
}

// RT-CMD-10..18, RT-CMD-03 — the command vocabulary.
export type CommandKind =
  | "Start"
  | "Retry"
  | "Resume"
  | "RequestAttemptStop"
  | "CancelTask"
  | "TerminateSession"
  | "WriteSessionInput"
  | "ResizeSession"
  | "AcquireControl"
  | "Attach"
  | "DisposeWorktree"
  // R1-02 — Repository Trust production chain (RT-REPO-01..06).
  | "PrepareTrustCandidate"
  | "IssueRepositoryTrustChallenge"
  | "ConfirmRepositoryTrust"
  | "ValidateAndActivateTrust"
  | "RevokeRepositoryTrust"
  | "InspectRepositoryTrust"
  | "GetConfirmationChallenge";

// Minimal payload shapes for the commands #1 needs to route. Later tickets
// expand each. WriteSessionInput/ResizeSession/TerminateSession require the
// RT-CMD-04 identity triple (attachment + generation + fencing token).
export interface WriteSessionInputPayload {
  readonly bytes: Uint8Array;
}

export interface ResizeSessionPayload {
  readonly cols: number;
  readonly rows: number;
}

export interface AttachPayload {
  readonly sessionId: SessionId;
  readonly fromSeq: number | undefined;
}

export type EmptyPayload = Record<string, never>;

// R1-02 — Repository Trust payloads (RT-REPO-01..06). On the wire the payload
// object additionally carries the CommandKind as a `kind` discriminator (the
// Control Dispatcher routes on `payload.kind`); the types below are the
// command-specific fields only.
//
// RT-REPO-01 — the pre-Trust candidate identity: canonical path + filesystem
// identity (dev/ino). Structurally identical to the daemon's
// RepositoryCandidate; duplicated here because contracts is dependency-free.
export interface RepositoryCandidatePayload {
  readonly canonicalRoot: string;
  readonly filesystemIdentity: { readonly dev: number; readonly ino: number };
}

export interface PrepareTrustCandidatePayload {
  readonly path: string;
}

// RT-REPO-06 — issue the one-time Trust challenge. The plannedAgent /
// dataLocation / hostPermissionUpperBound fields are display-only dialog text
// (SV1-TRUST-02); the receipt binds candidate identity + user identity + the
// frozen validation plan.
export interface IssueRepositoryTrustChallengePayload {
  readonly candidate: RepositoryCandidatePayload;
  readonly userIdentity: string;
  readonly plannedAgent: string;
  readonly dataLocation: string;
  readonly hostPermissionUpperBound: string;
}

// RT-REPO-06 — consumes the Main-signed receipt carried on the envelope's
// `repositoryTrustReceipt` field and enters PendingValidation.
export interface ConfirmRepositoryTrustPayload {
  readonly candidate: RepositoryCandidatePayload;
  readonly userIdentity: string;
}

export interface ValidateAndActivateTrustPayload {
  readonly trustId: string;
}

// SV1-TRUST-05 — when non-terminal Attempts exist the user's explicit
// stop-or-keep choice is required.
export interface RevokeRepositoryTrustPayload {
  readonly trustId: string;
  readonly runningProcessChoice?: "stop" | "keep";
}

// RT-REPO-04 — Active-only declared read-only inspection (SV1-FILE-06).
export interface InspectRepositoryTrustPayload {
  readonly workspaceId: string;
}

// SV1-AUTH-10 — Main fetches an already-issued challenge to render its fixed
// display fields; the Renderer can only name the challenge ID.
export interface GetConfirmationChallengePayload {
  readonly challengeId: string;
}

// Maps a CommandKind to its payload type. Unspecified kinds use EmptyPayload.
export interface CommandPayloadMap {
  readonly Start: unknown;
  readonly Retry: unknown;
  readonly Resume: unknown;
  readonly RequestAttemptStop: EmptyPayload;
  readonly CancelTask: EmptyPayload;
  readonly TerminateSession: EmptyPayload;
  readonly WriteSessionInput: WriteSessionInputPayload;
  readonly ResizeSession: ResizeSessionPayload;
  readonly AcquireControl: EmptyPayload;
  readonly Attach: AttachPayload;
  readonly DisposeWorktree: EmptyPayload;
  readonly PrepareTrustCandidate: PrepareTrustCandidatePayload;
  readonly IssueRepositoryTrustChallenge: IssueRepositoryTrustChallengePayload;
  readonly ConfirmRepositoryTrust: ConfirmRepositoryTrustPayload;
  readonly ValidateAndActivateTrust: ValidateAndActivateTrustPayload;
  readonly RevokeRepositoryTrust: RevokeRepositoryTrustPayload;
  readonly InspectRepositoryTrust: InspectRepositoryTrustPayload;
  readonly GetConfirmationChallenge: GetConfirmationChallengePayload;
}

export type PayloadFor<K extends CommandKind> = CommandPayloadMap[K];
export type TypedCommandEnvelope<K extends CommandKind> = CommandEnvelope<PayloadFor<K>>;
