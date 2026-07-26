import { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export type DeliveryState = "Pending" | "Delivered" | "Failed" | "Acknowledged";

export interface AttemptRoute {
  readonly kind: "attempt";
  readonly taskId: string;
  readonly attemptId: string;
}

export interface TaskRoute {
  readonly kind: "task";
  readonly taskId: string;
}

export type NotificationRoute = TaskRoute | AttemptRoute;

export interface NotificationIntent {
  readonly notificationIntentId: string;
  readonly dedupeKey: string;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly authoritativeStateVersion: number;
  readonly eventType: string;
  readonly route: NotificationRoute;
  readonly contentClass: string;
  readonly createdAtMs: number;
  readonly deliveryState: DeliveryState;
  readonly deliveryCount: number;
  readonly nextDeliveryAtMs: number;
  readonly lastErrorCode: string | null;
}

export interface CommitTransitionWithNotification {
  readonly notificationIntentId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly expectedStateVersion: number;
  readonly nextStateVersion: number;
  readonly nextStatus: string;
  readonly eventType: string;
  readonly contentClass: string;
  readonly route: NotificationRoute;
  readonly createdAtMs: number;
}

interface NotificationIntentRow {
  readonly notification_intent_id: string;
  readonly dedupe_key: string;
  readonly task_id: string;
  readonly attempt_id: string | null;
  readonly authoritative_state_version: number;
  readonly event_type: string;
  readonly route_json: string;
  readonly content_class: string;
  readonly created_at_ms: number;
  readonly delivery_state: DeliveryState;
  readonly delivery_count: number;
  readonly next_delivery_at_ms: number;
  readonly last_error_code: string | null;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly authoritative_state_version: number;
}

export interface NotificationSnapshot {
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly taskId: string;
    readonly status: string;
    readonly authoritativeStateVersion: number;
  }[];
  readonly notificationIntents: readonly NotificationIntent[];
  readonly deliveryObservations: readonly DeliveryObservation[];
}

export interface DeliveryObservation {
  readonly observationId: number;
  readonly notificationIntentId: string;
  readonly deliveryNumber: number;
  readonly outcome: "Delivered" | "RetryScheduled" | "Failed";
  readonly errorCode: string | null;
  readonly observedAtMs: number;
}

interface DeliveryObservationRow {
  readonly observation_id: number;
  readonly notification_intent_id: string;
  readonly delivery_number: number;
  readonly outcome: "Delivered" | "RetryScheduled" | "Failed";
  readonly error_code: string | null;
  readonly observed_at_ms: number;
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  status TEXT NOT NULL,
  authoritative_state_version INTEGER NOT NULL CHECK (authoritative_state_version >= 0)
);

