import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DispatchOutcome,
  NotificationGateway,
  type SystemNotification,
  type SystemNotificationCenter,
  type SystemNotificationResult,
} from "./notification-gateway.js";
import {
  AuthoritativeAttemptWriter,
  notificationDedupeKey,
  openNotificationDb,
  parseNotificationRoute,
  readNotificationSnapshot,
  type SqliteDatabase,
} from "./notification-outbox.js";
import {
  NotificationActivationAuthenticator,
  NotificationActivationSigner,
} from "./notification-security.js";
import {
  PersistentFakeNotificationCenter,
  readPersistentCenterSnapshot,
} from "./persistent-fake-notification-center.js";

const here = dirname(fileURLToPath(import.meta.url));
const CRASH_CHILD = join(here, "children", "gateway-child.ts");
const ACTIVATION_SECRET = Buffer.alloc(32, 0x13);

export const PROBE_POLICY = {
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 250,
  notificationPayloadBytes: 1_024,
} as const;

class ScriptedCenter implements SystemNotificationCenter {
  readonly deliveries: SystemNotification[] = [];
  readonly #results: SystemNotificationResult[];

  constructor(results: SystemNotificationResult[]) {
    this.#results = results;
  }

  async deliver(notification: SystemNotification): Promise<SystemNotificationResult> {
    this.deliveries.push(notification);
    return this.#results.shift() ?? { status: "Delivered" };
  }
}

const seed = (db: SqliteDatabase): AuthoritativeAttemptWriter => {
  db.prepare("INSERT INTO tasks (task_id) VALUES (?)").run("task-1");
  db.prepare(
    "INSERT INTO attempts (attempt_id, task_id, status, authoritative_state_version) VALUES (?, ?, ?, ?)",
  ).run("attempt-1", "task-1", "Running", 4);
  return new AuthoritativeAttemptWriter(db);
};

const transition = {
  notificationIntentId: "notification-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  expectedStateVersion: 4,
  nextStateVersion: 5,
  nextStatus: "Succeeded",
  eventType: "AttemptSucceeded",
  contentClass: "AttemptCompleted",
  route: { kind: "attempt", taskId: "task-1", attemptId: "attempt-1" } as const,
  createdAtMs: 1_000,
};

const attemptFact = (snapshot: ReturnType<typeof readNotificationSnapshot>): string =>
  JSON.stringify(snapshot.attempts[0]);

const throws = (work: () => unknown): boolean => {
  try {
    work();
    return false;
  } catch {
    return true;
  }
};

const resolveTsxLoader = (): string => {
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("tsx loader not found");
};

