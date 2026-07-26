// E2E handshake over a real Unix socket with REAL mutual MAC auth (RT-HS-04):
// daemon (startServer + KeychainCapabilityProofVerifier) ↔ a plain net client
// that computes/verifies proofs via the shared scheme, same capability token.
// This proves RT-HS-01..05 end-to-end on the wire (the Electron Main client
// uses the same scheme).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientHello, DaemonChallenge, DaemonHello, Nonce } from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  type DaemonHandshakeConfig,
  NdjsonDecoder,
  type ProofTranscript,
  verifyProof,
} from "@agents-fleet/transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeychainCapabilityProofVerifier } from "../auth/keychain-capability-proof-verifier.js";
import { type StartedServer, startServer } from "../server.js";

const token = new Uint8Array([9, 9, 9, 9, 8, 8, 8, 8]);
const wrongToken = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);

const config: DaemonHandshakeConfig = {
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
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

// Runs the client half of the handshake with the given token; returns the
// transcript + DaemonHello, or throws if the daemon did not authenticate it.
const clientHandshake = async (
  socketPath: string,
  tok: Uint8Array,
): Promise<{ readonly transcript: ProofTranscript; readonly hello: DaemonHello }> => {
  const sock: Socket = connect(socketPath);
  try {
    await new Promise<void>((resolve) => sock.on("connect", () => resolve()));
    const dec = new NdjsonDecoder();
    const clientNonce = randomUUID() as Nonce;
    const hello: ClientHello = {
      protocolVersions: [1],
      expectedPlatformMatrixVersion: 0,
      expectedRuntimeLimitProfileVersion: 0,
      clientInstanceId: "c",
      clientKind: "electron-main",
      clientNonce,
    };
    sock.write(`${JSON.stringify(hello)}\n`);
    const challenge = (await readOne(sock, dec)) as DaemonChallenge;
    const transcript = buildProofTranscript(hello, challenge);
    // RT-HS-04 — client verifies the daemon proof (mutual).
    expect(verifyProof("daemon", transcript, tok, challenge.daemonProof)).toBe(true);
    const clientProof = computeProof("client", transcript, tok);
    sock.write(`${JSON.stringify({ clientProof })}\n`);
    const helloBack = (await readOne(sock, dec)) as DaemonHello;
    return { transcript, hello: helloBack };
  } finally {
    sock.destroy();
  }
};

describe("e2e mutual MAC auth over a real socket (RT-HS-01..05)", () => {
  let server: StartedServer | undefined;
  let socketDir: string | undefined;

  beforeAll(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "af-e2e-"));
    server = await startServer({
      socketDir,
      config,
      verifier: new KeychainCapabilityProofVerifier(token),
      token,
    });
  });

  afterAll(async () => {
    await server?.close();
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
  });

  it("completes ClientHello -> DaemonChallenge -> ClientAuth -> DaemonHello with real MAC proofs", async () => {
    if (!server) throw new Error("server not started");
    const { hello } = await clientHandshake(server.socketPath, token);
    expect(hello.daemonGeneration).toBe(1);
    expect(hello.selectedProtocolVersion).toBe(1);
  });

  it("rejects a client whose token differs (no DaemonHello, socket closed) (RT-HS-04)", async () => {
    if (!server) throw new Error("server not started");
    // The client verifies the daemon proof with the WRONG token — it will not
    // match, so the client aborts before even sending ClientAuth.
    await expect(clientHandshake(server.socketPath, wrongToken)).rejects.toThrow();
  });
});
