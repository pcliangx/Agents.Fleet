import { encodeFrame } from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import type { AttachmentStream } from "./attachment-port-binding.js";
import { ReconnectingAttachmentStream } from "./reconnecting-attachment-stream.js";

class ControlledStream implements AttachmentStream {
  frame: ((bytes: Uint8Array) => void) | undefined;
  ended: (() => void) | undefined;
  closed = false;

  subscribe(frame: (bytes: Uint8Array) => void, ended: () => void): () => void {
    this.frame = frame;
    this.ended = ended;
    return () => {};
  }
  close(): void {
    this.closed = true;
  }
}

const frame = (seq: number): Uint8Array =>
  encodeFrame(
    {
      frameType: "PtyOutput",
      sessionId: "se_1" as never,
      generation: 1 as never,
      seq: seq as never,
      payloadLength: 1,
    },
    new Uint8Array([seq]),
  );

describe("ReconnectingAttachmentStream", () => {
  it("reopens only the stream from the next cursor without replacing the Attachment", async () => {
    const streams = [new ControlledStream(), new ControlledStream()];
    const openedFrom: number[] = [];
    let reconnect: (() => void) | undefined;
    const managed = await ReconnectingAttachmentStream.open({
      fromSeq: 4,
      open: async (fromSeq) => {
        openedFrom.push(fromSeq);
        const stream = streams[openedFrom.length - 1];
        if (stream === undefined) throw new Error("unexpected reconnect");
        return stream;
      },
      schedule: (callback) => {
        reconnect = callback;
        return () => {};
      },
    });
    const received: Uint8Array[] = [];
    let ended = 0;
    streams[0]?.frame?.(frame(4));
    managed.subscribe(
      (bytes) => received.push(bytes),
      () => {
        ended += 1;
      },
    );

    streams[0]?.ended?.();
    reconnect?.();
    await Promise.resolve();
    streams[1]?.frame?.(frame(5));

    expect(openedFrom).toEqual([4, 5]);
    expect(received).toEqual([frame(4), frame(5)]);
    expect(ended).toBe(0);
    managed.close();
    expect(streams[1]?.closed).toBe(true);
  });
});
