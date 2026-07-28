// Daemon socket server. Listens on a Unix socket in a 0700 dir, socket chmod
// 0600 (SV1-AUTH-02). Each connection wires an NDJSON decoder into a
// ControlDispatcher. Mutual-auth hardening is #11; #1 uses DevProofVerifier.

import { chmod, mkdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { type DaemonHandshakeConfig, NdjsonDecoder } from "@agents-fleet/transport";
import type { ProofVerifier } from "./auth/proof-verifier.js";
import {
  type CommandRouter,
  type ConnectionSink,
  ControlDispatcher,
} from "./control-dispatcher.js";
import { createSessionStreamServer, type SessionStreamProvider } from "./session-stream-server.js";

export interface StartServerOptions {
  readonly socketDir: string;
  readonly config: DaemonHandshakeConfig;
  readonly verifier: ProofVerifier;
  readonly token: Uint8Array;
  /** Production command router; omitted in handshake-only tests. */
  readonly router?: CommandRouter;
  readonly streams?: SessionStreamProvider;
}

export interface StartedServer {
  readonly socketPath: string;
  readonly streamSocketPath: string;
  close(): Promise<void>;
}

export const startServer = async (opts: StartServerOptions): Promise<StartedServer> => {
  await mkdir(opts.socketDir, { recursive: true, mode: 0o700 });
  await chmod(opts.socketDir, 0o700);
  const socketPath = join(opts.socketDir, "daemon.sock");
  const streamSocketPath = join(opts.socketDir, "stream.sock");

  const server = createServer((sock: Socket) => {
    const decoder = new NdjsonDecoder();
    const sink: ConnectionSink = {
      send: (m) =>
        sock.write(
          `${JSON.stringify(m, (_key, value: unknown) =>
            value instanceof Uint8Array ? Array.from(value) : value,
          )}\n`,
        ),
      close: () => sock.destroy(),
    };
    const dispatcher = new ControlDispatcher(
      opts.config,
      opts.verifier,
      sink,
      opts.token,
      opts.router,
    );
    sock.on("data", (chunk: Buffer) => {
      decoder.feed(chunk);
      for (const obj of decoder.drain()) dispatcher.onMessage(obj);
    });
    sock.once("close", () => dispatcher.onControlConnectionClosed());
    sock.on("error", () => {
      // #1: swallow per-connection errors; hardening comes with reconciliation.
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  await chmod(socketPath, 0o600).catch(() => {});
  const stream = createSessionStreamServer({
    config: opts.config,
    verifier: opts.verifier,
    token: opts.token,
    ...(opts.streams === undefined ? {} : { streams: opts.streams }),
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    stream.server.once("error", onError);
    stream.server.listen(streamSocketPath, () => {
      stream.server.removeListener("error", onError);
      resolve();
    });
  });
  await chmod(streamSocketPath, 0o600).catch(() => {});

  return {
    socketPath,
    streamSocketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of stream.sockets) socket.destroy();
        let remaining = 2;
        const closed = () => {
          remaining -= 1;
          if (remaining === 0) resolve();
        };
        server.close(closed);
        stream.server.close(closed);
      }),
  };
};
