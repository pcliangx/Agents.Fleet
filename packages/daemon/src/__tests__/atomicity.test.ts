// S4 — transaction atomicity (RT-STO-01, RT-INV-07): a lifecycle
// transition, its idempotency record and its domain events commit together
// or not at all.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, transact } from "../storage/database.js";
import { IdempotencyStore } from "../storage/idempotency.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { TaskStore } from "../storage/task-store.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const makeDb = () => {
  dir = mkdtempSync(join(tmpdir(), "af-r101-atomic-"));
  const result = openDatabase({ path: join(dir, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (result.kind !== "ready") throw new Error("db not ready");
  return result.db;
};

describe("transaction atomicity (RT-STO-01)", () => {
  it("a mid-transition failure rolls back lifecycle, attempt and events alike", () => {
    const db = makeDb();
    const store = new TaskStore(db);
    const task = store.createTask({ workspaceId: "ws1", spec: { goal: "g" } });

    // Sabotage the attempts table so startTask fails AFTER the lifecycle
    // UPDATE has run inside its transaction.
    db.exec("ALTER TABLE attempts RENAME TO attempts_sabotaged");
    expect(() => store.startTask(task.taskId)).toThrow();

    // Everything rolled back: still Draft, no events beyond creation.
    expect(store.listTasks("ws1")[0]?.lifecycle).toBe("Draft");
    expect(store.listEvents(task.taskId).map((e) => e.type)).toEqual(["task-created"]);
    db.close();
  });

  it("a composed command (state + idempotency record + event) is all-or-nothing", () => {
    const db = makeDb();
    const tasks = new TaskStore(db);
    const idem = new IdempotencyStore(db);
    const task = tasks.createTask({ workspaceId: "ws1", spec: { goal: "g" } });

    expect(() =>
      transact(db, () => {
        idem.record("cmd_1", "hash-a", { status: "done" }, { type: "task", id: task.taskId });
        db.prepare("UPDATE tasks SET lifecycle = 'Cancelled' WHERE task_id = ?").run(task.taskId);
        throw new Error("injected failure after both writes");
      }),
    ).toThrow("injected failure");

    // Neither the idempotency record nor the state write survived.
    expect(idem.lookup("cmd_1", "hash-a")).toBeNull();
    expect(tasks.listTasks("ws1")[0]?.lifecycle).toBe("Draft");
    db.close();
  });

  it("a successful composed command persists all three in commit order", () => {
    const db = makeDb();
    const tasks = new TaskStore(db);
    const idem = new IdempotencyStore(db);
    const task = tasks.createTask({ workspaceId: "ws1", spec: { goal: "g" } });

    transact(db, () => {
      idem.record("cmd_2", "hash-b", { status: "done" }, { type: "task", id: task.taskId });
      db.prepare("UPDATE tasks SET lifecycle = 'Cancelled' WHERE task_id = ?").run(task.taskId);
      db.prepare(
        `INSERT INTO domain_events
         (event_id, schema_version, task_id, attempt_id, session_id, timeline_seq, type, source, confidence, payload_json, occurred_at, observed_at)
         VALUES ('ev_manual', 1, ?, NULL, NULL, 2, 'task-cancelled', 'daemon', 'authoritative', '{}', 'now', 'now')`,
      ).run(task.taskId);
    });

    expect(idem.lookup("cmd_2", "hash-b")).toEqual({ status: "done" });
    expect(tasks.listTasks("ws1")[0]?.lifecycle).toBe("Cancelled");
    expect(tasks.listEvents(task.taskId).map((e) => e.type)).toEqual([
      "task-created",
      "task-cancelled",
    ]);
    db.close();
  });
});
