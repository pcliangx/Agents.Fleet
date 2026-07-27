import { encodeFrame } from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import {
  AttachmentPortBinding,
  type AttachmentStream,
  type MainMessagePort,
} from "./attachment-port-binding.js";
import type { CommandResponse, OutgoingCommand } from "./daemon-client.js";
import { DesktopBridgeCore } from "./desktop-bridge.js";

class FakePort implements MainMessagePort {
  readonly sent: { readonly message: unknown; readonly transfer: readonly ArrayBuffer[] }[] = [];
  readonly messageListeners: ((event: { readonly data: unknown }) => void)[] = [];
  readonly closeListeners: (() => void)[] = [];
  started = false;
  closed = false;

  postMessage(message: unknown, transfer: readonly ArrayBuffer[] = []): void {
    this.sent.push({ message, transfer });
  }
  on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)) {
    if (event === "message") {
      this.messageListeners.push(listener as (event: { readonly data: unknown }) => void);
    } else {
      this.closeListeners.push(listener as () => void);
    }
  }
  start(): void {
    this.started = true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
  receive(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }
}

class FakeStream implements AttachmentStream {
  frame: ((bytes: Uint8Array) => void) | undefined;
  ended: (() => void) | undefined;
  closed = false;

  subscribe(frame: (bytes: Uint8Array) => void, ended: () => void): () => void {
    this.frame = frame;
    this.ended = ended;
    return () => {
      this.frame = undefined;
      this.ended = undefined;
    };
  }
  close(): void {
    this.closed = true;
  }
}

describe("AttachmentPortBinding", () => {
  it("forwards only binary frames matching its immutable Attachment identity", async () => {
    const commands: OutgoingCommand[] = [];
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(command): Promise<CommandResponse> {
          commands.push(command);
          return { commandId: command.commandId, result: { closed: true } };
        },
      },
    });
    const port = new FakePort();
    const stream = new FakeStream();
    const binding = new AttachmentPortBinding({
      attached: {
        attachmentId: "att_1" as never,
        mode: "Live",
        sessionId: "se_1" as never,
        generation: 3 as never,
        snapshot: { coversThroughSeq: 0 as never, bytes: new Uint8Array() },
      },
      rendererFrameIdentity: "frame:7",
      port,
      stream,
      bridge,
    });
    binding.start();

    const wire = encodeFrame(
      {
        frameType: "PtyOutput",
        sessionId: "se_1" as never,
        generation: 3 as never,
        seq: 1 as never,
        payloadLength: 3,
      },
      new Uint8Array([0, 128, 255]),
    );
    stream.frame?.(wire);

    expect(port.started).toBe(true);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.message).toMatchObject({
      type: "session-frame",
      attachmentId: "att_1",
      sessionId: "se_1",
      generation: 3,
      rendererFrameIdentity: "frame:7",
      seq: 1,
    });
    expect(new Uint8Array(port.sent[0]?.transfer[0] ?? new ArrayBuffer(0))).toEqual(wire);

    stream.frame?.(
      encodeFrame(
        {
          frameType: "PtyOutput",
          sessionId: "se_other" as never,
          generation: 3 as never,
          seq: 2 as never,
          payloadLength: 1,
        },
        new Uint8Array([1]),
      ),
    );

    expect(port.closed).toBe(true);
    expect(stream.closed).toBe(true);
    await Promise.resolve();
    expect(commands.map((command) => command.payload.kind)).toEqual(["CloseAttachment"]);
  });

  it("stops Control Lease renewal as soon as the MessagePort closes", async () => {
    const commands: OutgoingCommand[] = [];
    let scheduled: (() => void) | undefined;
    let cancelled = false;
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(command): Promise<CommandResponse> {
          commands.push(command);
          if (command.payload.kind === "RenewControl") {
            return {
              commandId: command.commandId,
              result: {
                sessionId: "se_1",
                generation: 3,
                attachmentId: "att_1",
                fencingToken: 9,
                expiresAt: 30_000,
              },
            };
          }
          return { commandId: command.commandId, result: { closed: true } };
        },
      },
    });
    const port = new FakePort();
    const stream = new FakeStream();
    const binding = new AttachmentPortBinding({
      attached: {
        attachmentId: "att_1" as never,
        mode: "Live",
        sessionId: "se_1" as never,
        generation: 3 as never,
        snapshot: { coversThroughSeq: 0 as never, bytes: new Uint8Array() },
      },
      rendererFrameIdentity: "frame:7",
      port,
      stream,
      bridge,
      now: () => 0,
      schedule: (callback) => {
        scheduled = callback;
        return () => {
          cancelled = true;
        };
      },
    });
    binding.start();
    binding.holdControl({
      sessionId: "se_1" as never,
      generation: 3 as never,
      attachmentId: "att_1" as never,
      fencingToken: 9 as never,
      expiresAt: 15_000,
    });
    scheduled?.();
    await Promise.resolve();
    expect(commands.map((command) => command.payload.kind)).toEqual(["RenewControl"]);

    port.close();
    await Promise.resolve();

    expect(cancelled).toBe(true);
    expect(stream.closed).toBe(true);
    expect(commands.map((command) => command.payload.kind)).toEqual([
      "RenewControl",
      "CloseAttachment",
    ]);
  });
});
