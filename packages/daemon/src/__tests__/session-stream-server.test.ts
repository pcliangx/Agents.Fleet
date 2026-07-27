import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClientHello,
  DaemonChallenge,
  DaemonHello,
  SessionDeltaBatch,
} from "@agents-fleet/contracts";
import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  decodeFrame,
  NdjsonDecoder,
  verifyProof,
} from "@agents-fleet/transport";
import { afterEach, describe, expect, it } from "vitest";
import { KeychainCapabilityProofVerifier } from "../auth/keychain-capability-proof-verifier.js";
import { type StartedServer, startServer } from "../server.js";

const token = new TextEncoder().encode("r1-08-stream-test");
const roots: string[] = [];
const servers: StartedServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readJson = (socket: Socket, decoder: NdjsonDecoder): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      decoder.feed(chunk);
      const messages = decoder.drain();
      if (messages.length === 0) return;
      socket.off("data", onData);
      resolve(messages[0]);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

const readOneFrame = (socket: Socket): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.byteLength < 4) return;
      const headerLength = pending.readUInt32BE(0);
      if (pending.byteLength < 4 + headerLength) return;
      const header = JSON.parse(pending.subarray(4, 4 + headerLength).toString("utf8")) as {
        readonly payloadLength: number;
      };
      const total = 4 + headerLength + header.payloadLength;
      if (pending.byteLength < total) return;
      socket.off("data", onData);
      resolve(new Uint8Array(pending.subarray(0, total)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

describe("authenticated binary Session stream server", () => {
  it("repeats mutual authentication then emits raw length-prefixed frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "af-stream-server-"));
    roots.push(root);
    let reads = 0;
    const server = await startServer({
      socketDir: root,
      config: {
        supportedProtocolVersions: [1],
        daemonId: "daemon-stream" as never,
        daemonGeneration: 1 as never,
        platformMatrixVersion: PLATFORM_MATRIX_VERSION,
        runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
      },
      verifier: new KeychainCapabilityProofVerifier(token),
      token,
      streams: {
        readSessionDelta(): SessionDeltaBatch {
          reads += 1;
          return {
            attachmentId: "att_1" as never,
            sessionId: "se_1" as never,
            generation: 2 as never,
            durableThroughSeq: 1 as never,
            nextSeq: 2 as never,
            frames:
              reads === 1
                ? [
                    {
                      header: {
                        frameType: "PtyOutput",
                        sessionId: "se_1" as never,
                        generation: 2 as never,
                        seq: 1 as never,
                        payloadLength: 4,
                      },
                      bytes: new Uint8Array([0, 255, 1, 128]),
                    },
                  ]
                : [],
          };
        },
      },
    });
    servers.push(server);

    const socket = connect(server.streamSocketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const decoder = new NdjsonDecoder();
    const hello: ClientHello = {
      protocolVersions: [1],
      expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
      expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
      clientInstanceId: "electron-main-stream-test",
      clientKind: "electron-main",
      clientNonce: "client-stream-nonce" as never,
    };
    socket.write(`${JSON.stringify(hello)}\n`);
    const challenge = (await readJson(socket, decoder)) as DaemonChallenge;
    const transcript = buildProofTranscript(hello, challenge);
    expect(verifyProof("daemon", transcript, token, challenge.daemonProof)).toBe(true);
    socket.write(`${JSON.stringify({ clientProof: computeProof("client", transcript, token) })}\n`);
    const daemonHello = (await readJson(socket, decoder)) as DaemonHello;
    expect(daemonHello.selectedProtocolVersion).toBe(1);

    socket.write(`${JSON.stringify({ attachmentId: "att_1", fromSeq: 1 })}\n`);
    const frame = decodeFrame(await readOneFrame(socket));

    expect(frame.header).toMatchObject({ sessionId: "se_1", generation: 2, seq: 1 });
    expect(frame.payload).toEqual(new Uint8Array([0, 255, 1, 128]));
    socket.destroy();
  });
});