CREATE TABLE IF NOT EXISTS notification_intents (
  notification_intent_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  authoritative_state_version INTEGER NOT NULL CHECK (authoritative_state_version >= 0),
  event_type TEXT NOT NULL,
  route_json TEXT NOT NULL,
  content_class TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('Pending', 'Delivered', 'Failed', 'Acknowledged')),
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  next_delivery_at_ms INTEGER NOT NULL,
  last_error_code TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_intents_attempt_version
  ON notification_intents(attempt_id, authoritative_state_version)
  WHERE attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_delivery_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_intent_id TEXT NOT NULL REFERENCES notification_intents(notification_intent_id),
  delivery_number INTEGER NOT NULL CHECK (delivery_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('Delivered', 'RetryScheduled', 'Failed')),
  error_code TEXT,
  observed_at_ms INTEGER NOT NULL,
  UNIQUE(notification_intent_id, delivery_number)
);
`;

export const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_PRESENTATION = new Map([
  ["AttemptSucceeded", { contentClass: "AttemptCompleted", status: "Succeeded" }],
  ["AttemptFailed", { contentClass: "AttemptNeedsAttention", status: "Failed" }],
  ["AttemptWaiting", { contentClass: "AttemptNeedsAttention", status: "Waiting" }],
]);

const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

export const parseNotificationRoute = (value: unknown): NotificationRoute => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("notification route must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "task" && hasExactKeys(candidate, ["kind", "taskId"])) {
    if (typeof candidate.taskId === "string" && STABLE_ID.test(candidate.taskId)) {
      return { kind: "task", taskId: candidate.taskId };
    }
  }
  if (
    candidate.kind === "attempt" &&
    hasExactKeys(candidate, ["kind", "taskId", "attemptId"]) &&
    typeof candidate.taskId === "string" &&
    STABLE_ID.test(candidate.taskId) &&
    typeof candidate.attemptId === "string" &&
    STABLE_ID.test(candidate.attemptId)
  ) {
    return {
      kind: "attempt",
      taskId: candidate.taskId,
      attemptId: candidate.attemptId,
    };
  }
  throw new Error("notification route is not a canonical Task/Attempt identity");
};

export const openNotificationDb = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(SCHEMA_DDL);
  return db;
};

export const withTransaction = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const notificationDedupeKey = (input: {
  readonly eventType: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly authoritativeStateVersion: number;
}): string =>
  JSON.stringify([
    input.eventType,
    input.taskId,
    input.attemptId ?? null,
    input.authoritativeStateVersion,
  ]);

const toIntent = (row: NotificationIntentRow): NotificationIntent => ({
  notificationIntentId: row.notification_intent_id,
  dedupeKey: row.dedupe_key,
  taskId: row.task_id,
  attemptId: row.attempt_id,
  authoritativeStateVersion: row.authoritative_state_version,
  eventType: row.event_type,
  route: parseNotificationRoute(JSON.parse(row.route_json) as unknown),
  contentClass: row.content_class,
  createdAtMs: row.created_at_ms,
  deliveryState: row.delivery_state,
  deliveryCount: row.delivery_count,
  nextDeliveryAtMs: row.next_delivery_at_ms,
  lastErrorCode: row.last_error_code,
});

const getIntentByDedupeKey = (
  db: DatabaseSync,
  dedupeKey: string,
): NotificationIntent | undefined => {
  const row = db
    .prepare("SELECT * FROM notification_intents WHERE dedupe_key = ?")
    .get(dedupeKey) as NotificationIntentRow | undefined;
  return row === undefined ? undefined : toIntent(row);
};

export class AuthoritativeAttemptWriter {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  commitTransitionWithNotification(input: CommitTransitionWithNotification): NotificationIntent {
    if (
      !STABLE_ID.test(input.notificationIntentId) ||
      !STABLE_ID.test(input.taskId) ||
      !STABLE_ID.test(input.attemptId)
    ) {
      throw new Error("notification identity is not stable");
    }
    const expectedPresentation = EVENT_PRESENTATION.get(input.eventType);
    if (
      expectedPresentation === undefined ||
      input.contentClass !== expectedPresentation.contentClass
    ) {
      throw new Error("event type and notification content class are not allowed");
    }
    if (input.nextStatus !== expectedPresentation.status) {
      throw new Error("notification event type does not match authoritative status");
    }
    const route = parseNotificationRoute(input.route);
    if (
      route.taskId !== input.taskId ||
      (route.kind === "attempt" && route.attemptId !== input.attemptId)
    ) {
      throw new Error("notification route does not match authoritative identity");
    }
    const dedupeKey = notificationDedupeKey({
      eventType: input.eventType,
      taskId: input.taskId,
      attemptId: input.attemptId,
      authoritativeStateVersion: input.nextStateVersion,
    });
    const replay = getIntentByDedupeKey(this.#db, dedupeKey);
    if (replay !== undefined) return replay;

    return withTransaction(this.#db, () => {
      const attempt = this.#db
        .prepare("SELECT * FROM attempts WHERE attempt_id = ?")
        .get(input.attemptId) as AttemptRow | undefined;
      if (attempt === undefined) throw new Error(`unknown Attempt: ${input.attemptId}`);
      if (attempt.task_id !== input.taskId) throw new Error("Attempt does not belong to Task");
      if (attempt.authoritative_state_version !== input.expectedStateVersion) {
        throw new Error(
          `state version conflict: expected ${input.expectedStateVersion}, got ${attempt.authoritative_state_version}`,
        );
      }
      if (input.nextStateVersion !== input.expectedStateVersion + 1) {
        throw new Error("next state version must increment exactly once");
      }

      this.#db
        .prepare(
          `UPDATE attempts
           SET status = ?, authoritative_state_version = ?
           WHERE attempt_id = ? AND authoritative_state_version = ?`,
        )
        .run(input.nextStatus, input.nextStateVersion, input.attemptId, input.expectedStateVersion);
      this.#db
        .prepare(
          `INSERT INTO notification_intents (
             notification_intent_id, dedupe_key, task_id, attempt_id,
             authoritative_state_version, event_type, route_json, content_class,
             created_at_ms, delivery_state, delivery_count, next_delivery_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?)`,
        )
        .run(
          input.notificationIntentId,
          dedupeKey,
          input.taskId,
          input.attemptId,
          input.nextStateVersion,
          input.eventType,
          JSON.stringify(route),
          input.contentClass,
          input.createdAtMs,
          input.createdAtMs,
        );

      const inserted = getIntentByDedupeKey(this.#db, dedupeKey);
      if (inserted === undefined) throw new Error("notification intent insert was not durable");
      return inserted;
    });
  }
}

export const readNotificationSnapshot = (db: DatabaseSync): NotificationSnapshot => ({
  attempts: (
    db
      .prepare(
        "SELECT attempt_id, task_id, status, authoritative_state_version FROM attempts ORDER BY attempt_id",
      )
      .all() as unknown as AttemptRow[]
  ).map((row) => ({
    attemptId: row.attempt_id,
    taskId: row.task_id,
    status: row.status,
    authoritativeStateVersion: row.authoritative_state_version,
  })),
  notificationIntents: (
    db
      .prepare("SELECT * FROM notification_intents ORDER BY created_at_ms, notification_intent_id")
      .all() as unknown as NotificationIntentRow[]
  ).map(toIntent),
  deliveryObservations: (
    db
      .prepare("SELECT * FROM notification_delivery_observations ORDER BY observation_id")
      .all() as unknown as DeliveryObservationRow[]
  ).map((row) => ({
    observationId: row.observation_id,
    notificationIntentId: row.notification_intent_id,
    deliveryNumber: row.delivery_number,
    outcome: row.outcome,
    errorCode: row.error_code,
    observedAtMs: row.observed_at_ms,
  })),
});
