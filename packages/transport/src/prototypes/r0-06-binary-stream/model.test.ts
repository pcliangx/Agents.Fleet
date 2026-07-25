import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import {
  createAttachmentFlowState,
  ingestDurableFrame,
  type QueuedFrame,
  recoverFromSnapshotAndDelta,
} from "./model.js";

const sessionId = "recovery-session" as SessionId;
const generation = 1 as Generation;

const frame = (sequence: number): QueuedFrame => {
  const header: StreamFrameHeader = {
    frameType: "output",
    sessionId,
    generation,
    seq: sequence as Seq,
    payloadLength: 10,
  };
  return { header, payloadBytes: 10, wireBytes: 20 };
};

describe("R0-06 Snapshot + delta recovery", () => {
  it("applies a Snapshot cursor, deduplicates overlap, and requires contiguous delta", () => {
    let state = createAttachmentFlowState(sessionId, generation, {
      bytes: 1_000,
      frames: 2,
    });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      state = ingestDurableFrame(state, frame(sequence));
    }
    expect(state.resyncRequired).toBe(true);

    const recovered = recoverFromSnapshotAndDelta(
      state,
      {
        sessionId,
        generation,
        coversThroughSeq: 2 as Seq,
        payloadBytesThroughSeq: 20,
      },
      [frame(2), frame(3), frame(4)],
    );

    expect(recovered).toMatchObject({
      ok: true,
      duplicateDeltaFrames: 1,
      state: {
        appliedSeq: 4,
        appliedPayloadBytes: 40,
        resyncRequired: false,
        resyncCount: 1,
      },
    });
  });

  it("fails closed when the delta has a gap", () => {
    let state = createAttachmentFlowState(sessionId, generation, {
      bytes: 1_000,
      frames: 2,
    });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      state = ingestDurableFrame(state, frame(sequence));
    }

    const recovered = recoverFromSnapshotAndDelta(
      state,
      {
        sessionId,
        generation,
        coversThroughSeq: 2 as Seq,
        payloadBytesThroughSeq: 20,
      },
      [frame(4)],
    );

    expect(recovered).toEqual({ ok: false, state, code: "MissingDelta" });
  });

  it("rejects a Snapshot from another Session", () => {
    let state = createAttachmentFlowState(sessionId, generation, {
      bytes: 1_000,
      frames: 1,
    });
    state = ingestDurableFrame(state, frame(1));
    state = ingestDurableFrame(state, frame(2));

    const recovered = recoverFromSnapshotAndDelta(
      state,
      {
        sessionId: "other-session" as SessionId,
        generation,
        coversThroughSeq: 0 as Seq,
        payloadBytesThroughSeq: 0,
      },
      [frame(1), frame(2)],
    );

    expect(recovered).toEqual({ ok: false, state, code: "IdentityMismatch" });
  });
});