const runCrashChild = (
  configPath: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", resolveTsxLoader(), CRASH_CHILD, configPath],
      { stdio: "pipe" },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gateway child timed out: ${stderr}`));
    }, 10_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`gateway child exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

export interface NotificationProbeResult {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly allChecksPass: boolean;
  readonly measurements: {
    readonly retryTimelineMs: {
      readonly firstAttempt: number;
      readonly earlyPoll: number;
      readonly secondAttempt: number;
      readonly thirdAttempt: number;
      readonly terminalPoll: number;
    };
    readonly notificationPayloadBytes: number;
    readonly crashExternalDeliveryCalls: number;
    readonly crashVisibleNotificationCount: number;
  };
  readonly atomicSnapshot: ReturnType<typeof readNotificationSnapshot>;
  readonly deliveredSnapshot: ReturnType<typeof readNotificationSnapshot>;
  readonly failedSnapshot: ReturnType<typeof readNotificationSnapshot>;
  readonly crashSnapshot: ReturnType<typeof readNotificationSnapshot>;
  readonly dispatchOutcomes: {
    readonly delivered: readonly DispatchOutcome[];
    readonly retries: readonly DispatchOutcome[];
    readonly crashRecovery: readonly DispatchOutcome[];
  };
}

export const runNotificationGatewayProbe = async (): Promise<NotificationProbeResult> => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-13-evidence-"));
  const signer = new NotificationActivationSigner(ACTIVATION_SECRET);
  const authenticator = new NotificationActivationAuthenticator(ACTIVATION_SECRET);

  try {
    const atomicDb = openNotificationDb(join(workDir, "atomic.db"));
    const atomicWriter = seed(atomicDb);
    const inserted = atomicWriter.commitTransitionWithNotification(transition);
    const replayed = atomicWriter.commitTransitionWithNotification(transition);
    const atomicSnapshot = readNotificationSnapshot(atomicDb);
    atomicDb.close();

    const rollbackDb = openNotificationDb(join(workDir, "rollback.db"));
    const rollbackWriter = seed(rollbackDb);
    rollbackDb
      .prepare(
        `INSERT INTO notification_intents (
           notification_intent_id, dedupe_key, task_id, attempt_id,
           authoritative_state_version, event_type, route_json, content_class,
           created_at_ms, delivery_state, attempt_count, next_attempt_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?)`,
      )
      .run(
        "conflicting-notification",
        "different-dedupe-key",
        "task-1",
        "attempt-1",
        5,
        "AttemptFailed",
        '{"kind":"attempt","taskId":"task-1","attemptId":"attempt-1"}',
        "AttemptNeedsAttention",
        900,
        900,
      );
    const rollbackRejected = throws(() =>
      rollbackWriter.commitTransitionWithNotification(transition),
    );
    const rollbackSnapshot = readNotificationSnapshot(rollbackDb);
    rollbackDb.close();

    const deliveredDb = openNotificationDb(join(workDir, "delivered.db"));
    const deliveredWriter = seed(deliveredDb);
    const hostileTransition = {
      ...transition,
      title: "SECRET_api_key_should_not_escape",
      transcript: "private transcript SECRET_api_key_should_not_escape",
      input: "rm -rf /",
      osc: "\u001b]8;;file:///private/repository\u0007click\u001b]8;;\u0007",
      repositoryPath: "/Users/alice/private/customer-repository",
    };
    deliveredWriter.commitTransitionWithNotification(hostileTransition);
    const deliveredCenter = new ScriptedCenter([{ status: "Delivered" }]);
    const deliveredGateway = new NotificationGateway({
      db: deliveredDb,
      center: deliveredCenter,
      policy: PROBE_POLICY,
      activationSigner: signer,
    });
    const attemptBeforeDelivery = attemptFact(readNotificationSnapshot(deliveredDb));
    const deliveredOutcomes = await deliveredGateway.dispatchDue(1_000);
    const notification = deliveredCenter.deliveries[0];
    if (notification === undefined) throw new Error("delivery fixture produced no notification");
    const activation = authenticator.authenticate(notification.activationData);
    deliveredGateway.acknowledgeAuthenticatedActivation(activation);
    const ignoredOutcome = await deliveredGateway.dispatchDue(2_000);
    const deliveredSnapshot = readNotificationSnapshot(deliveredDb);
    const attemptAfterClick = attemptFact(deliveredSnapshot);
    const serializedNotification = JSON.stringify(notification);
    const forbiddenValues = [
      "SECRET_api_key_should_not_escape",
      "private transcript",
      "rm -rf",
      "file://",
      "/Users/alice",
      "customer-repository",
      "\u001b]",
    ];
    const tamperedActivationRejected = throws(() =>
      authenticator.authenticate(`${notification.activationData}x`),
    );
    const rawRouteRejected = throws(() =>
      authenticator.authenticate(
        JSON.stringify({ url: "file:///private/repository", argv: ["open", "Terminal"] }),
      ),
    );
    const bindingDriftRejected = throws(() =>
      deliveredGateway.acknowledgeAuthenticatedActivation(
        authenticator.authenticate(
          signer.sign({
            notificationIntentId: "notification-1",
            route: { kind: "attempt", taskId: "task-1", attemptId: "other-attempt" },
          }),
        ),
      ),
    );
    const overPrivilegedRouteRejected = throws(() =>
      parseNotificationRoute({
        kind: "attempt",
        taskId: "task-1",
        attemptId: "attempt-1",
        url: "file:///private/repository",
      }),
    );
    deliveredDb.close();

    const failedDb = openNotificationDb(join(workDir, "failed.db"));
    seed(failedDb).commitTransitionWithNotification(transition);
    const failedCenter = new ScriptedCenter([
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
    ]);
    const failedGateway = new NotificationGateway({
      db: failedDb,
      center: failedCenter,
      policy: PROBE_POLICY,
      activationSigner: signer,
    });
    const attemptBeforeFailures = attemptFact(readNotificationSnapshot(failedDb));
    const retryOutcomes = [
      ...(await failedGateway.dispatchDue(1_000)),
      ...(await failedGateway.dispatchDue(1_099)),
      ...(await failedGateway.dispatchDue(1_100)),
      ...(await failedGateway.dispatchDue(1_300)),
      ...(await failedGateway.dispatchDue(99_999)),
    ];
    const failedSnapshot = readNotificationSnapshot(failedDb);
    const attemptAfterFailures = attemptFact(failedSnapshot);
    failedDb.close();

    const crashDbPath = join(workDir, "crash.db");
    const centerDbPath = join(workDir, "system-notification-center.db");
    const crashDb = openNotificationDb(crashDbPath);
    seed(crashDb).commitTransitionWithNotification(transition);
    crashDb.close();
    const childConfigPath = join(workDir, "gateway-child.json");
    writeFileSync(
      childConfigPath,
      JSON.stringify({
        lifecycleDbPath: crashDbPath,
        centerDbPath,
        policy: PROBE_POLICY,
        nowMs: 1_000,
      }),
    );
    const crashExit = await runCrashChild(childConfigPath);
    const afterCrashDb = openNotificationDb(crashDbPath);
    const afterCrashSnapshot = readNotificationSnapshot(afterCrashDb);
    const visibleAfterCrash = readPersistentCenterSnapshot(centerDbPath);
    const restartedCenter = new PersistentFakeNotificationCenter(centerDbPath);
    const restartedGateway = new NotificationGateway({
      db: afterCrashDb,
      center: restartedCenter,
      policy: PROBE_POLICY,
      activationSigner: signer,
    });
    const crashRecoveryOutcomes = await restartedGateway.dispatchDue(1_001);
    const crashTerminalReplay = await restartedGateway.dispatchDue(2_000);
    const crashSnapshot = readNotificationSnapshot(afterCrashDb);
    const crashCenterSnapshot = readPersistentCenterSnapshot(centerDbPath);
    afterCrashDb.close();

    const expectedDedupeKey = notificationDedupeKey({
      eventType: "AttemptSucceeded",
      taskId: "task-1",
      attemptId: "attempt-1",
      authoritativeStateVersion: 5,
    });
    const checks = {
      atomicTransitionAndIntent:
        atomicSnapshot.attempts[0]?.status === "Succeeded" &&
        atomicSnapshot.notificationIntents[0]?.deliveryState === "Pending",
      exactDedupeKey: inserted.dedupeKey === expectedDedupeKey,
      replayDeduped:
        inserted.notificationIntentId === replayed.notificationIntentId &&
        atomicSnapshot.notificationIntents.length === 1,
      atomicRollback:
        rollbackRejected &&
        rollbackSnapshot.attempts[0]?.status === "Running" &&
        rollbackSnapshot.attempts[0]?.authoritativeStateVersion === 4,
      deliveredWithoutElectron:
        deliveredOutcomes[0]?.outcome === "Delivered" && deliveredCenter.deliveries.length === 1,
      terminalIntentIgnored: ignoredOutcome.length === 0,
      boundedRetry:
        retryOutcomes.map((outcome) => outcome.outcome).join(",") ===
        "RetryScheduled,RetryScheduled,Failed",
      retryExhausted:
        failedSnapshot.notificationIntents[0]?.deliveryState === "Failed" &&
        failedCenter.deliveries.length === PROBE_POLICY.maxAttempts,
      deliveryNeverChangesAttempt:
        attemptBeforeDelivery === attemptAfterClick &&
        attemptBeforeFailures === attemptAfterFailures,
      minimalLockScreenContent: forbiddenValues.every(
        (value) => !serializedNotification.includes(value),
      ),
      payloadBounded:
        Buffer.byteLength(serializedNotification, "utf8") <= PROBE_POLICY.notificationPayloadBytes,
      authenticatedStableRoute:
        activation.route.kind === "attempt" &&
        activation.route.taskId === "task-1" &&
        activation.route.attemptId === "attempt-1",
      tamperedActivationRejected,
      rawRouteRejected,
      bindingDriftRejected,
      overPrivilegedRouteRejected,
      crashAtExternalBoundary:
        crashExit.signal === "SIGKILL" &&
        afterCrashSnapshot.notificationIntents[0]?.deliveryState === "Pending" &&
        visibleAfterCrash.visibleNotifications.length === 1,
      crashReplayUsesStableIdentity:
        crashCenterSnapshot.deliveryCalls === 2 &&
        crashCenterSnapshot.visibleNotifications.length === 1 &&
        crashCenterSnapshot.visibleNotifications[0]?.displayCount === 1,
      crashRecoveryConverged:
        crashRecoveryOutcomes[0]?.outcome === "Delivered" &&
        crashTerminalReplay.length === 0 &&
        crashSnapshot.notificationIntents[0]?.deliveryState === "Delivered",
      crashRecoveryNeverChangesAttempt:
        crashSnapshot.attempts[0]?.status === "Succeeded" &&
        crashSnapshot.attempts[0]?.authoritativeStateVersion === 5,
    } as const;

    return {
      checks,
      allChecksPass: Object.values(checks).every(Boolean),
      measurements: {
        retryTimelineMs: {
          firstAttempt: 1_000,
          earlyPoll: 1_099,
          secondAttempt: 1_100,
          thirdAttempt: 1_300,
          terminalPoll: 99_999,
        },
        notificationPayloadBytes: Buffer.byteLength(serializedNotification, "utf8"),
        crashExternalDeliveryCalls: crashCenterSnapshot.deliveryCalls,
        crashVisibleNotificationCount: crashCenterSnapshot.visibleNotifications.length,
      },
      atomicSnapshot,
      deliveredSnapshot,
      failedSnapshot,
      crashSnapshot,
      dispatchOutcomes: {
        delivered: deliveredOutcomes,
        retries: retryOutcomes,
        crashRecovery: crashRecoveryOutcomes,
      },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};
