import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "../../binary-frame.js";
import { createAttachmentFlowState } from "./model.js";
import { createMultiplexRouter, routeBinaryFrame } from "./router.js";

const generation = 1 as Generation;
const sessionA = "router-a" as SessionId;
const sessionB = "router-b" as SessionId;

const encodedFrame = (
  sessionId: SessionId,
  sequence: number,
  payloadMarker: number,
): Uint8Array => {
  const payload = new Uint8Array([payloadMarker, 42]);
  const header: StreamFrameHeader = {
    frameType: "output",
    sessionId,
    generation,
    seq: sequence as Seq,
    payloadLength: payload.byteLength,
  };
  return encodeFrame(header, payload);
};

describe("R0-06 multiplex routing", () => {
  it("routes interleaved Sessions by header and detects a payload identity canary", () => {
    let router = createMultiplexRouter([
      {
        state: createAttachmentFlowState(sessionA, generation, { bytes: 1_000, frames: 10 }),
        expectedPayloadMarker: 10,
      },
      {
        state: createAttachmentFlowState(sessionB, generation, { bytes: 1_000, frames: 10 }),
        expectedPayloadMarker: 20,
      },
    ]);

    for (const wire of [
      encodedFrame(sessionB, 1, 20),
      encodedFrame(sessionA, 1, 10),
      encodedFrame(sessionB, 2, 20),
    ]) {
      router = routeBinaryFrame(router, decodeFrame(wire), wire).router;
    }

    expect(router.routes.get(sessionA)?.state.durableSeq).toBe(1);
    expect(router.routes.get(sessionB)?.state.durableSeq).toBe(2);
    expect(router.crossSessionFrames).toBe(0);

    const canary = encodedFrame(sessionA, 2, 20);
    const detected = routeBinaryFrame(router, decodeFrame(canary), canary);
    expect(detected.accepted).toBe(false);
    expect(detected.router.crossSessionFrames).toBe(1);
    expect(detected.router.routes.get(sessionA)?.state.durableSeq).toBe(1);
  });
});
