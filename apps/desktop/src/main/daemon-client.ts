// DaemonClient — the Electron Main side of the RT-HS handshake plus the R1-02
// command channel. Computes the client proof over the negotiation transcript
// and verifies the daemon's proof (RT-HS-04), keyed by the shared capability
// token, then keeps the socket open for NDJSON one-request/one-response
// commands matched by commandId. SV1-AUTH-05: this client lives in Main only;
// the Renderer never touches the socket.
//
// Deliberately no connection pool: one connection per daemon, pending
// commands are bounded by a timeout and are all rejected when the connection
// errors or closes.

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type {
  ClientHello,
  DaemonChallenge,
  DaemonHello,
  ErrorShape,
  Nonce,
} from "@agents-fleet/contracts";
import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  NdjsonDecoder,
  verifyProof,
} from "@agents-fleet/transport";

export interface ConnectOptions {
  readonly socketPath: string;
  readonly clientInstanceId?: string;
  readonly token: Uint8Array;
}

/** A command envelope as sent on the wire; `payload.kind` is the CommandKind. */
export interface OutgoingCommand {
  readonly commandId: string;
  readonly schemaVersion: number;
  readonly repositoryTrustReceipt?: unknown;
  readonly payload: { readonly kind: string; readonly [k: string]: unknown };
}

export type CommandResponse =
  | { readonly commandId: string; readonly result: unknown }
  | { readonly error: ErrorShape };

/** True when the daemon answered with a domain error rather than a result. */
export const isCommandError = (r: CommandResponse): r is { readonly error: ErrorShape } =>
  typeof r === "object" && r !== null && "error" in r;

const COMMAND_TIMEOUT_MS = 15_000;

const readOne = (sock: Socket, dec: NdjsonDecoder, timeoutMs = 2000): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake read timeout")), timeoutMs);
    const onData = (chunk: Buffer): void => {
      dec.feed(chunk);
      const objs = dec.drain();
      if (objs.length > 0) {
        clearTimeout(timer);
        sock.off("data", onData);
        resolve(objs[0]);
      }
    };
    sock.on("data", onData);
  });

interface Pending {
  readonly resolve: (r: CommandResponse) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class DaemonClient {
  readonly hello: DaemonHello;
  readonly #sock: Socket;
  readonly #dec = new NdjsonDecoder();
  readonly #pending = new Map<string, Pending>();
  #closed = false;

  private constructor(sock: Socket, hello: DaemonHello) {
    this.#sock = sock;
    this.hello = hello;
    sock.on("data", (chunk: Buffer) => {
      this.#dec.feed(chunk);
      for (const obj of this.#dec.drain()) this.#dispatch(obj);
    });
    sock.on("error", () => this.#failAll(new Error("daemon connection error")));
    sock.on("close", () => this.#failAll(new Error("daemon connection closed")));
  }

  static async connect(opts: ConnectOptions): Promise<DaemonClient> {
    return await new Promise<DaemonClient>((resolve, reject) => {
      const sock: Socket = connect(opts.socketPath);
      const dec = new NdjsonDecoder();
      sock.on("error", reject);

      sock.on("connect", async () => {
        const clientNonce = randomUUID() as Nonce;
        const hello: ClientHello = {
          protocolVersions: [1],
          expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
          expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
          clientInstanceId: opts.clientInstanceId ?? "electron-main",
          clientKind: "electron-main",
          clientNonce,
        };
        sock.write(`${JSON.stringify(hello)}\n`);

        const challenge = (await readOne(sock, dec)) as DaemonChallenge;
        if (challenge.selectedProtocolVersion === undefined) {
          reject(new Error("handshake failed (no challenge)"));
          return;
        }
        const transcript = buildProofTranscript(hello, challenge);
        // RT-HS-04 — verify the daemon proof before trusting the challenge.
        if (!verifyProof("daemon", transcript, opts.token, challenge.daemonProof)) {
          reject(new Error("handshake failed (bad daemon proof)"));
          return;
        }
        const clientProof = computeProof("client", transcript, opts.token);
        sock.write(`${JSON.stringify({ clientProof })}\n`);
        const helloBack = (await readOne(sock, dec)) as DaemonHello;
        // Handshake consumed the one-shot listeners; switch to command mode.
        sock.removeAllListeners("error");
        resolve(new DaemonClient(sock, helloBack));
      });
    });
  }

  /**
   * One request, one response, matched by commandId. Resolves with the
   * daemon's response (result OR domain error — check isCommandError);
   * rejects only on transport failure (timeout, connection lost).
   */
  sendCommand(command: OutgoingCommand, opts?: { timeoutMs?: number }): Promise<CommandResponse> {
    if (this.#closed) return Promise.reject(new Error("daemon connection closed"));
    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.commandId);
        reject(new Error(`command timeout: ${command.payload.kind}`));
      }, opts?.timeoutMs ?? COMMAND_TIMEOUT_MS);
      this.#pending.set(command.commandId, { resolve, reject, timer });
      this.#sock.write(`${JSON.stringify(command)}\n`);
    });
  }

  close(): void {
    this.#failAll(new Error("daemon client closed"));
    this.#sock.destroy();
  }

  #dispatch(obj: unknown): void {
    const r = obj as { commandId?: unknown; error?: { commandId?: unknown } };
    const commandId = r?.error?.commandId ?? r?.commandId;
    if (typeof commandId !== "string") return;
    const pending = this.#pending.get(commandId);
    if (pending === undefined) return;
    this.#pending.delete(commandId);
    clearTimeout(pending.timer);
    pending.resolve(obj as CommandResponse);
  }

  #failAll(e: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.#pending.clear();
  }
}
