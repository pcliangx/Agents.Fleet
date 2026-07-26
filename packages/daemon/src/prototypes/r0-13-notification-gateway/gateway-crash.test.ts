import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCrashChild } from "./crash-child-runner.js";
import { NotificationGateway } from "./notification-gateway.js";
import {
  AuthoritativeAttemptWriter,
  openNotificationDb,
  readNotificationSnapshot,
} from "./notification-outbox.js";
import { NotificationActivationSigner } from "./notification-security.js";
import {
  PersistentFakeNotificationCenter,
  readPersistentCenterSnapshot,
} from "./persistent-fake-notification-center.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "children", "gateway-child.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const policy = {
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 250,
  notificationPayloadBytes: 1_024,
};
const activationSigner = new NotificationActivationSigner(Buffer.alloc(32, 0x13));

describe("R0-13 notification crash recovery", () => {
  it("replays the same system identity after a post-display crash without a second visible notification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r0-13-crash-"));
    dirs.push(dir);
    const lifecycleDbPath = join(dir, "lifecycle.db");
    const centerDbPath = join(dir, "system-notification-center.db");
    const db = openNotificationDb(lifecycleDbPath);
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
    db.close();

    const configPath = join(dir, "gateway-child.json");
    writeFileSync(
      configPath,
      JSON.stringify({ lifecycleDbPath, centerDbPath, policy, nowMs: 1_000 }),
    );
    await expect(runCrashChild(CHILD, configPath)).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });

    const afterCrashDb = openNotificationDb(lifecycleDbPath);
    expect(readNotificationSnapshot(afterCrashDb).notificationIntents[0]).toMatchObject({
      deliveryState: "Pending",
      deliveryCount: 0,
    });

    const center = new PersistentFakeNotificationCenter(centerDbPath);
    const restarted = new NotificationGateway({
      db: afterCrashDb,
      center,
      policy,
      activationSigner,
    });
    await expect(restarted.dispatchDue(1_001)).resolves.toEqual([
      { notificationIntentId: "notification-1", outcome: "Delivered", deliveryNumber: 1 },
    ]);
    await expect(restarted.dispatchDue(2_000)).resolves.toEqual([]);

    const centerSnapshot = readPersistentCenterSnapshot(centerDbPath);
    expect(centerSnapshot.deliveryCalls).toBe(2);
    expect(centerSnapshot.visibleNotifications).toEqual([
      expect.objectContaining({
        notificationId: "notification-1",
        displayCount: 1,
      }),
    ]);
    expect(readNotificationSnapshot(afterCrashDb).attempts[0]).toMatchObject({
      status: "Succeeded",
      authoritativeStateVersion: 5,
    });
    afterCrashDb.close();
  });
});
