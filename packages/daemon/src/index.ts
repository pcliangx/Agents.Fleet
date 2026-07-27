// Daemon entrypoint. Boots the socket server and prints a machine-parseable
// ready line so the desktop client (and tests) can locate the socket.
//
// Usage: agents-fleet-daemon [--socket-dir <dir>] [--db-path <path>]
//
// RT-HS-04 — resolves the shared capability token (dev token file per
// SV1-AUTH-07, or Keychain in prod) and wires the real mutual-auth verifier.
//
// R1-02 composition root: opens the lifecycle database (default
// ~/.agents-fleet/data/fleet.db, overridable via --db-path or
// AGENTS_FLEET_DB) and wires the Repository Trust production chain
// (RepositoryTrustStore + IdempotencyStore + PersistentChallengeIssuer +
// RestrictedGitRunner + TrustService) into a TrustCommandRouter shared by
// every connection's ControlDispatcher. A read-only-recovery open
// (RT-STATE-27) still boots: mutating commands fail RecoveryRequired while
// the bounded read-only queries remain available on the readable handle.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  DevTokenFileTokenSource,
  KeychainTokenSource,
  securityKeychainRunner,
} from "@agents-fleet/transport";
import { KeychainCapabilityProofVerifier } from "./auth/keychain-capability-proof-verifier.js";
import { PersistentChallengeIssuer } from "./confirmation/persistent-challenge-issuer.js";
import { RestrictedGitRunner } from "./git/restricted-git.js";
import { TrustCommandRouter } from "./repository-trust/trust-command-router.js";
import { TrustService } from "./repository-trust/trust-service.js";
import { startServer } from "./server.js";
import { openDatabase } from "./storage/database.js";
import { IdempotencyStore } from "./storage/idempotency.js";
import { ALL_MIGRATIONS } from "./storage/migrations.js";
import {
  DAEMON_GENERATION,
  DAEMON_ID,
  DAEMON_PLATFORM_MATRIX_VERSION,
  DAEMON_PROTOCOL_VERSIONS,
  DAEMON_RUNTIME_LIMIT_PROFILE_VERSION,
} from "./version.js";

const { values } = parseArgs({
  options: { "socket-dir": { type: "string" }, "db-path": { type: "string" } },
});
const socketDir = values["socket-dir"] ?? join(homedir(), ".agents-fleet", "run");
const dbPath =
  values["db-path"] ??
  process.env.AGENTS_FLEET_DB ??
  join(homedir(), ".agents-fleet", "data", "fleet.db");

// SV1-AUTH-07 (dev) / SV1-AUTH-03 (prod read). The Keychain WRITE/ACL/access-
// group path needs a signed binary (R0-02 boundary); the dev token file is the
// testable, non-release path.
const devTokenPath = process.env.AGENTS_FLEET_DEV_TOKEN;
const tokenSource = devTokenPath
  ? new DevTokenFileTokenSource(devTokenPath)
  : new KeychainTokenSource("agents-fleet", "daemon", securityKeychainRunner);
const token = await tokenSource.read();

// RT-STO-05/06 — open with the full migration registry. The same capability
// token keys the receipt MAC verification (SV1-TRUST-09): Main signs with it,
// the PersistentChallengeIssuer verifies with it.
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const opened = openDatabase({ path: dbPath, migrations: ALL_MIGRATIONS });

let router: TrustCommandRouter;
if (opened.kind === "ready") {
  if (opened.backupsCreated.length > 0) {
    process.stderr.write(
      `<daemon info backups-created=${opened.backupsCreated.length} path=${dbPath}>\n`,
    );
  }
  const db = opened.db;
  const idem = new IdempotencyStore(db);
  const challenges = new PersistentChallengeIssuer({ db, token });
  const runner = new RestrictedGitRunner();
  const service = new TrustService({ db, challenges, idem, runner });
  router = new TrustCommandRouter({ service, challenges });
} else {
  // RT-STATE-27 — read-only recovery. Keep the daemon up for bounded
  // diagnostics; every state-changing command fails RecoveryRequired. When a
  // readable handle survived, the read-only queries stay available on it.
  process.stderr.write(`<daemon recovery reason=${JSON.stringify(opened.reason)}>\n`);
  if (opened.db !== null) {
    const db = opened.db;
    const idem = new IdempotencyStore(db);
    const challenges = new PersistentChallengeIssuer({ db, token });
    const service = new TrustService({ db, challenges, idem, runner: new RestrictedGitRunner() });
    router = new TrustCommandRouter({ service, challenges, recoveryReason: opened.reason });
  } else {
    router = new TrustCommandRouter({
      service: null,
      challenges: null,
      recoveryReason: opened.reason,
    });
  }
}

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
  router,
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
