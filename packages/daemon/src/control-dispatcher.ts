// RT-MOD-01 — Control Dispatcher. Drives the RT-HS handshake for one connection
// (version negotiate → challenge → proof verify → DaemonHello), then routes
// commands. The daemon generates a fresh daemonNonce per connection and
// computes daemonProof over the negotiation transcript (RT-HS-04); clientProof
// is verified by the injected ProofVerifier. Any handshake failure closes the
// socket immediately: no Attachment, no command executed (RT-HS-04 / RT-STREAM-03).
// Command routing is a stub.

import { randomUUID } from "node:crypto";
import type {
  ClientAuth,
  ClientHello,
  CommandEnvelope,
  CommandId,
  DaemonHello,
  ErrorCode,
  Nonce,
} from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  type DaemonHandshakeConfig,
  negotiate,
  type ProofTranscript,
} from "@agents-fleet/transport";
import type { ProofVerifier } from "./auth/proof-verifier.js";

export interface ConnectionSink {
  send(message: unknown): void;
  close(): void;
}

export type DispatcherState = "awaiting-hello" | "awaiting-auth" | "ready" | "closed";

export class ControlDispatcher {
  private state: DispatcherState = "awaiting-hello";
  private selectedProtocolVersion: number | undefined;
  private transcript: ProofTranscript | undefined;

  constructor(
    private readonly config: DaemonHandshakeConfig,
    private readonly verifier: ProofVerifier,
    private readonly sink: ConnectionSink,
    private readonly token: Uint8Array,
  ) {}

  get currentState(): DispatcherState {
    return this.state;
  }

  async onLine(text: string): Promise<void> {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      this.fail("InvalidRequest", "malformed json");
      return;
    }
    return this.onMessage(obj);
  }

  async onMessage(obj: unknown): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "awaiting-hello") return this.onHello(obj as ClientHello);
    if (this.state === "awaiting-auth") return this.onAuth(obj as ClientAuth);
    return this.onCommand(obj as CommandEnvelope);
  }

  private async onHello(hello: ClientHello): Promise<void> {
    // RT-HS-04 — fresh daemonNonce per connection; the proof is computed after
    // negotiation (it binds selectedProtocolVersion) and overrides the
    // placeholder negotiate placed in the challenge.
    const daemonNonce = randomUUID() as Nonce;
    const result = negotiate(this.config, hello, { daemonNonce, daemonProof: "" });
    if (result.kind === "fatal") {
      this.fail(result.code, result.message);
      return;
    }
    const transcript = buildProofTranscript(hello, result.challenge);
    this.transcript = transcript;
    this.selectedProtocolVersion = result.challenge.selectedProtocolVersion;
    this.state = "awaiting-auth";
    const daemonProof = computeProof("daemon", transcript, this.token);
    this.sink.send({ ...result.challenge, daemonProof });
  }

  private async onAuth(auth: ClientAuth): Promise<void> {
    if (this.transcript === undefined) {
      this.fail("InternalFailure", "handshake state corrupted");
      return;
    }
    const res = await this.verifier.verify({
      transcript: this.transcript,
      clientProof: auth.clientProof,
    });
    if (!res.ok) {
      // RT-HS-04 — fail closed: no DaemonHello, no Attachment, close immediately.
      this.sink.close();
      this.state = "closed";
      return;
    }
    this.state = "ready";
    this.sink.send(this.daemonHello());
  }

  private onCommand(env: CommandEnvelope): void {
    // #1 routing stub — every command reports not-implemented. Real routing lands
    // with the implementing tickets (R1 onwards).
    const commandId: CommandId = env.commandId;
    this.sink.send({
      error: {
        code: "InternalFailure" as ErrorCode,
        message: "command routing not implemented in #1",
        retryable: false,
        commandId,
      },
    });
  }

  private daemonHello(): DaemonHello {
    return {
      selectedProtocolVersion: this.selectedProtocolVersion!,
      daemonId: this.config.daemonId,
      daemonGeneration: this.config.daemonGeneration,
      platformMatrixVersion: this.config.platformMatrixVersion,
      runtimeLimitProfileVersion: this.config.runtimeLimitProfileVersion,
      capabilities: [],
    };
  }

  private fail(code: ErrorCode, message: string): void {
    this.sink.send({
      error: { code, message, retryable: false, commandId: undefined },
    });
    this.sink.close();
    this.state = "closed";
  }
}
