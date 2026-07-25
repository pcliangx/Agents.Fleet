// E2E handshake over a real Unix socket: daemon (startServer) ↔ a plain net
// client using the shared transport handshake logic. This proves RT-HS-01..05
// end-to-end on the wire (the Electron Main client uses the same code path).

import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientHello, DaemonChallenge, DaemonHello } from "@agents-fleet/contracts";
import { type DaemonHandshakeConfig, NdjsonDecoder } from "@agents-fleet/transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";
import { type StartedServer, startServer } from "../server.js";

const config: DaemonHandshakeConfig = {
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
  daemonNonce: "n" as never,
  daemonProof: "p",
};

const readOne = (sock: Socket, dec: NdjsonDecoder, timeoutMs = 1000): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
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

describe("e2e handshake over a real socket (RT-HS-01..05)", () => {
  let server: StartedServer | undefined;
  let socketDir: string | undefined;

  beforeAll(async () => {
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    process.env.NODE_ENV = "test";
    socketDir = await mkdtemp(join(tmpdir(), "af-e2e-"));
    server = await startServer({
      socketDir,
      config,
      verifier: new DevProofVerifier(),
    });
  });

  afterAll(async () => {
    await server?.close();
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
  });

  it("completes ClientHello -> DaemonChallenge -> ClientAuth -> DaemonHello", async () => {
    if (!server) throw new Error("server not started");
    const sock: Socket = connect(server.socketPath);
    await new Promise<void>((resolve) => {
      sock.on("connect", () => resolve());
    });

    const dec = new NdjsonDecoder();
    const hello: ClientHello = {
      protocolVersions: [1],
      expectedPlatformMatrixVersion: 0,
      expectedRuntimeLimitProfileVersion: 0,
      clientInstanceId: "c",
      clientKind: "electron-main",
      clientNonce: "cn" as never,
    };
    sock.write(`${JSON.stringify(hello)}\n`);

    const challenge = (await readOne(sock, dec)) as DaemonChallenge;
    expect(challenge.selectedProtocolVersion).toBe(1);
    expect(challenge.daemonNonce).toBeTruthy();

    sock.write(`${JSON.stringify({ clientProof: "dev-proof" })}\n`);
    const helloBack = (await readOne(sock, dec)) as DaemonHello;
    expect(helloBack.daemonGeneration).toBe(1);
    expect(helloBack.selectedProtocolVersion).toBe(1);

    sock.destroy();
  });
});
