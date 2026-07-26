import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthoritativeAttemptWriter,
  notificationDedupeKey,
  openNotificationDb,
  readNotificationSnapshot,
  type SqliteDatabase,
} from "./notification-outbox.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "r0-13-outbox-"));
  dirs.push(dir);
  const db = openNotificationDb(join(dir, "lifecycle.db"));
  dbs.push(db);
  db.prepare("INSERT INTO tasks (task_id) VALUES (?)").run("task-1");
  db.prepare(
    "INSERT INTO attempts (attempt_id, task_id, status, authoritative_state_version) VALUES (?, ?, ?, ?)",
  ).run("attempt-1", "task-1", "Running", 4);
  return { db, writer: new AuthoritativeAttemptWriter(db) };
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

describe("R0-13 durable notification outbox", () => {
  it("commits the authoritative transition and intent atomically, then dedupes a replay", () => {
    const { db, writer } = setup();

    const intent = writer.commitTransitionWithNotification(transition);
    const replay = writer.commitTransitionWithNotification(transition);
    const snapshot = readNotificationSnapshot(db);

    expect(intent).toEqual(replay);
    expect(intent).toMatchObject({
      notificationIntentId: "notification-1",
      dedupeKey: notificationDedupeKey({
        eventType: "AttemptSucceeded",
        taskId: "task-1",
        attemptId: "attempt-1",
        authoritativeStateVersion: 5,
      }),
      deliveryState: "Pending",
      attemptCount: 0,
      nextAttemptAtMs: 1_000,
    });
    expect(snapshot.attempts).toEqual([
      {
        attemptId: "attempt-1",
        taskId: "task-1",
        status: "Succeeded",
        authoritativeStateVersion: 5,
      },
    ]);
    expect(snapshot.notificationIntents).toHaveLength(1);
  });

  it("rolls the Attempt transition back when the paired intent cannot be inserted", () => {
    const { db, writer } = setup();
    db.prepare(
      `INSERT INTO notification_intents (
        notification_intent_id, dedupe_key, task_id, attempt_id,
        authoritative_state_version, event_type, route_json, content_class,
        created_at_ms, delivery_state, attempt_count, next_attempt_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?)`,
    ).run(
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

    expect(() => writer.commitTransitionWithNotification(transition)).toThrow();

    expect(readNotificationSnapshot(db).attempts[0]).toEqual({
      attemptId: "attempt-1",
      taskId: "task-1",
      status: "Running",
      authoritativeStateVersion: 4,
    });
  });

  it("rejects an event whose fixed content would misrepresent the authoritative status", () => {
    const { writer } = setup();

    expect(() =>
      writer.commitTransitionWithNotification({
        ...transition,
        nextStatus: "Running",
      }),
    ).toThrow(/event type.*status/i);
  });
});
