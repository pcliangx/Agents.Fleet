// PROTOTYPE — R0-06 Binary stream throughput and backpressure.
//
// Question: can a per-Attachment bounded live queue move a slow or hidden
// consumer onto an explicit Snapshot + delta resync path without blocking
// durable ingestion or another Session? This model assumes bytes are already
// durable. It makes no chunk-store or crash-recovery claim.

import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";

export type ResyncReason = "QueueLimit" | "Hidden" | "SequenceGap";

export interface QueueLimits {
  readonly bytes: number;
  readonly frames: number;
}

export interface QueuedFrame {
  readonly header: StreamFrameHeader;
  readonly payloadBytes: number;
  readonly wireBytes: number;
}

export interface AttachmentFlowState {
  readonly sessionId: SessionId;
  readonly generation: Generation;
  readonly limits: QueueLimits;
  readonly hidden: boolean;
  readonly durableSeq: Seq;
  readonly durablePayloadBytes: number;
  readonly appliedSeq: Seq;
  readonly appliedPayloadBytes: number;
  readonly queue: readonly QueuedFrame[];
  readonly queueBytes: number;
  readonly peakQueueBytes: number;
  readonly peakQueueFrames: number;
  readonly resyncRequired: boolean;
  readonly resyncReason: ResyncReason | null;
  readonly resyncCount: number;
  readonly backpressureEvents: number;
  readonly deferredLiveFrames: number;
  readonly identityErrors: number;
  readonly sequenceErrors: number;
}

const seq = (value: number): Seq => value as Seq;

export const createAttachmentFlowState = (
  sessionId: SessionId,
  generation: Generation,
  limits: QueueLimits,
): AttachmentFlowState => ({
  sessionId,
  generation,
  limits,
  hidden: false,
  durableSeq: seq(0),
  durablePayloadBytes: 0,
  appliedSeq: seq(0),
  appliedPayloadBytes: 0,
  queue: [],
  queueBytes: 0,
  peakQueueBytes: 0,
  peakQueueFrames: 0,
  resyncRequired: false,
  resyncReason: null,
  resyncCount: 0,
  backpressureEvents: 0,
  deferredLiveFrames: 0,
  identityErrors: 0,
  sequenceErrors: 0,
});

export const ingestDurableFrame = (
  state: AttachmentFlowState,
  frame: QueuedFrame,
): AttachmentFlowState => {
  if (frame.header.sessionId !== state.sessionId || frame.header.generation !== state.generation) {
    return { ...state, identityErrors: state.identityErrors + 1 };
  }

  const expectedSeq = (state.durableSeq as number) + 1;
  if (frame.header.seq !== expectedSeq) {
    return {
      ...state,
      resyncRequired: true,
      resyncReason: "SequenceGap",
      sequenceErrors: state.sequenceErrors + 1,
    };
  }

  const durable = {
    durableSeq: frame.header.seq,
    durablePayloadBytes: state.durablePayloadBytes + frame.payloadBytes,
  };

  if (state.hidden || state.resyncRequired) {
    return {
      ...state,
      ...durable,
      resyncRequired: true,
      resyncReason: state.resyncReason ?? "Hidden",
      deferredLiveFrames: state.deferredLiveFrames + 1,
    };
  }

  const nextQueueBytes = state.queueBytes + frame.wireBytes;
  const nextQueueFrames = state.queue.length + 1;
  if (nextQueueBytes > state.limits.bytes || nextQueueFrames > state.limits.frames) {
    return {
      ...state,
      ...durable,
      queue: [],
      queueBytes: 0,
      resyncRequired: true,
      resyncReason: "QueueLimit",
      backpressureEvents: state.backpressureEvents + 1,
      deferredLiveFrames: state.deferredLiveFrames + state.queue.length + 1,
    };
  }

  return {
    ...state,
    ...durable,
    queue: [...state.queue, frame],
    queueBytes: nextQueueBytes,
    peakQueueBytes: Math.max(state.peakQueueBytes, nextQueueBytes),
    peakQueueFrames: Math.max(state.peakQueueFrames, nextQueueFrames),
  };
};

export interface ConsumeResult {
  readonly state: AttachmentFlowState;
  readonly consumedWireBytes: number;
}

export const consumeQueuedFrames = (
  state: AttachmentFlowState,
  wireByteBudget: number,
): ConsumeResult => {
  if (state.hidden || state.resyncRequired || state.queue.length === 0) {
    return { state, consumedWireBytes: 0 };
  }

  let consumedFrames = 0;
  let consumedWireBytes = 0;
  let consumedPayloadBytes = 0;
  let appliedSeq = state.appliedSeq;

  for (const frame of state.queue) {
    if (consumedWireBytes + frame.wireBytes > wireByteBudget) break;
    consumedFrames += 1;
    consumedWireBytes += frame.wireBytes;
    consumedPayloadBytes += frame.payloadBytes;
    appliedSeq = frame.header.seq;
  }

  if (consumedFrames === 0) return { state, consumedWireBytes: 0 };

  return {
    state: {
      ...state,
      appliedSeq,
      appliedPayloadBytes: state.appliedPayloadBytes + consumedPayloadBytes,
      queue: state.queue.slice(consumedFrames),
      queueBytes: state.queueBytes - consumedWireBytes,
    },
    consumedWireBytes,
  };
};

export const setAttachmentHidden = (
  state: AttachmentFlowState,
  hidden: boolean,
): AttachmentFlowState => {
  if (hidden === state.hidden) return state;
  if (!hidden) return { ...state, hidden: false };

  const hasUnappliedFrames =
    state.queue.length > 0 || (state.durableSeq as number) > (state.appliedSeq as number);
  return {
    ...state,
    hidden: true,
    queue: [],
    queueBytes: 0,
    resyncRequired: state.resyncRequired || hasUnappliedFrames,
    resyncReason: state.resyncReason ?? (hasUnappliedFrames ? "Hidden" : null),
    deferredLiveFrames: state.deferredLiveFrames + state.queue.length,
  };
};

export const resyncAtDurableHead = (state: AttachmentFlowState): AttachmentFlowState => {
  if (state.hidden || !state.resyncRequired) return state;
  return {
    ...state,
    appliedSeq: state.durableSeq,
    appliedPayloadBytes: state.durablePayloadBytes,
    queue: [],
    queueBytes: 0,
    resyncRequired: false,
    resyncReason: null,
    resyncCount: state.resyncCount + 1,
  };
};

export const summarizeAttachmentFlow = (state: AttachmentFlowState): object => ({
  sessionId: state.sessionId,
  hidden: state.hidden,
  durableSeq: state.durableSeq,
  appliedSeq: state.appliedSeq,
  queueBytes: state.queueBytes,
  queueFrames: state.queue.length,
  peakQueueBytes: state.peakQueueBytes,
  peakQueueFrames: state.peakQueueFrames,
  resyncRequired: state.resyncRequired,
  resyncReason: state.resyncReason,
  resyncCount: state.resyncCount,
  backpressureEvents: state.backpressureEvents,
  deferredLiveFrames: state.deferredLiveFrames,
  identityErrors: state.identityErrors,
  sequenceErrors: state.sequenceErrors,
});
