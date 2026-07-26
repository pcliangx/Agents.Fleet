// DaemonClient — the Electron Main side of the RT-HS handshake. Computes the
// client proof over the negotiation transcript and verifies the daemon's proof
// (RT-HS-04), keyed by the shared capability token. Uses the same shared
// transport handshake + capability-proof scheme as the daemon and the e2e test.

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { ClientHello, DaemonChallenge, DaemonHello, Nonce } from "@agents-fleet/contracts";
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

export const connectDaemon = (opts: ConnectOptions): Promise<DaemonHello> => {
  return new Promise<DaemonHello>((resolve, reject) => {
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
      resolve(helloBack);
    });
  });
};
