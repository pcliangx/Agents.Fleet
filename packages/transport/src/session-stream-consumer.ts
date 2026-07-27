// RT-ORDER-05/06 — reader-side Snapshot + delta ordering seam.
//
// The consumer applies only frames from its bound Attachment identity, skips
// overlap already covered by the Snapshot/current cursor, and stops at the
// first gap. It never advances over missing bytes; the caller must request a
// new Snapshot before applying more delta.

import type {
  AttachmentId,
  AttachResult,
  Generation,
  Seq,
  SessionDeltaBatch,
  SessionId,
  SessionStreamFrame,
} from "@agents-fleet/contracts";

export interface SessionStreamConsumer {
  readonly attachmentId: AttachmentId;
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly appliedSeq: Seq;
  readonly expectedSeq: Seq;
  readonly resnapshotRequired: boolean;
}

export interface ApplySessionDeltaResult {
  readonly state: SessionStreamConsumer;
  readonly appliedFrames: readonly SessionStreamFrame[];
  readonly duplicateFrames: number;
}

export const createSessionStreamConsumer = (attached: AttachResult): SessionStreamConsumer => ({
  attachmentId: attached.attachmentId,
  sessionId: attached.sessionId,
  generation: attached.generation,
  appliedSeq: attached.snapshot.coversThroughSeq,
  expectedSeq: ((attached.snapshot.coversThroughSeq as number) + 1) as Seq,
  resnapshotRequired: false,
});

export const applySessionDelta = (
  state: SessionStreamConsumer,
  batch: SessionDeltaBatch,
): ApplySessionDeltaResult => {
  if (state.resnapshotRequired) {
    return { state, appliedFrames: [], duplicateFrames: 0 };
  }
  if (
    batch.attachmentId !== state.attachmentId ||
    batch.sessionId !== state.sessionId ||
    batch.generation !== state.generation
  ) {
    return {
      state: { ...state, resnapshotRequired: true },
      appliedFrames: [],
      duplicateFrames: 0,
    };
  }

  const appliedFrames: SessionStreamFrame[] = [];
  let duplicateFrames = 0;
  let appliedSeq = state.appliedSeq as number;
  let resnapshotRequired = false;
  for (const frame of batch.frames) {
    if (
      frame.header.sessionId !== state.sessionId ||
      frame.header.generation !== state.generation
    ) {
      resnapshotRequired = true;
      break;
    }
    const frameSeq = frame.header.seq as number;
    if (frameSeq <= appliedSeq) {
      duplicateFrames += 1;
      continue;
    }
    if (frameSeq !== appliedSeq + 1) {
      resnapshotRequired = true;
      break;
    }
    appliedFrames.push(frame);
    appliedSeq = frameSeq;
  }

  return {
    state: {
      ...state,
      appliedSeq: appliedSeq as Seq,
      expectedSeq: (appliedSeq + 1) as Seq,
      resnapshotRequired,
    },
    appliedFrames,
    duplicateFrames,
  };
};
