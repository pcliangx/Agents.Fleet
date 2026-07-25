// Daemon entrypoint. Boots the socket server and prints a machine-parseable
// ready line so the desktop client (and tests) can locate the socket.
//
// Usage: agents-fleet-daemon [--socket-dir <dir>]

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Nonce } from "@agents-fleet/contracts";
import { DevProofVerifier } from "./auth/dev-proof-verifier.js";
import { startServer } from "./server.js";
import {
  DAEMON_GENERATION,
  DAEMON_ID,
  DAEMON_PLATFORM_MATRIX_VERSION,
  DAEMON_PROTOCOL_VERSIONS,
  DAEMON_RUNTIME_LIMIT_PROFILE_VERSION,
} from "./version.js";

const { values } = parseArgs({
  options: { "socket-dir": { type: "string" } },
});
const socketDir = values["socket-dir"] ?? join(homedir(), ".agents-fleet", "run");
const daemonNonce = randomUUID() as Nonce;

const server = await startServer({
  socketDir,
  config: {
    supportedProtocolVersions: DAEMON_PROTOCOL_VERSIONS,
    daemonId: DAEMON_ID,
    daemonGeneration: DAEMON_GENERATION,
    platformMatrixVersion: DAEMON_PLATFORM_MATRIX_VERSION,
    runtimeLimitProfileVersion: DAEMON_RUNTIME_LIMIT_PROFILE_VERSION,
    daemonNonce,
    daemonProof: "dev-proof",
  },
  verifier: new DevProofVerifier(),
});

process.stdout.write(
  `<daemon ready socket=${server.socketPath} daemonId=${DAEMON_ID} generation=${DAEMON_GENERATION}>\n`,
);

process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
