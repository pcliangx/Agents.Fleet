import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationGateway,
  type SystemNotification,
  type SystemNotificationCenter,
} from "./notification-gateway.js";
import {
  AuthoritativeAttemptWriter,
  openNotificationDb,
  readNotificationSnapshot,
  type SqliteDatabase,
} from "./notification-outbox.js";
import {
  NotificationActivationAuthenticator,
  NotificationActivationSigner,
} from "./notification-security.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class RecordingCenter implements SystemNotificationCenter {
  readonly notifications: SystemNotification[] = [];

  async deliver(notification: SystemNotification) {
    this.notifications.push(notification);
    return { status: "Delivered" } as const;
  }
}

const secret = Buffer.alloc(32, 0x5a);
const policy = {
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 250,
  notificationPayloadBytes: 1_024,
};

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "r0-13-security-"));
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

describe("R0-13 notification trust boundary", () => {
  it("builds lock-screen content only from fixed classes, never from hostile runtime text", async () => {
    const { db, writer } = setup();
    const hostileTransition = {
      ...transition,
      title: "SECRET_api_key_should_not_escape",
      transcript: "private transcript SECRET_api_key_should_not_escape",
      input: "rm -rf /",
      osc: "\u001b]8;;file:///private/repository\u0007click\u001b]8;;\u0007",
      repositoryPath: "/Users/alice/private/customer-repository",
    };
    writer.commitTransitionWithNotification(hostileTransition);
    const center = new RecordingCenter();
    const signer = new NotificationActivationSigner(secret);
    const gateway = new NotificationGateway({ db, center, policy, activationSigner: signer });

    await gateway.dispatchDue(1_000);

    expect(center.notifications).toHaveLength(1);
    const serialized = JSON.stringify(center.notifications[0]);
    for (const forbidden of [
      "SECRET_api_key_should_not_escape",
      "private transcript",
      "rm -rf",
      "file://",
      "/Users/alice",
      "customer-repository",
      "\u001b]",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      policy.notificationPayloadBytes,
    );
  });

  it("rejects non-canonical content classes and routes carrying URL, path, argv, or command data", () => {
    const { writer } = setup();
    expect(() =>
      writer.commitTransitionWithNotification({
        ...transition,
        contentClass: "AttemptCompleted<script>",
      }),
    ).toThrow(/content class/i);

    const second = setup();
    const overPrivilegedRoute = {
      kind: "attempt" as const,
      taskId: "task-1",
      attemptId: "attempt-1",
      url: "file:///private/repository",
      path: "/private/repository",
      argv: ["rm", "-rf"],
      command: "open -a Terminal",
    };
    expect(() =>
      second.writer.commitTransitionWithNotification({
        ...transition,
        route: overPrivilegedRoute,
      }),
    ).toThrow(/route/i);
  });

  it("authenticates a stable route before acknowledging and rejects tampering or binding drift", async () => {
    const { db, writer } = setup();
    writer.commitTransitionWithNotification(transition);
    const center = new RecordingCenter();
    const signer = new NotificationActivationSigner(secret);
    const authenticator = new NotificationActivationAuthenticator(secret);
    const gateway = new NotificationGateway({ db, center, policy, activationSigner: signer });
    await gateway.dispatchDue(1_000);
    const token = center.notifications[0]?.activationData;
    expect(token).toBeDefined();

    expect(
      gateway.acknowledgeAuthenticatedActivation(authenticator.authenticate(token ?? "")),
    ).toEqual({
      kind: "attempt",
      taskId: "task-1",
      attemptId: "attempt-1",
    });
    expect(readNotificationSnapshot(db).notificationIntents[0]?.deliveryState).toBe("Acknowledged");
    expect(readNotificationSnapshot(db).attempts[0]).toMatchObject({
      status: "Succeeded",
      authoritativeStateVersion: 5,
    });

    const [payload, signature] = (token ?? "").split(".");
    expect(() => authenticator.authenticate(`${payload}x.${signature}`)).toThrow(/activation/i);
    expect(() =>
      gateway.acknowledgeAuthenticatedActivation(
        authenticator.authenticate(
          signer.sign({
            notificationIntentId: "notification-1",
            route: { kind: "attempt", taskId: "task-1", attemptId: "other-attempt" },
          }),
        ),
      ),
    ).toThrow(/binding/i);
    expect(() =>
      authenticator.authenticate(
        JSON.stringify({ url: "file:///private/repository", argv: ["open", "Terminal"] }),
      ),
    ).toThrow(/activation/i);
  });
});
