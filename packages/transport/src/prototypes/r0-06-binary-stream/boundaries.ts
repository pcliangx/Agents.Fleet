import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import {
  type AttachmentFlowState,
  createAttachmentFlowState,
  ingestDurableFrame,
  type QueueLimits,
} from "./model.js";

const generation = 1 as Generation;

const ingestFrame = (state: AttachmentFlowState, wireBytes: number): AttachmentFlowState =>
  ingestDurableFrame(state, {
    header: {
      frameType: "output",
      sessionId: state.sessionId,
      generation: state.generation,
      seq: ((state.durableSeq as number) + 1) as Seq,
      payloadLength: 1,
    },
    payloadBytes: 1,
    wireBytes,
  });

const byteBoundary = (wireBytes: number, limits: QueueLimits): AttachmentFlowState =>
  ingestFrame(
    createAttachmentFlowState("r0-06-byte-boundary" as SessionId, generation, limits),
    wireBytes,
  );

export interface QueueBoundaryProbeResult {
  readonly byteCap: {
    readonly limitMinusOne: { readonly queueBytes: number; readonly resyncRequired: boolean };
    readonly limit: { readonly queueBytes: number; readonly resyncRequired: boolean };
    readonly limitPlusOne: { readonly queueBytes: number; readonly resyncRequired: boolean };
  };
  readonly frameCap: {
    readonly limitMinusOne: { readonly queueFrames: number; readonly resyncRequired: boolean };
    readonly limit: { readonly queueFrames: number; readonly resyncRequired: boolean };
    readonly limitPlusOne: { readonly queueFrames: number; readonly resyncRequired: boolean };
  };
}

export const runQueueBoundaryProbes = (limits: QueueLimits): QueueBoundaryProbeResult => {
  const byteLimitMinusOne = byteBoundary(limits.bytes - 1, limits);
  const byteLimit = byteBoundary(limits.bytes, limits);
  const byteLimitPlusOne = byteBoundary(limits.bytes + 1, limits);

  let frameState = createAttachmentFlowState("r0-06-frame-boundary" as SessionId, generation, {
    bytes: Number.MAX_SAFE_INTEGER,
    frames: limits.frames,
  });
  for (let count = 0; count < limits.frames - 1; count += 1) {
    frameState = ingestFrame(frameState, 1);
  }
  const frameLimitMinusOne = frameState;
  frameState = ingestFrame(frameState, 1);
  const frameLimit = frameState;
  frameState = ingestFrame(frameState, 1);
  const frameLimitPlusOne = frameState;

  return {
    byteCap: {
      limitMinusOne: {
        queueBytes: byteLimitMinusOne.queueBytes,
        resyncRequired: byteLimitMinusOne.resyncRequired,
      },
      limit: {
        queueBytes: byteLimit.queueBytes,
        resyncRequired: byteLimit.resyncRequired,
      },
      limitPlusOne: {
        queueBytes: byteLimitPlusOne.queueBytes,
        resyncRequired: byteLimitPlusOne.resyncRequired,
      },
    },
    frameCap: {
      limitMinusOne: {
        queueFrames: frameLimitMinusOne.queue.length,
        resyncRequired: frameLimitMinusOne.resyncRequired,
      },
      limit: {
        queueFrames: frameLimit.queue.length,
        resyncRequired: frameLimit.resyncRequired,
      },
      limitPlusOne: {
        queueFrames: frameLimitPlusOne.queue.length,
        resyncRequired: frameLimitPlusOne.resyncRequired,
      },
    },
  };
};
