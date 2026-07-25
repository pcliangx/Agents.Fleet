import type { StreamFrameHeader } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "../binary-frame.js";

const header = (payloadLength: number): StreamFrameHeader => ({
  frameType: "output",
  sessionId: "s1" as never,
  generation: 1 as never,
  seq: 1 as never,
  payloadLength,
});

const bytes = (arr: readonly number[]): Uint8Array => new Uint8Array(arr);

describe("binary-frame (RT-STREAM-02 / RT-STREAM-04)", () => {
  it("round-trips arbitrary bytes byte-for-byte (NUL + invalid UTF-8)", () => {
    const payload = bytes([0x00, 0x00, 0xff, 0xfe, 0x41, 0xc3, 0x28]);
    const { header: h, payload: p } = decodeFrame(encodeFrame(header(payload.byteLength), payload));
    expect(h.payloadLength).toBe(payload.byteLength);
    expect(Array.from(p)).toEqual(Array.from(payload));
  });

  it("preserves a multibyte sequence even when split mid-way", () => {
    // 😀 = F0 9F 98 80; a trailing partial byte is still just bytes to the frame.
    const payload = bytes([0xf0, 0x9f, 0x98, 0x80, 0xf0]);
    const { payload: p } = decodeFrame(encodeFrame(header(payload.byteLength), payload));
    expect(Array.from(p)).toEqual(Array.from(payload));
  });

  it("rejects a truncated payload", () => {
    const full = encodeFrame(header(4), bytes([1, 2, 3, 4]));
    expect(() => decodeFrame(full.subarray(0, full.byteLength - 1))).toThrow();
  });
});
