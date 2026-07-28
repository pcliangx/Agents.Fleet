import type { ClientHello, DaemonChallenge, DaemonHello } from "@agents-fleet/contracts";
import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  encodeFrame,
  verifyProof,
} from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import { DaemonAttachmentStream, type StreamSocket } from "./daemon-attachment-stream.js";

class FakeStreamSocket implements StreamSocket {
  readonly #token: Uint8Array;
  readonly #data = new Set<(chunk: Uint8Array) => void>();
  readonly #close = new Set<() => void>();
  stage = 0;
  destroyed = false;
  openRequest: unknown;

  constructor(token: Uint8Array) {
    this.#token = token;
  }

  on(event: "data" | "close" | "error", listener: ((chunk: Uint8Array) => void) | (() => void)) {
    if (event === "data") this.#data.add(listener as (chunk: Uint8Array) => void);
    if (event === "close") this.#close.add(listener as () => void);
  }
  off(event: "data", listener: (chunk: Uint8Array) => void): void {
    if (event === "data") this.#data.delete(listener);
  }
  write(bytes: string | Uint8Array): boolean {
    const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    const message = JSON.parse(text) as Record<string, unknown>;
    if (this.stage === 0) {
      const hello = message as unknown as ClientHello;
      const challengeWithoutProof: DaemonChallenge = {
        selectedProtocolVersion: 1,
        daemonId: "daemon-test" as never,
        daemonGeneration: 2 as never,
        platformMatrixVersion: PLATFORM_MATRIX_VERSION,
        runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
        daemonNonce: "daemon-nonce" as never,
        daemonProof: "",
      };
      const transcript = buildProofTranscript(hello, challengeWithoutProof);
      this.stage = 1;
      queueMicrotask(() =>
        this.emit(
          new TextEncoder().encode(
            `${JSON.stringify({
              ...challengeWithoutProof,
              daemonProof: computeProof("daemon", transcript, this.#token),
            })}\n`,
          ),
        ),
      );
      return true;
    }
    if (this.stage === 1) {
      const hello: ClientHello = {
        protocolVersions: [1],
        expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
        expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
        clientInstanceId: "desktop-stream-test",
        clientKind: "electron-main",
        clientNonce: "client-nonce" as never,
      };
      const challenge: DaemonChallenge = {
        selectedProtocolVersion: 1,
        daemonId: "daemon-test" as never,
        daemonGeneration: 2 as never,
        platformMatrixVersion: PLATFORM_MATRIX_VERSION,
        runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
        daemonNonce: "daemon-nonce" as never,
        daemonProof: "",
      };
      const transcript = buildProofTranscript(hello, challenge);
      expect(verifyProof("client", transcript, this.#token, message.clientProof as string)).toBe(
        true,
      );
      const daemonHello: DaemonHello = {
        selectedProtocolVersion: 1,
        daemonId: "daemon-test" as never,
        daemonGeneration: 2 as never,
        platformMatrixVersion: PLATFORM_MATRIX_VERSION,
        runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
        capabilities: ["session-stream"],
      };
      this.stage = 2;
      queueMicrotask(() => this.emit(new TextEncoder().encode(`${JSON.stringify(daemonHello)}\n`)));
      return true;
    }
    this.openRequest = message;
    const frame = encodeFrame(
      {
        frameType: "PtyOutput",
        sessionId: "se_1" as never,
        generation: 3 as never,
        seq: 8 as never,
        payloadLength: 4,
      },
      new Uint8Array([0, 255, 128, 1]),
    );
    this.stage = 3;
    queueMicrotask(() => {
      this.emit(frame.subarray(0, 7));
      this.emit(frame.subarray(7));
    });
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    for (const listener of this.#close) listener();
  }
  emit(chunk: Uint8Array): void {
    for (const listener of this.#data) listener(chunk);
  }
}

describe("DaemonAttachmentStream", () => {
  it("authenticates independently and reassembles fragmented binary frames", async () => {
    const token = new TextEncoder().encode("stream-client-token");
    const socket = new FakeStreamSocket(token);
    const stream = await DaemonAttachmentStream.connect(
      {
        socketPath: "/unused/in-test",
        token,
        clientInstanceId: "desktop-stream-test",
        clientNonce: "client-nonce",
        attachmentId: "att_1",
        fromSeq: 8,
      },
      { connect: async () => socket },
    );
    const received: Uint8Array[] = [];
    stream.subscribe(
      (frame) => received.push(frame),
      () => {},
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(socket.openRequest).toEqual({ attachmentId: "att_1", fromSeq: 8 });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      encodeFrame(
        {
          frameType: "PtyOutput",
          sessionId: "se_1" as never,
          generation: 3 as never,
          seq: 8 as never,
          payloadLength: 4,
        },
        new Uint8Array([0, 255, 128, 1]),
      ),
    );
    stream.close();
    expect(socket.destroyed).toBe(true);
  });
});
