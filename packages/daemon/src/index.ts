// Daemon entrypoint. Boots the socket server and prints a machine-parseable
// ready line so the desktop client (and tests) can locate the socket.
//
// Usage: agents-fleet-daemon [--socket-dir <dir>]
//
// RT-HS-04 — resolves the shared capability token (dev token file per
// SV1-AUTH-07, or Keychain in prod) and wires the real mutual-auth verifier.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DevTokenFileTokenSource,
  KeychainTokenSource,
  securityKeychainRunner,
} from "@agents-fleet/transport";
import { KeychainCapabilityProofVerifier } from "./auth/keychain-capability-proof-verifier.js";
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

// SV1-AUTH-07 (dev) / SV1-AUTH-03 (prod read). The Keychain WRITE/ACL/access-
// group path needs a signed binary (R0-02 boundary); the dev token file is the
// testable, non-release path.
const devTokenPath = process.env.AGENTS_FLEET_DEV_TOKEN;
const tokenSource = devTokenPath
  ? new DevTokenFileTokenSource(devTokenPath)
  : new KeychainTokenSource("agents-fleet", "daemon", securityKeychainRunner);
const token = await tokenSource.read();

const server = await startServer({
  socketDir,
  config: {
    supportedProtocolVersions: DAEMON_PROTOCOL_VERSIONS,
    daemonId: DAEMON_ID,
    daemonGeneration: DAEMON_GENERATION,
    platformMatrixVersion: DAEMON_PLATFORM_MATRIX_VERSION,
    runtimeLimitProfileVersion: DAEMON_RUNTIME_LIMIT_PROFILE_VERSION,
  },
  verifier: new KeychainCapabilityProofVerifier(token),
  token,
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
