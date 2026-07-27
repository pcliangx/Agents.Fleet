// RT-STREAM-02/03 — Electron Main client for the separately authenticated
// length-prefixed binary Session stream.

import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import type { ClientHello, DaemonChallenge, DaemonHello, Nonce } from "@agents-fleet/contracts";
import {
  FROZEN_RUNTIME_LIMIT_PROFILE,
  PLATFORM_MATRIX_VERSION,
  RUNTIME_LIMIT_PROFILE_VERSION,
} from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  NdjsonDecoder,
  verifyProof,
} from "@agents-fleet/transport";
import type { AttachmentStream } from "./attachment-port-binding.js";

export interface StreamSocket {
  on(
    event: "data" | "close" | "error",
    listener: ((chunk: Uint8Array) => void) | (() => void),
  ): void;
  off(event: "data", listener: (chunk: Uint8Array) => void): void;
  write(bytes: string | Uint8Array): boolean;
  destroy(): void;
}

export interface ConnectAttachmentStreamOptions {
  readonly socketPath: string;
  readonly token: Uint8Array;
  readonly clientInstanceId?: string;
  readonly clientNonce?: string;
  readonly attachmentId: string;
  readonly fromSeq: number;
}

export interface AttachmentStreamConnector {
  connect(path: string): Promise<StreamSocket>;
}

const defaultConnector: AttachmentStreamConnector = {
  connect: async (path) =>
    await new Promise<StreamSocket>((resolve, reject) => {
      const socket = netConnect(path);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve({
          on(event, listener) {
            if (event === "data") {
              socket.on("data", listener as (chunk: Buffer) => void);
            } else {
              socket.on(event, listener as () => void);
            }
          },
          off(_event, listener) {
            socket.off("data", listener as (chunk: Buffer) => void);
          },
          write: (bytes) => socket.write(bytes),
          destroy: () => socket.destroy(),
        });
      });
    }),
};

const readJson = (socket: StreamSocket, decoder: NdjsonDecoder): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const onData = (chunk: Uint8Array): void => {
      try {
        decoder.feed(chunk);
        const messages = decoder.drain();
        if (messages.length === 0) return;
        socket.off("data", onData);
        resolve(messages[0]);
      } catch (error) {
        socket.off("data", onData);
        reject(error);
      }
    };
    socket.on("data", onData);
  });

export class DaemonAttachmentStream implements AttachmentStream {
  readonly #socket: StreamSocket;
  #pending = new Uint8Array();
  #queued: Uint8Array[] = [];
  #queuedBytes = 0;
  #onFrame: ((bytes: Uint8Array) => void) | undefined;
  #onEnded: (() => void) | undefined;
  #closed = false;

  private constructor(socket: StreamSocket) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("close", () => this.#ended());
    socket.on("error", () => this.#ended());
  }

  static async connect(
    options: ConnectAttachmentStreamOptions,
    connector: AttachmentStreamConnector = defaultConnector,
  ): Promise<DaemonAttachmentStream> {
    if (
      options.attachmentId.length === 0 ||
      !Number.isSafeInteger(options.fromSeq) ||
      options.fromSeq < 1
    ) {
      throw new Error("invalid Attachment stream request");
    }
    const socket = await connector.connect(options.socketPath);
    const decoder = new NdjsonDecoder();
    const hello: ClientHello = {
      protocolVersions: [1],
      expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
      expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
      clientInstanceId: options.clientInstanceId ?? "electron-main-stream",
      clientKind: "electron-main",
      clientNonce: (options.clientNonce ?? randomUUID()) as Nonce,
    };
    socket.write(`${JSON.stringify(hello)}\n`);
    const challenge = (await readJson(socket, decoder)) as DaemonChallenge;
    const transcript = buildProofTranscript(hello, challenge);
    if (!verifyProof("daemon", transcript, options.token, challenge.daemonProof)) {
      socket.destroy();
      throw new Error("stream handshake failed (bad daemon proof)");
    }
    socket.write(
      `${JSON.stringify({ clientProof: computeProof("client", transcript, options.token) })}\n`,
    );
    const daemonHello = (await readJson(socket, decoder)) as DaemonHello;
    if (
      daemonHello.selectedProtocolVersion !== challenge.selectedProtocolVersion ||
      !daemonHello.capabilities.includes("session-stream")
    ) {
      socket.destroy();
      throw new Error("stream handshake failed (capability unavailable)");
    }
    const stream = new DaemonAttachmentStream(socket);
    socket.write(
      `${JSON.stringify({
        attachmentId: options.attachmentId,
        fromSeq: options.fromSeq,
      })}\n`,
    );
    return stream;
  }

  subscribe(onFrame: (bytes: Uint8Array) => void, onEnded: () => void): () => void {
    if (this.#onFrame !== undefined) throw new Error("Attachment stream already has a subscriber");
    this.#onFrame = onFrame;
    this.#onEnded = onEnded;
    for (const frame of this.#queued) onFrame(frame);
    this.#queued = [];
    this.#queuedBytes = 0;
    return () => {
      this.#onFrame = undefined;
      this.#onEnded = undefined;
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#queued = [];
    this.#queuedBytes = 0;
  }

  #receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    const combined = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
    combined.set(this.#pending);
    combined.set(chunk, this.#pending.byteLength);
    this.#pending = combined;

    while (this.#pending.byteLength >= 4) {
      const headerLength = new DataView(
        this.#pending.buffer,
        this.#pending.byteOffset,
        this.#pending.byteLength,
      ).getUint32(0);
      if (headerLength > FROZEN_RUNTIME_LIMIT_PROFILE.streamHeaderBytes) {
        this.#ended();
        return;
      }
      if (this.#pending.byteLength < 4 + headerLength) return;
      let payloadLength: number;
      try {
        const header = JSON.parse(
          new TextDecoder().decode(this.#pending.subarray(4, 4 + headerLength)),
        ) as { readonly payloadLength?: unknown };
        if (
          !Number.isSafeInteger(header.payloadLength) ||
          (header.payloadLength as number) < 0 ||
          (header.payloadLength as number) > FROZEN_RUNTIME_LIMIT_PROFILE.streamFramePayloadBytes
        ) {
          this.#ended();
          return;
        }
        payloadLength = header.payloadLength as number;
      } catch {
        this.#ended();
        return;
      }
      const total = 4 + headerLength + payloadLength;
      if (this.#pending.byteLength < total) return;
      const frame = Uint8Array.from(this.#pending.subarray(0, total));
      this.#pending = this.#pending.slice(total);
      if (this.#onFrame !== undefined) {
        this.#onFrame(frame);
      } else {
        if (
          this.#queued.length + 1 > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueFrames ||
          this.#queuedBytes + frame.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes
        ) {
          this.#ended();
          return;
        }
        this.#queued.push(frame);
        this.#queuedBytes += frame.byteLength;
      }
    }
  }

  #ended(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#onEnded?.();
  }
}
