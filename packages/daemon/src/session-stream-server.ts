// RT-STREAM-02/03 — separately authenticated binary Session stream channel.

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type {
  ClientAuth,
  ClientHello,
  DaemonHello,
  Nonce,
  SessionDeltaBatch,
} from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  type DaemonHandshakeConfig,
  encodeFrame,
  NdjsonDecoder,
  negotiate,
  type ProofTranscript,
} from "@agents-fleet/transport";
import type { ProofVerifier } from "./auth/proof-verifier.js";

export interface SessionStreamProvider {
  readSessionDelta(attachmentId: string, fromSeq: number): SessionDeltaBatch;
}

export interface SessionStreamServerOptions {
  readonly config: DaemonHandshakeConfig;
  readonly verifier: ProofVerifier;
  readonly token: Uint8Array;
  readonly streams?: SessionStreamProvider;
}

export interface SessionStreamServer {
  readonly server: Server;
  readonly sockets: ReadonlySet<Socket>;
}

type StreamState = "awaiting-hello" | "awaiting-auth" | "awaiting-open" | "streaming" | "closed";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const sendJson = (socket: Socket, message: unknown): void => {
  socket.write(`${JSON.stringify(message)}\n`);
};

const daemonHello = (
  config: DaemonHandshakeConfig,
  selectedProtocolVersion: number,
): DaemonHello => ({
  selectedProtocolVersion,
  daemonId: config.daemonId,
  daemonGeneration: config.daemonGeneration,
  platformMatrixVersion: config.platformMatrixVersion,
  runtimeLimitProfileVersion: config.runtimeLimitProfileVersion,
  capabilities: ["session-stream"],
});

class StreamConnection {
  readonly #socket: Socket;
  readonly #options: SessionStreamServerOptions;
  readonly #decoder = new NdjsonDecoder();
  #state: StreamState = "awaiting-hello";
  #transcript: ProofTranscript | undefined;
  #selectedProtocolVersion: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #nextSeq = 1;
  #attachmentId = "";
  #processing = Promise.resolve();

  constructor(socket: Socket, options: SessionStreamServerOptions) {
    this.#socket = socket;
    this.#options = options;
    socket.on("data", (chunk: Buffer) => {
      if (this.#state === "streaming" || this.#state === "closed") return;
      try {
        this.#decoder.feed(chunk);
        for (const message of this.#decoder.drain()) {
          this.#processing = this.#processing.then(async () => await this.#onMessage(message));
        }
      } catch {
        this.close();
      }
    });
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket.destroy();
  }

  async #onMessage(message: unknown): Promise<void> {
    try {
      if (this.#state === "awaiting-hello") {
        const hello = message as ClientHello;
        const daemonNonce = randomUUID() as Nonce;
        const negotiated = negotiate(this.#options.config, hello, {
          daemonNonce,
          daemonProof: "",
        });
        if (negotiated.kind === "fatal") {
          this.close();
          return;
        }
        const transcript = buildProofTranscript(hello, negotiated.challenge);
        this.#transcript = transcript;
        this.#selectedProtocolVersion = negotiated.challenge.selectedProtocolVersion;
        this.#state = "awaiting-auth";
        sendJson(this.#socket, {
          ...negotiated.challenge,
          daemonProof: computeProof("daemon", transcript, this.#options.token),
        });
        return;
      }
      if (this.#state === "awaiting-auth") {
        const auth = message as ClientAuth;
        if (this.#transcript === undefined || typeof auth.clientProof !== "string") {
          this.close();
          return;
        }
        const verified = await this.#options.verifier.verify({
          transcript: this.#transcript,
          clientProof: auth.clientProof,
        });
        if (!verified.ok || this.#selectedProtocolVersion === undefined) {
          this.close();
          return;
        }
        this.#state = "awaiting-open";
        sendJson(this.#socket, daemonHello(this.#options.config, this.#selectedProtocolVersion));
        return;
      }
      if (this.#state === "awaiting-open") {
        const request = asRecord(message);
        if (
          request === null ||
          typeof request.attachmentId !== "string" ||
          request.attachmentId.length === 0 ||
          !Number.isSafeInteger(request.fromSeq) ||
          (request.fromSeq as number) < 1 ||
          this.#options.streams === undefined
        ) {
          this.close();
          return;
        }
        this.#attachmentId = request.attachmentId;
        this.#nextSeq = request.fromSeq as number;
        this.#state = "streaming";
        this.#pump();
      }
    } catch {
      this.close();
    }
  }

  #pump(): void {
    if (this.#state !== "streaming" || this.#options.streams === undefined) return;
    try {
      const batch = this.#options.streams.readSessionDelta(this.#attachmentId, this.#nextSeq);
      if (batch.attachmentId !== this.#attachmentId) {
        this.close();
        return;
      }
      for (const frame of batch.frames) {
        if (
          frame.header.sessionId !== batch.sessionId ||
          frame.header.generation !== batch.generation
        ) {
          this.close();
          return;
        }
        const writable = this.#socket.write(encodeFrame(frame.header, frame.bytes));
        if (!writable) {
          this.#nextSeq = (frame.header.seq as number) + 1;
          this.#socket.once("drain", () => this.#schedulePump(0));
          return;
        }
      }
      this.#nextSeq = batch.nextSeq as number;
      this.#schedulePump(batch.frames.length === 0 ? 25 : 0);
    } catch {
      this.close();
    }
  }

  #schedulePump(delayMs: number): void {
    if (this.#state !== "streaming") return;
    this.#timer = setTimeout(() => this.#pump(), delayMs);
  }
}

export const createSessionStreamServer = (
  options: SessionStreamServerOptions,
): SessionStreamServer => {
  const sockets = new Set<Socket>();
  const connections = new Map<Socket, StreamConnection>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const connection = new StreamConnection(socket, options);
    connections.set(socket, connection);
    socket.once("close", () => {
      connection.close();
      connections.delete(socket);
      sockets.delete(socket);
    });
  });
  return { server, sockets };
};
