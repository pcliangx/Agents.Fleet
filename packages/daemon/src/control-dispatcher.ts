// RT-MOD-01 — Control Dispatcher. Drives the RT-HS handshake for one connection
// (version negotiate → challenge → proof verify → DaemonHello), then routes
// commands. The daemon generates a fresh daemonNonce per connection and
// computes daemonProof over the negotiation transcript (RT-HS-04); clientProof
// is verified by the injected ProofVerifier. Any handshake failure closes the
// socket immediately: no Attachment, no command executed (RT-HS-04 / RT-STREAM-03).
// R1-02 routes the Repository Trust command chain via TrustCommandRouter;
// every other kind stays on the not-implemented stub.

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
import { CommandError, type TrustCommandRouter } from "./repository-trust/trust-command-router.js";
import { StoreError } from "./storage/task-store.js";

export interface ConnectionSink {
  send(message: unknown): void;
  close(): void;
}

export type DispatcherState = "awaiting-hello" | "awaiting-auth" | "ready" | "closed";

// RT-ERR-01 — stable code + user-readable message + retryability + commandId.
// StoreError codes are already RT-ERR-02 codes and map straight through;
// retryable is false for this slice's failures (ConfirmationRequired /
// Conflict / IdempotencyConflict / InvalidRequest / NotFound /
// RecoveryRequired are all user- or state-action problems, not transients).
// Unknown exceptions collapse to InternalFailure with a generic message — no
// internal paths, env vars or secrets leak into the error (RT-ERR-01).
const toErrorShape = (e: unknown, commandId: CommandId) => {
  if (e instanceof StoreError || e instanceof CommandError) {
    return { code: e.code as ErrorCode, message: e.message, retryable: false, commandId };
  }
  return {
    code: "InternalFailure" as ErrorCode,
    message: "internal failure while executing command",
    retryable: false,
    commandId,
  };
};

export class ControlDispatcher {
  private state: DispatcherState = "awaiting-hello";
  private selectedProtocolVersion: number | undefined;
  private transcript: ProofTranscript | undefined;

  constructor(
    private readonly config: DaemonHandshakeConfig,
    private readonly verifier: ProofVerifier,
    private readonly sink: ConnectionSink,
    private readonly token: Uint8Array,
    private readonly router?: TrustCommandRouter,
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

  private async onCommand(env: CommandEnvelope): Promise<void> {
    // RT-CMD-09 envelope validation. A malformed command is a per-command
    // error response, never a connection close (unlike handshake failures).
    const commandId = (env as { commandId?: unknown })?.commandId;
    if (typeof commandId !== "string" || commandId.length === 0) {
      this.sendError("InvalidRequest", "commandId must be a non-empty string", undefined);
      return;
    }
    if (typeof (env as { schemaVersion?: unknown }).schemaVersion !== "number") {
      this.sendError("InvalidRequest", "schemaVersion must be a number", commandId as CommandId);
      return;
    }
    // The CommandKind travels as a `kind` discriminator on the payload object.
    const kind = (env.payload as { kind?: unknown } | undefined)?.kind;
    if (typeof kind !== "string") {
      this.sendError(
        "InvalidRequest",
        "payload.kind must be a command kind string",
        commandId as CommandId,
      );
      return;
    }

    // R1-02 — Repository Trust production chain. Kinds the router does not
    // handle keep the #1 not-implemented stub until their tickets land.
    if (this.router?.handles(kind)) {
      try {
        const result = await this.router.execute(kind as never, env);
        this.sink.send({ commandId, result });
      } catch (e) {
        const err = toErrorShape(e, commandId as CommandId);
        this.sink.send({ error: err });
      }
      return;
    }
    this.sendError(
      "InternalFailure",
      `command routing not implemented for kind: ${kind}`,
      commandId as CommandId,
    );
  }

  private sendError(code: ErrorCode, message: string, commandId: CommandId | undefined): void {
    this.sink.send({ error: { code, message, retryable: false, commandId } });
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
