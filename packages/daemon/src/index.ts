// Daemon entrypoint. Boots the socket server and prints a machine-parseable
// ready line so the desktop client (and tests) can locate the socket.
//
// Usage: agents-fleet-daemon [--socket-dir <dir>] [--db-path <path>]
//
// RT-HS-04 — resolves the shared capability token (dev token file per
// SV1-AUTH-07, or Keychain in prod) and wires the real mutual-auth verifier.
//
// R1-07 composition root: opens the lifecycle database (default
// ~/.agents-fleet/data/fleet.db, overridable via --db-path or
// AGENTS_FLEET_DB) and wires Trust, Worktree, Task, Session and launch modules
// behind the authenticated Control Dispatcher. A read-only-recovery open
// (RT-STATE-27) still boots: mutating commands fail RecoveryRequired while
// bounded read-only queries remain available on the readable handle.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  DevTokenFileTokenSource,
  KeychainTokenSource,
  securityKeychainRunner,
} from "@agents-fleet/transport";
import { ClaudeCodeAdapter } from "./agent-adapters/claude-code-adapter.js";
import { KeychainCapabilityProofVerifier } from "./auth/keychain-capability-proof-verifier.js";
import { PersistentChallengeIssuer } from "./confirmation/persistent-challenge-issuer.js";
import type { CommandRouter } from "./control-dispatcher.js";
import { FleetProjection } from "./fleet-projection/fleet-projection.js";
import { RestrictedGitRunner } from "./git/restricted-git.js";
import { LocalHostEnvironment } from "./host-environment/host-environment.js";
import { TrustCommandRouter } from "./repository-trust/trust-command-router.js";
import { TrustService } from "./repository-trust/trust-service.js";
import { ReadOnlyRecoveryCommandRouter, RuntimeCommandRouter } from "./runtime-command-router.js";
import { startServer } from "./server.js";
import { createNodePtyProcessSupervisor } from "./session-runtime/process-supervisor.js";
import { SessionRuntime } from "./session-runtime/session-runtime.js";
import { runStartupReconciliation } from "./startup-reconciliation.js";
import { AgentProfileStore } from "./storage/agent-profile-store.js";
import { openDatabase } from "./storage/database.js";
import { EnvironmentSnapshotStore } from "./storage/environment-snapshot-store.js";
import { IdempotencyStore } from "./storage/idempotency.js";
import { ALL_MIGRATIONS } from "./storage/migrations.js";
import { RepositoryTrustStore } from "./storage/repository-trust-store.js";
import { StoreError, TaskStore } from "./storage/task-store.js";
import { WorktreeStore } from "./storage/worktree-store.js";
import { LaunchCommandCoordinator } from "./task-orchestrator/launch-command-coordinator.js";
import { TaskOrchestrator } from "./task-orchestrator/task-orchestrator.js";
import {
  DAEMON_GENERATION,
  DAEMON_ID,
  DAEMON_PLATFORM_MATRIX_VERSION,
  DAEMON_PROTOCOL_VERSIONS,
  DAEMON_RUNTIME_LIMIT_PROFILE_VERSION,
} from "./version.js";
import { WorktreeManagerImpl } from "./worktree-manager/worktree-manager.js";

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

let router: CommandRouter;
let sessionStreams: SessionRuntime | undefined;
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
  const trustRouter = new TrustCommandRouter({ service, challenges });
  const worktreeStore = new WorktreeStore(db);
  const worktrees = new WorktreeManagerImpl({
    db,
    store: worktreeStore,
    idempotency: idem,
  });
  const runtimeStoreDir = join(dirname(dbPath), "runtime");
  mkdirSync(runtimeStoreDir, { recursive: true, mode: 0o700 });
  const sessions = new SessionRuntime({
    db,
    storeDir: runtimeStoreDir,
    processSupervisor: createNodePtyProcessSupervisor(),
    confirmations: challenges,
  });
  sessionStreams = sessions;
  let launches: LaunchCommandCoordinator;
  const taskOrchestrator = new TaskOrchestrator({
    db,
    sessions,
    prepareLaunch: async (attempt) => launches.prepareScheduledLaunch(attempt),
  });
  const hostEnvironment = new LocalHostEnvironment({
    appDataRoot: dirname(dbPath),
    explicitPathEntries: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"],
  });
  const claude = new ClaudeCodeAdapter({
    candidateExecutablePath: process.env.AGENTS_FLEET_CLAUDE_PATH ?? "/usr/local/bin/claude",
    hostEnvironment,
  });
  launches = new LaunchCommandCoordinator({
    db,
    idempotency: idem,
    challenges,
    profiles: new AgentProfileStore(db),
    environments: new EnvironmentSnapshotStore(db),
    trustStore: new RepositoryTrustStore(db),
    worktreeStore,
    worktrees,
    git: runner,
    hostEnvironment,
    adapterFor: (agentId) => {
      if (agentId !== claude.agentId) {
        throw new StoreError("CapabilityUnavailable", "Agent Adapter is unavailable");
      }
      return claude;
    },
    managedWorktreeRoot: join(dirname(dbPath), "worktrees"),
  });
  const startup = await runStartupReconciliation({
    sessions,
    revalidateAcceptedAttempt: async (attemptId) =>
      await launches.revalidateAcceptedAttempt(attemptId),
  });
  const integrity = startup.reconciliation.dataIntegrity;
  if (
    startup.reconciliation.actions.length > 0 ||
    startup.resumedLaunches.length > 0 ||
    integrity.adoptedOrphanCount > 0 ||
    integrity.isolatedOrphanCount > 0 ||
    integrity.dataGapCount > 0 ||
    integrity.uncertainInputIntentCount > 0 ||
    integrity.inputDataGapCount > 0 ||
    integrity.isolatedInputOrphanCount > 0
  ) {
    process.stderr.write(
      `<daemon reconciliation actions=${startup.reconciliation.actions.length} resumed=${startup.resumedLaunches.length} dataGaps=${integrity.dataGapCount + integrity.inputDataGapCount}>\n`,
    );
  }
  router = new RuntimeCommandRouter({
    db,
    idempotency: idem,
    challenges,
    taskOrchestrator,
    taskStore: new TaskStore(db),
    fleetProjection: new FleetProjection(db),
    launches,
    autoLaunch: true,
    sessions,
    worktrees,
    fallback: trustRouter,
  });
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
    const trustRouter = new TrustCommandRouter({
      service,
      challenges,
      recoveryReason: opened.reason,
    });
    router = new ReadOnlyRecoveryCommandRouter(trustRouter, opened.reason);
  } else {
    const trustRouter = new TrustCommandRouter({
      service: null,
      challenges: null,
      recoveryReason: opened.reason,
    });
    router = new ReadOnlyRecoveryCommandRouter(trustRouter, opened.reason);
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
  ...(sessionStreams === undefined ? {} : { streams: sessionStreams }),
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
