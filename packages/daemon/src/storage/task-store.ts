// RT-TASK-01/02/03 + RT-STATE-15 + RT-STO-01 — Task store.
//
// Task spec is bounded (512 KiB/field, 1 MiB total — enforced against the
// frozen RuntimeLimitProfile, RT-LIMIT-02) and versioned; the lifecycle is
// Draft | Runnable | Cancelled with Cancelled terminal. start() flips
// Draft → Runnable and creates the Queued Attempt with its immutable spec
// snapshot in the SAME transaction (RT-STATE-15), and every mutation appends
// its domain events in that transaction too (RT-STO-01, RT-EVENT-01/02).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { checkLimit, FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { type Migration, transact } from "./database.js";

export const TASK_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "task-lifecycle",
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('Draft','Runnable','Cancelled')),
          spec_json TEXT NOT NULL,
          task_spec_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE attempts (
          attempt_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          status TEXT NOT NULL,
          spec_snapshot_json TEXT NOT NULL,
          task_spec_version INTEGER NOT NULL,
          created_seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE domain_events (
          event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          timeline_seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK (confidence IN ('authoritative','inferred')),
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
      `);
    },
  },
];

export type TaskLifecycle = "Draft" | "Runnable" | "Cancelled";

export interface TaskRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly lifecycle: TaskLifecycle;
  readonly taskSpecVersion: number;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly status: string;
  readonly specSnapshot: unknown;
  readonly taskSpecVersion: number;
}

export interface DomainEventRecord {
  readonly eventId: string;
  readonly taskId: string;
  readonly timelineSeq: number;
  readonly type: string;
  readonly confidence: "authoritative" | "inferred";
  readonly payload: unknown;
}

export type TaskSpec = Record<string, string>;

export type StoreErrorCode = "InvalidRequest" | "Conflict" | "NotFound" | "IdempotencyConflict";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class TaskStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // RT-TASK-01 — bounded, non-empty-goal spec, measured in UTF-8 bytes
  // against the frozen profile (limit / limit + 1 fail closed).
  #validateSpec(spec: TaskSpec): void {
    if (typeof spec.goal !== "string" || spec.goal.length === 0) {
      throw new StoreError("InvalidRequest", "task spec goal must be non-empty");
    }
    let total = 0;
    for (const [field, value] of Object.entries(spec)) {
      const bytes = Buffer.byteLength(value, "utf8");
      total += bytes;
      const within = checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "taskFieldBytes", bytes);
      if (!within.ok) {
        throw new StoreError(
          "InvalidRequest",
          `task spec field ${field} is ${bytes} bytes, limit ${within.allowed}`,
        );
      }
    }
    const withinTotal = checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "taskSpecBytes", total);
    if (!withinTotal.ok) {
      throw new StoreError(
        "InvalidRequest",
        `task spec total is ${total} bytes, limit ${withinTotal.allowed}`,
      );
    }
  }

  #lifecycleOf(taskId: string): TaskLifecycle {
    const row = this.#db.prepare("SELECT lifecycle FROM tasks WHERE task_id = ?").get(taskId) as
      | { lifecycle: TaskLifecycle }
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such task: ${taskId}`);
    return row.lifecycle;
  }

  #appendEvent(taskId: string, type: string, payload: unknown): void {
    const seq = (
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(timeline_seq), 0) + 1 AS seq FROM domain_events WHERE task_id = ?",
        )
        .get(taskId) as { seq: number }
    ).seq;
    this.#db
      .prepare(
        "INSERT INTO domain_events (event_id, task_id, timeline_seq, type, confidence, payload_json, occurred_at) VALUES (?, ?, ?, ?, 'authoritative', ?, ?)",
      )
      .run(
        `ev_${randomUUID()}`,
        taskId,
        seq,
        type,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  createTask(input: { readonly workspaceId: string; readonly spec: TaskSpec }): TaskRecord {
    this.#validateSpec(input.spec);
    const taskId = `tk_${randomUUID()}`;
    return transact(this.#db, () => {
      const now = new Date().toISOString();
      this.#db
        .prepare(
          "INSERT INTO tasks (task_id, workspace_id, lifecycle, spec_json, task_spec_version, created_at, updated_at) VALUES (?, ?, 'Draft', ?, 1, ?, ?)",
        )
        .run(taskId, input.workspaceId, JSON.stringify(input.spec), now, now);
      this.#appendEvent(taskId, "task-created", { workspaceId: input.workspaceId });
      return { taskId, workspaceId: input.workspaceId, lifecycle: "Draft", taskSpecVersion: 1 };
    });
  }

  updateTaskSpec(taskId: string, spec: TaskSpec): TaskRecord {
    this.#validateSpec(spec);
    return transact(this.#db, () => {
      const lifecycle = this.#lifecycleOf(taskId);
      if (lifecycle === "Cancelled") {
        throw new StoreError("Conflict", "cancelled task is terminal");
      }
      const version = (
        this.#db
          .prepare("SELECT task_spec_version AS v FROM tasks WHERE task_id = ?")
          .get(taskId) as {
          v: number;
        }
      ).v;
      this.#db
        .prepare(
          "UPDATE tasks SET spec_json = ?, task_spec_version = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(JSON.stringify(spec), version + 1, new Date().toISOString(), taskId);
      this.#appendEvent(taskId, "task-spec-updated", { taskSpecVersion: version + 1 });
      return { taskId, workspaceId: "", lifecycle, taskSpecVersion: version + 1 };
    });
  }

  // RT-STATE-15 — Draft → Runnable, atomically creating the Queued Attempt
  // with its immutable spec snapshot (RT-TASK-02).
  startTask(taskId: string): TaskRecord {
    return transact(this.#db, () => {
      const lifecycle = this.#lifecycleOf(taskId);
      if (lifecycle !== "Draft") {
        throw new StoreError("Conflict", `cannot start a ${lifecycle} task`);
      }
      const row = this.#db
        .prepare("SELECT spec_json, task_spec_version FROM tasks WHERE task_id = ?")
        .get(taskId) as { spec_json: string; task_spec_version: number };
      this.#db
        .prepare("UPDATE tasks SET lifecycle = 'Runnable', updated_at = ? WHERE task_id = ?")
        .run(new Date().toISOString(), taskId);
      this.#appendEvent(taskId, "task-started", {});
      const seq = (
        this.#db.prepare("SELECT COALESCE(MAX(created_seq), 0) + 1 AS seq FROM attempts").get() as {
          seq: number;
        }
      ).seq;
      this.#db
        .prepare(
          "INSERT INTO attempts (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at) VALUES (?, ?, 'Queued', ?, ?, ?, ?)",
        )
        .run(
          `at_${randomUUID()}`,
          taskId,
          row.spec_json,
          row.task_spec_version,
          seq,
          new Date().toISOString(),
        );
      this.#appendEvent(taskId, "attempt-queued", { taskSpecVersion: row.task_spec_version });
      return {
        taskId,
        workspaceId: "",
        lifecycle: "Runnable",
        taskSpecVersion: row.task_spec_version,
      };
    });
  }

  // RT-TASK-03 — cancel ≠ delete: spec, attempts, events all remain.
  cancelTask(taskId: string): TaskRecord {
    return transact(this.#db, () => {
      const lifecycle = this.#lifecycleOf(taskId);
      if (lifecycle === "Cancelled") {
        throw new StoreError("Conflict", "task is already cancelled");
      }
      this.#db
        .prepare("UPDATE tasks SET lifecycle = 'Cancelled', updated_at = ? WHERE task_id = ?")
        .run(new Date().toISOString(), taskId);
      this.#appendEvent(taskId, "task-cancelled", {});
      return { taskId, workspaceId: "", lifecycle: "Cancelled", taskSpecVersion: 0 };
    });
  }

  listTasks(workspaceId: string): readonly TaskRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT task_id, workspace_id, lifecycle, task_spec_version FROM tasks WHERE workspace_id = ? ORDER BY created_at",
      )
      .all(workspaceId) as {
      task_id: string;
      workspace_id: string;
      lifecycle: TaskLifecycle;
      task_spec_version: number;
    }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      workspaceId: r.workspace_id,
      lifecycle: r.lifecycle,
      taskSpecVersion: r.task_spec_version,
    }));
  }

  listAttempts(taskId: string): readonly AttemptRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT attempt_id, task_id, status, spec_snapshot_json, task_spec_version FROM attempts WHERE task_id = ? ORDER BY created_seq",
      )
      .all(taskId) as {
      attempt_id: string;
      task_id: string;
      status: string;
      spec_snapshot_json: string;
      task_spec_version: number;
    }[];
    return rows.map((r) => ({
      attemptId: r.attempt_id,
      taskId: r.task_id,
      status: r.status,
      specSnapshot: JSON.parse(r.spec_snapshot_json),
      taskSpecVersion: r.task_spec_version,
    }));
  }

  listEvents(taskId: string): readonly DomainEventRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT event_id, task_id, timeline_seq, type, confidence, payload_json FROM domain_events WHERE task_id = ? ORDER BY timeline_seq",
      )
      .all(taskId) as {
      event_id: string;
      task_id: string;
      timeline_seq: number;
      type: string;
      confidence: "authoritative" | "inferred";
      payload_json: string;
    }[];
    return rows.map((r) => ({
      eventId: r.event_id,
      taskId: r.task_id,
      timelineSeq: r.timeline_seq,
      type: r.type,
      confidence: r.confidence,
      payload: JSON.parse(r.payload_json),
    }));
  }
}
