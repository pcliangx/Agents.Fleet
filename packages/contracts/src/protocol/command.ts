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
  readonly repositoryTrustReceipt: Receipt | undefined;
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
  | "DisposeWorktree";

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
}

export type PayloadFor<K extends CommandKind> = CommandPayloadMap[K];
export type TypedCommandEnvelope<K extends CommandKind> = CommandEnvelope<PayloadFor<K>>;
