// RT-STREAM-04 / RT-LEASE-09 / RT-INPUT / RT-ORDER — session stream + attach/lease + input.

import type {
  AttachmentId,
  CommandId,
  FencingToken,
  Generation,
  Seq,
  SessionId,
} from "../identity.js";
import type { AttachmentMode } from "../lifecycle/attachment.js";

// RT-STREAM-02 — length-prefixed binary frame; PTY bytes stay binary (no JSON escape).
// frameType is left as a string union to be enumerated by later tickets; the
// skeleton only needs the header shape.
export type FrameType = string;

// RT-STREAM-04
export interface StreamFrameHeader {
  readonly frameType: FrameType;
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly seq: Seq;
  readonly payloadLength: number;
}

// RT-STREAM-04 — resumption cursor.
export interface SessionStreamCursor {
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly seq: Seq;
}

export interface SessionStreamFrame {
  readonly header: StreamFrameHeader;
  readonly bytes: Uint8Array;
}

export interface SessionDeltaBatch {
  readonly attachmentId: AttachmentId;
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly durableThroughSeq: Seq;
  readonly nextSeq: Seq;
  readonly frames: readonly SessionStreamFrame[];
}

// RT-ORDER-04 / RT-ORDER-08 — Snapshot declares coversThroughSeq at a safe checkpoint.
export interface Snapshot {
  readonly coversThroughSeq: Seq;
  readonly bytes: Uint8Array; // app-owned, versioned serialization (RT-TERM-07)
}

// RT-LEASE-09 — attach returns an observe-only Active attachment (no fencing token).
export interface AttachResult {
  readonly attachmentId: AttachmentId;
  readonly mode: AttachmentMode;
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly snapshot: Snapshot;
}

// RT-LEASE-09 — ControlLease returned only by AcquireControl.
export interface ControlLease {
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly attachmentId: AttachmentId;
  readonly fencingToken: FencingToken;
  readonly expiresAt: number; // epoch ms
}

// RT-INPUT — input is an Observation, not a fake delivery ack.
export type InputSource = "Keyboard" | "IME" | "Paste" | "Mouse" | "Automation";
export type InputIntentStatus = "Prepared" | "Dispatched" | "Uncertain";

export interface InputIntent {
  readonly inputIntentId: string;
  readonly commandId: CommandId;
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly attachmentId: AttachmentId;
  readonly fencingToken: FencingToken;
  readonly source: InputSource;
  readonly byteLength: number;
  readonly contentRef: string; // sensitive local data; logs/timeline hold only redacted preview
  readonly createdAt: number;
  readonly status: InputIntentStatus;
}
