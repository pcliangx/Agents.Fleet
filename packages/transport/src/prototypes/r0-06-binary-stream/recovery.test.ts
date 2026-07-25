import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { createAttachmentFlowState, ingestDurableFrame, type QueuedFrame } from "./model.js";
import { recoverUsingRecentDurableFrames } from "./recovery.js";

const sessionId = "recent-recovery-session" as SessionId;
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

describe("R0-06 recent durable recovery orchestration", () => {
  it("constructs a real Snapshot cursor plus contiguous overlapping delta", () => {
    let state = createAttachmentFlowState(sessionId, generation, { bytes: 1_000, frames: 2 });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      state = ingestDurableFrame(state, frame(sequence));
    }

    const recovered = recoverUsingRecentDurableFrames(state, [frame(2), frame(3), frame(4)]);

    expect(recovered).toMatchObject({
      result: {
        ok: true,
        duplicateDeltaFrames: 1,
        state: { appliedSeq: 4, appliedPayloadBytes: 40 },
      },
      evidence: {
        method: "SnapshotPlusDelta",
        snapshotCoversThroughSeq: 2,
        deltaFrames: 2,
        suppliedDeltaFrames: 3,
        duplicateDeltaFrames: 1,
      },
    });
  });
});
