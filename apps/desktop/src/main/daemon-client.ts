// DaemonClient — the Electron Main side of the RT-HS handshake. Uses the same
// shared transport handshake as the daemon and the e2e test. #1 uses a dev
// proof under AGENTS_FLEET_DEV_AUTH; #11 replaces it with a Keychain-backed MAC.

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { ClientHello, DaemonChallenge, DaemonHello, Nonce } from "@agents-fleet/contracts";
import { NdjsonDecoder } from "@agents-fleet/transport";

export interface ConnectOptions {
  readonly socketPath: string;
  readonly clientInstanceId?: string;
  readonly devProof?: string;
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
      const hello: ClientHello = {
        protocolVersions: [1],
        expectedPlatformMatrixVersion: 0,
        expectedRuntimeLimitProfileVersion: 0,
        clientInstanceId: opts.clientInstanceId ?? "electron-main",
        clientKind: "electron-main",
        clientNonce: randomUUID() as Nonce,
      };
      sock.write(`${JSON.stringify(hello)}\n`);

      const challenge = (await readOne(sock, dec)) as DaemonChallenge;
      if (challenge.selectedProtocolVersion === undefined) {
        reject(new Error("handshake failed (no challenge)"));
        return;
      }
      sock.write(`${JSON.stringify({ clientProof: opts.devProof ?? "dev-proof" })}\n`);
      const helloBack = (await readOne(sock, dec)) as DaemonHello;
      resolve(helloBack);
    });
  });
};
