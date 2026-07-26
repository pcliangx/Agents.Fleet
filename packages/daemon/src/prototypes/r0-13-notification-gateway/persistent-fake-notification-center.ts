import { DatabaseSync } from "node:sqlite";
import type {
  SystemNotification,
  SystemNotificationCenter,
  SystemNotificationResult,
} from "./notification-gateway.js";

const CENTER_DDL = `
CREATE TABLE IF NOT EXISTS visible_notifications (
  notification_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  display_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL
);
`;

const openCenterDb = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(CENTER_DDL);
  return db;
};

export class PersistentFakeNotificationCenter implements SystemNotificationCenter {
  readonly #path: string;
  readonly #crashAfterWrite: boolean;

  constructor(path: string, options: { readonly crashAfterWrite?: boolean } = {}) {
    this.#path = path;
    this.#crashAfterWrite = options.crashAfterWrite ?? false;
  }

  async deliver(notification: SystemNotification): Promise<SystemNotificationResult> {
    const db = openCenterDb(this.#path);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO visible_notifications (notification_id, payload_json, display_count)
         VALUES (?, ?, 1)
         ON CONFLICT(notification_id) DO UPDATE SET payload_json = excluded.payload_json`,
      ).run(notification.notificationId, JSON.stringify(notification));
      db.prepare("INSERT INTO delivery_calls (notification_id) VALUES (?)").run(
        notification.notificationId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }

    if (this.#crashAfterWrite) process.kill(process.pid, "SIGKILL");
    return { status: "Delivered" };
  }
}

interface VisibleNotificationRow {
  readonly notification_id: string;
  readonly payload_json: string;
  readonly display_count: number;
}

export interface PersistentCenterSnapshot {
  readonly deliveryCalls: number;
  readonly visibleNotifications: readonly (SystemNotification & {
    readonly displayCount: number;
  })[];
}

export const readPersistentCenterSnapshot = (path: string): PersistentCenterSnapshot => {
  const db = openCenterDb(path);
  try {
    const calls = db.prepare("SELECT COUNT(*) AS count FROM delivery_calls").get() as {
      readonly count: number;
    };
    const rows = db
      .prepare("SELECT * FROM visible_notifications ORDER BY notification_id")
      .all() as unknown as VisibleNotificationRow[];
    return {
      deliveryCalls: calls.count,
      visibleNotifications: rows.map((row) => ({
        ...(JSON.parse(row.payload_json) as SystemNotification),
        displayCount: row.display_count,
      })),
    };
  } finally {
    db.close();
  }
};
