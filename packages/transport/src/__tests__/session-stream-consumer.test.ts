import type {
  AttachmentId,
  Generation,
  Seq,
  SessionDeltaBatch,
  SessionId,
} from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { applySessionDelta, createSessionStreamConsumer } from "../session-stream-consumer.js";

const sessionId = "session-1" as SessionId;
const generation = 1 as Generation;
const attachmentId = "attachment-1" as AttachmentId;
const frame = (seq: number, byte: number): SessionDeltaBatch["frames"][number] => ({
  header: {
    frameType: "PtyOutput",
    sessionId,
    generation,
    seq: seq as Seq,
    payloadLength: 1,
  },
  bytes: new Uint8Array([byte]),
});

describe("Session stream consumer seam (RT-ORDER-05/06)", () => {
  it("stops before a missing seq and requests a new Snapshot", () => {
    const initial = createSessionStreamConsumer({
      attachmentId,
      sessionId,
      generation,
      snapshot: {
        coversThroughSeq: 5 as Seq,
        bytes: new Uint8Array([0x73]),
      },
      mode: "Live",
    });
    const batch: SessionDeltaBatch = {
      attachmentId,
      sessionId,
      generation,
      durableThroughSeq: 8 as Seq,
      nextSeq: 9 as Seq,
      frames: [frame(5, 0x64), frame(6, 0x61), frame(8, 0x70)],
    };

    const applied = applySessionDelta(initial, batch);

    expect(applied.appliedFrames.map((item) => item.header.seq)).toEqual([6]);
    expect(applied.duplicateFrames).toBe(1);
    expect(applied.state).toMatchObject({
      appliedSeq: 6,
      resnapshotRequired: true,
      expectedSeq: 7,
    });
  });
});
