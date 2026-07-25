import type { Seq } from "@agents-fleet/contracts";
import {
  type AttachmentFlowState,
  type QueuedFrame,
  type RecoveryResult,
  recoverFromSnapshotAndDelta,
} from "./model.js";

export interface SnapshotDeltaRecoveryEvidence {
  readonly method: "SnapshotPlusDelta";
  readonly snapshotCoversThroughSeq: Seq;
  readonly deltaFrames: number;
  readonly suppliedDeltaFrames: number;
  readonly duplicateDeltaFrames: number;
}

export interface SnapshotDeltaRecovery {
  readonly result: RecoveryResult;
  readonly evidence: SnapshotDeltaRecoveryEvidence;
}

export const recoverUsingRecentDurableFrames = (
  state: AttachmentFlowState,
  recentFrames: readonly QueuedFrame[],
): SnapshotDeltaRecovery => {
  const contiguousDelta = recentFrames.slice(-2);
  const deltaPayloadBytes = contiguousDelta.reduce((total, frame) => total + frame.payloadBytes, 0);
  const snapshotCoversThroughSeq = ((state.durableSeq as number) - contiguousDelta.length) as Seq;
  const overlap = recentFrames.find((frame) => frame.header.seq === snapshotCoversThroughSeq);
  const suppliedDelta = overlap === undefined ? contiguousDelta : [overlap, ...contiguousDelta];
  const result = recoverFromSnapshotAndDelta(
    state,
    {
      sessionId: state.sessionId,
      generation: state.generation,
      coversThroughSeq: snapshotCoversThroughSeq,
      payloadBytesThroughSeq: state.durablePayloadBytes - deltaPayloadBytes,
    },
    suppliedDelta,
  );

  return {
    result,
    evidence: {
      method: "SnapshotPlusDelta",
      snapshotCoversThroughSeq,
      deltaFrames: contiguousDelta.length,
      suppliedDeltaFrames: suppliedDelta.length,
      duplicateDeltaFrames: result.ok ? result.duplicateDeltaFrames : 0,
    },
  };
};
