import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationGateway,
  type SystemNotification,
  type SystemNotificationCenter,
  type SystemNotificationResult,
} from "./notification-gateway.js";
import {
  AuthoritativeAttemptWriter,
  openNotificationDb,
  readNotificationSnapshot,
  type SqliteDatabase,
} from "./notification-outbox.js";
import { NotificationActivationSigner } from "./notification-security.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class ScriptedNotificationCenter implements SystemNotificationCenter {
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

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "r0-13-gateway-"));
  dirs.push(dir);
  const db = openNotificationDb(join(dir, "lifecycle.db"));
  dbs.push(db);
  db.prepare("INSERT INTO tasks (task_id) VALUES (?)").run("task-1");
  db.prepare(
    "INSERT INTO attempts (attempt_id, task_id, status, authoritative_state_version) VALUES (?, ?, ?, ?)",
  ).run("attempt-1", "task-1", "Running", 4);
  new AuthoritativeAttemptWriter(db).commitTransitionWithNotification({
    notificationIntentId: "notification-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    expectedStateVersion: 4,
    nextStateVersion: 5,
    nextStatus: "Succeeded",
    eventType: "AttemptSucceeded",
    contentClass: "AttemptCompleted",
    route: { kind: "attempt", taskId: "task-1", attemptId: "attempt-1" },
    createdAtMs: 1_000,
  });
  return { db };
};

const policy = {
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 250,
  notificationPayloadBytes: 1_024,
};
const activationSigner = new NotificationActivationSigner(Buffer.alloc(32, 0x13));

describe("R0-13 notification delivery", () => {
  it("delivers a durable intent without Electron and never redelivers a completed intent", async () => {
    const { db } = setup();
    const center = new ScriptedNotificationCenter([{ status: "Delivered" }]);
    const gateway = new NotificationGateway({ db, center, policy, activationSigner });

    await expect(gateway.dispatchDue(1_000)).resolves.toEqual([
      { notificationIntentId: "notification-1", outcome: "Delivered", attemptNumber: 1 },
    ]);
    await expect(
      new NotificationGateway({ db, center, policy, activationSigner }).dispatchDue(2_000),
    ).resolves.toEqual([]);

    expect(center.deliveries).toHaveLength(1);
    expect(center.deliveries[0]).toMatchObject({
      notificationId: "notification-1",
      title: "Agent task completed",
      body: "An attempt finished successfully.",
    });
    const snapshot = readNotificationSnapshot(db);
    expect(snapshot.notificationIntents[0]).toMatchObject({
      deliveryState: "Delivered",
      attemptCount: 1,
      lastErrorCode: null,
    });
    expect(snapshot.deliveryObservations).toEqual([
      {
        observationId: 1,
        notificationIntentId: "notification-1",
        attemptNumber: 1,
        outcome: "Delivered",
        errorCode: null,
        observedAtMs: 1_000,
      },
    ]);
    expect(snapshot.attempts[0]).toMatchObject({
      status: "Succeeded",
      authoritativeStateVersion: 5,
    });
  });

  it("uses bounded backoff and terminates after the configured failure limit", async () => {
    const { db } = setup();
    const center = new ScriptedNotificationCenter([
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
      { status: "Failed", errorCode: "CENTER_UNAVAILABLE" },
    ]);
    const gateway = new NotificationGateway({ db, center, policy, activationSigner });

    await expect(gateway.dispatchDue(1_000)).resolves.toEqual([
      { notificationIntentId: "notification-1", outcome: "RetryScheduled", attemptNumber: 1 },
    ]);
    expect(readNotificationSnapshot(db).notificationIntents[0]).toMatchObject({
      deliveryState: "Pending",
      attemptCount: 1,
      nextAttemptAtMs: 1_100,
    });
    await expect(gateway.dispatchDue(1_099)).resolves.toEqual([]);
    await expect(gateway.dispatchDue(1_100)).resolves.toEqual([
      { notificationIntentId: "notification-1", outcome: "RetryScheduled", attemptNumber: 2 },
    ]);
    expect(readNotificationSnapshot(db).notificationIntents[0]?.nextAttemptAtMs).toBe(1_300);
    await expect(gateway.dispatchDue(1_300)).resolves.toEqual([
      { notificationIntentId: "notification-1", outcome: "Failed", attemptNumber: 3 },
    ]);
    await expect(gateway.dispatchDue(99_999)).resolves.toEqual([]);

    const snapshot = readNotificationSnapshot(db);
    expect(center.deliveries).toHaveLength(3);
    expect(snapshot.notificationIntents[0]).toMatchObject({
      deliveryState: "Failed",
      attemptCount: 3,
      lastErrorCode: "CENTER_UNAVAILABLE",
    });
    expect(snapshot.deliveryObservations.map((item) => item.outcome)).toEqual([
      "RetryScheduled",
      "RetryScheduled",
      "Failed",
    ]);
    expect(snapshot.attempts[0]).toMatchObject({
      status: "Succeeded",
      authoritativeStateVersion: 5,
    });
  });

  it("stores only a bounded stable error code from the external adapter", async () => {
    const { db } = setup();
    const center = new ScriptedNotificationCenter([
      {
        status: "Failed",
        errorCode: "SECRET dynamic adapter detail: /Users/alice/private/repository",
      },
    ]);
    const gateway = new NotificationGateway({
      db,
      center,
      policy: { ...policy, maxAttempts: 1 },
      activationSigner,
    });

    await gateway.dispatchDue(1_000);

    expect(readNotificationSnapshot(db).notificationIntents[0]?.lastErrorCode).toBe("CENTER_ERROR");
    expect(readNotificationSnapshot(db).deliveryObservations[0]?.errorCode).toBe("CENTER_ERROR");
  });
});
