// R1-02 — DaemonClient command channel over a real socket with a fake daemon:
// the RT-HS-04 handshake is preserved (mutual MAC proofs), responses are
// matched to requests by commandId (out-of-order answers included), a bounded
// timeout rejects the pending command, and a connection drop rejects every
// pending request.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientHello, DaemonChallenge } from "@agents-fleet/contracts";
import { buildProofTranscript, computeProof, NdjsonDecoder } from "@agents-fleet/transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient, isCommandError } from "./daemon-client.js";

const TOKEN = new TextEncoder().encode("r1-02-daemon-client-token");

type CommandHandler = (
  cmd: { commandId: string; payload: { kind: string } },
  reply: (msg: unknown) => void,
) => void;

let server: Server;
let socketDir: string;
let socketPath: string;
let onCommand: CommandHandler = () => {};
const sockets = new Set<Socket>();

beforeAll(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "af-client-test-"));
  socketPath = join(socketDir, "daemon.sock");
  server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    const dec = new NdjsonDecoder();
    let helloSeen: ClientHello | undefined;
    sock.on("data", (chunk: Buffer) => {
      dec.feed(chunk);
      for (const obj of dec.drain()) {
        const msg = obj as Record<string, unknown>;
        if (helloSeen === undefined) {
          helloSeen = obj as ClientHello;
          const challenge = {
            selectedProtocolVersion: 1,
            daemonNonce: "dn",
            daemonProof: "",
          } as unknown as DaemonChallenge;
          const transcript = buildProofTranscript(helloSeen, challenge);
          sock.write(
            `${JSON.stringify({ ...challenge, daemonProof: computeProof("daemon", transcript, TOKEN) })}\n`,
          );
          return;
        }
        if (typeof msg.clientProof === "string") {
          sock.write(
            `${JSON.stringify({
              selectedProtocolVersion: 1,
              daemonId: "d",
              daemonGeneration: 1,
              platformMatrixVersion: "pm",
              runtimeLimitProfileVersion: "rl",
              capabilities: [],
            })}\n`,
          );
          return;
        }
        onCommand(msg as never, (reply) => sock.write(`${JSON.stringify(reply)}\n`));
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(socketDir, { recursive: true, force: true });
});

const cmd = (kind: string, commandId: string) => ({
  commandId,
  schemaVersion: 1,
  payload: { kind },
});

describe("DaemonClient command channel", () => {
  it("completes the handshake and matches responses by commandId, even out of order", async () => {
    onCommand = (c, reply) => {
      // Answer c2 immediately, c1 after a tick — the client must not confuse them.
      if (c.commandId === "c1") setTimeout(() => reply({ commandId: "c1", result: "one" }), 20);
      if (c.commandId === "c2") reply({ commandId: "c2", result: "two" });
    };
    const client = await DaemonClient.connect({ socketPath, token: TOKEN });
    try {
      expect(client.hello.daemonGeneration).toBe(1);
      const [r1, r2] = await Promise.all([
        client.sendCommand(cmd("PrepareTrustCandidate", "c1")),
        client.sendCommand(cmd("InspectRepositoryTrust", "c2")),
      ]);
      expect(r1).toEqual({ commandId: "c1", result: "one" });
      expect(r2).toEqual({ commandId: "c2", result: "two" });
    } finally {
      client.close();
    }
  });

  it("resolves domain error responses instead of rejecting", async () => {
    onCommand = (c, reply) =>
      reply({
        error: { code: "Conflict", message: "nope", retryable: false, commandId: c.commandId },
      });
    const client = await DaemonClient.connect({ socketPath, token: TOKEN });
    try {
      const r = await client.sendCommand(cmd("RevokeRepositoryTrust", "c9"));
      expect(isCommandError(r)).toBe(true);
      if (isCommandError(r)) expect(r.error.code).toBe("Conflict");
    } finally {
      client.close();
    }
  });

  it("rejects a pending command on timeout", async () => {
    onCommand = () => {}; // daemon never answers
    const client = await DaemonClient.connect({ socketPath, token: TOKEN });
    try {
      await expect(
        client.sendCommand(cmd("GetConfirmationChallenge", "slow"), { timeoutMs: 50 }),
      ).rejects.toThrow("command timeout");
    } finally {
      client.close();
    }
  });

  it("rejects all pending commands when the connection drops", async () => {
    onCommand = (c, _reply) => {
      if (c.commandId === "die") {
        // Simulate a daemon crash: every live connection drops.
        for (const s of sockets) s.destroy();
      }
    };
    const client = await DaemonClient.connect({ socketPath, token: TOKEN });
    const pending = client.sendCommand(cmd("PrepareTrustCandidate", "die"));
    await expect(pending).rejects.toThrow();
  });
});
