// RT-TASK-01/02/03 + RT-STATE-15 + RT-STO-01 + RT-EVENT-01/02/03 — Task store.
//
// Task spec is bounded (512 KiB/field, 1 MiB total — enforced against the
// frozen RuntimeLimitProfile, RT-LIMIT-02), versioned, and edited only while
// Draft. The lifecycle is Draft | Runnable | Cancelled with Cancelled
// terminal. start() flips Draft → Runnable and creates the Queued Attempt
// with its immutable spec snapshot in the SAME transaction (RT-STATE-15),
// and every mutation appends its domain events — full DomainEventEnvelope
// shape (RT-EVENT-03) — in that transaction too (RT-STO-01).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { checkLimit, FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { type Migration, transact } from "./database.js";
import { appendDomainEvent } from "./domain-event-store.js";

export { EVENT_SCHEMA_VERSION } from "./domain-event-store.js";

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
          status TEXT NOT NULL CHECK (status IN (
            'Queued','Starting','Running','Waiting','Stopping',
            'Succeeded','Failed','Cancelled','Interrupted','Uncertain'
          )),
          spec_snapshot_json TEXT NOT NULL,
          task_spec_version INTEGER NOT NULL,
          created_seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE domain_events (
          event_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          attempt_id TEXT,
          session_id TEXT,
          timeline_seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK (confidence IN ('authoritative','inferred')),
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 10,
    name: "command-surface-state-versions",
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1
          CHECK (state_version >= 1);
        ALTER TABLE attempts ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1
          CHECK (state_version >= 1);
        ALTER TABLE attempts ADD COLUMN command_kind TEXT NOT NULL DEFAULT 'Start'
          CHECK (command_kind IN ('Start','Retry','Resume'));
        ALTER TABLE attempts ADD COLUMN source_attempt_id TEXT REFERENCES attempts(attempt_id);
        ALTER TABLE attempts ADD COLUMN launch_confirmation_challenge_id TEXT;
      `);
    },
  },
  {
    version: 11,
    name: "launch-confirmation-plans",
    up: (db) => {
      db.exec(`
        ALTER TABLE attempts ADD COLUMN launch_command_id TEXT;
        ALTER TABLE attempts ADD COLUMN failure_reason TEXT;
        CREATE UNIQUE INDEX idx_attempts_launch_command
          ON attempts(launch_command_id) WHERE launch_command_id IS NOT NULL;

        CREATE TABLE launch_confirmation_plans (
          challenge_id TEXT PRIMARY KEY
            REFERENCES confirmation_challenges(challenge_id) ON DELETE CASCADE,
          target_command_id TEXT NOT NULL,
          command_type TEXT NOT NULL CHECK (command_type IN ('Start','Retry','Resume')),
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          source_attempt_id TEXT REFERENCES attempts(attempt_id),
          normalized_command_json TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          preview_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_launch_confirmation_target
          ON launch_confirmation_plans(target_command_id, created_at);
      `);
    },
  },
];

export type TaskLifecycle = "Draft" | "Runnable" | "Cancelled";

export type AttemptStatus =
  | "Queued"
  | "Starting"
  | "Running"
  | "Waiting"
  | "Stopping"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "Interrupted"
  | "Uncertain";

export interface TaskRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly lifecycle: TaskLifecycle;
  readonly taskSpecVersion: number;
  readonly stateVersion: number;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly status: AttemptStatus;
  readonly specSnapshot: unknown;
  readonly taskSpecVersion: number;
  readonly stateVersion: number;
  readonly commandKind: "Start" | "Retry" | "Resume";
  readonly sourceAttemptId: string | null;
  readonly launchConfirmationChallengeId: string | null;
}

export interface DomainEventRecord {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly timelineSeq: number;
  readonly type: string;
  readonly source: string;
  readonly confidence: "authoritative" | "inferred";
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly observedAt: string;
}

/** RT-TASK-01 — exactly these four fields; anything else is InvalidRequest. */
export interface TaskSpec {
  readonly goal: string;
  readonly context?: string;
  readonly constraints?: string;
  readonly acceptanceCriteria?: string;
}

export type StoreErrorCode =
  | "InvalidRequest"
  | "Forbidden"
  | "Conflict"
  | "NotFound"
  | "CapabilityUnavailable"
  | "DataIntegrityFailure"
  | "IdempotencyConflict"
  | "StaleGeneration"
  | "StaleControlLease"
  | "StoragePressure"
  // RT-CMD-06/16 — a confirmation receipt was forged, replayed, expired,
  // cross-kind or drifted; the command fails closed and changes nothing.
  | "ConfirmationRequired";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

const SPEC_FIELDS = ["goal", "context", "constraints", "acceptanceCriteria"] as const;

// RT-STATE-15 — lifecycle transitions expressed as exhaustive switches. Adding
// a future state (e.g. "Paused") forces every guard to handle it explicitly;
// the `never` default fails closed on any unhandled state instead of silently
// inheriting an existing transition (Divergent Change / Repeated Switches smell).
const assertDraft = (lifecycle: TaskLifecycle, action: string): void => {
  switch (lifecycle) {
    case "Draft":
      return;
    case "Runnable":
    case "Cancelled":
      throw new StoreError("Conflict", `cannot ${action} a ${lifecycle} task`);
    default: {
      const exhaustive: never = lifecycle;
      throw new StoreError(
        "Conflict",
        `cannot ${action} from unknown lifecycle ${exhaustive as string}`,
      );
    }
  }
};

const assertCancelable = (lifecycle: TaskLifecycle): void => {
  switch (lifecycle) {
    case "Draft":
    case "Runnable":
      return;
    case "Cancelled":
      throw new StoreError("Conflict", "task is already cancelled");
    default: {
      const exhaustive: never = lifecycle;
      throw new StoreError(
        "Conflict",
        `cannot cancel from unknown lifecycle ${exhaustive as string}`,
      );
    }
  }
};

interface TaskRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly lifecycle: TaskLifecycle;
  readonly spec_json: string;
  readonly task_spec_version: number;
  readonly state_version: number;
}

export class TaskStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  // RT-TASK-01 — bounded, four-field, non-empty-goal spec, measured in UTF-8
  // bytes against the frozen profile (limit / limit + 1 fail closed).
  #validateSpec(spec: TaskSpec): void {
    for (const key of Object.keys(spec)) {
      if (!(SPEC_FIELDS as readonly string[]).includes(key)) {
        throw new StoreError("InvalidRequest", `unknown task spec field: ${key}`);
      }
    }
    if (typeof spec.goal !== "string" || spec.goal.length === 0) {
      throw new StoreError("InvalidRequest", "task spec goal must be non-empty");
    }
    let total = 0;
    for (const field of SPEC_FIELDS) {
      const value = spec[field];
      if (value === undefined) continue;
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

  #taskRow(taskId: string): TaskRow {
    const row = this.#db
      .prepare(
        "SELECT task_id, workspace_id, lifecycle, spec_json, task_spec_version, state_version FROM tasks WHERE task_id = ?",
      )
      .get(taskId) as TaskRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such task: ${taskId}`);
    return row;
  }

  #record(row: TaskRow): TaskRecord {
    return {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      lifecycle: row.lifecycle,
      taskSpecVersion: row.task_spec_version,
      stateVersion: row.state_version,
    };
  }

  // Per-table seq helper — no SQL identifier interpolation (prepared-only
  // invariant). attempts.created_seq is global.
  #nextAttemptCreatedSeq(): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(created_seq), 0) + 1 AS seq FROM attempts")
      .get() as { seq: number };
    return row.seq;
  }

  // Full DomainEventEnvelope (RT-EVENT-03): timelineSeq is the per-task
  // monotonic display order (RT-EVENT-01); locally produced events are
  // authoritative and observed as written.
  #appendEvent(taskId: string, type: string, payload: unknown, attemptId?: string): void {
    appendDomainEvent(
      this.#db,
      {
        taskId,
        ...(attemptId === undefined ? {} : { attemptId }),
        type,
        payload,
      },
      this.#now,
    );
  }

  createTask(input: { readonly workspaceId: string; readonly spec: TaskSpec }): TaskRecord {
    this.#validateSpec(input.spec);
    const taskId = `tk_${randomUUID()}`;
    return transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            "INSERT INTO tasks (task_id, workspace_id, lifecycle, spec_json, task_spec_version, created_at, updated_at) VALUES (?, ?, 'Draft', ?, 1, ?, ?)",
          )
          .run(taskId, input.workspaceId, JSON.stringify(input.spec), now, now);
        this.#appendEvent(taskId, "task-created", { workspaceId: input.workspaceId });
        return this.#record(this.#taskRow(taskId));
      },
      this.#now,
    );
  }

  // RT-TASK-01 — specs are edited while Draft; once running, the spec is
  // frozen for that Attempt and a retry carries its own snapshot (R1-07).
  updateTaskSpec(taskId: string, spec: TaskSpec): TaskRecord {
    this.#validateSpec(spec);
    return transact(
      this.#db,
      () => {
        const row = this.#taskRow(taskId);
        assertDraft(row.lifecycle, "edit the spec of");
        this.#db
          .prepare(
            "UPDATE tasks SET spec_json = ?, task_spec_version = ?, state_version = state_version + 1, updated_at = ? WHERE task_id = ?",
          )
          .run(
            JSON.stringify(spec),
            row.task_spec_version + 1,
            new Date(this.#now()).toISOString(),
            taskId,
          );
        this.#appendEvent(taskId, "task-spec-updated", {
          taskSpecVersion: row.task_spec_version + 1,
        });
        return this.#record(this.#taskRow(taskId));
      },
      this.#now,
    );
  }

  // RT-STATE-15 — Draft → Runnable, atomically creating the Queued Attempt
  // with its immutable spec snapshot (RT-TASK-02).
  startTask(taskId: string): TaskRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#taskRow(taskId);
        assertDraft(row.lifecycle, "start");
        this.#db
          .prepare(
            "UPDATE tasks SET lifecycle = 'Runnable', state_version = state_version + 1, updated_at = ? WHERE task_id = ?",
          )
          .run(new Date(this.#now()).toISOString(), taskId);
        this.#appendEvent(taskId, "task-started", {});
        const attemptId = `at_${randomUUID()}`;
        this.#db
          .prepare(
            "INSERT INTO attempts (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at) VALUES (?, ?, 'Queued', ?, ?, ?, ?)",
          )
          .run(
            attemptId,
            taskId,
            row.spec_json,
            row.task_spec_version,
            this.#nextAttemptCreatedSeq(),
            new Date(this.#now()).toISOString(),
          );
        this.#appendEvent(
          taskId,
          "attempt-queued",
          { taskSpecVersion: row.task_spec_version },
          attemptId,
        );
        return this.#record(this.#taskRow(taskId));
      },
      this.#now,
    );
  }

  // RT-TASK-03 — cancel ≠ delete: spec, attempts, events all remain.
  cancelTask(taskId: string): TaskRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#taskRow(taskId);
        assertCancelable(row.lifecycle);
        this.#db
          .prepare(
            "UPDATE tasks SET lifecycle = 'Cancelled', state_version = state_version + 1, updated_at = ? WHERE task_id = ?",
          )
          .run(new Date(this.#now()).toISOString(), taskId);
        const cancelled = this.#db
          .prepare(
            "UPDATE attempts SET status = 'Cancelled', state_version = state_version + 1 WHERE task_id = ? AND status = 'Queued'",
          )
          .run(taskId);
        this.#appendEvent(taskId, "task-cancelled", {
          cancelledQueuedAttempts: Number(cancelled.changes),
        });
        return this.#record(this.#taskRow(taskId));
      },
      this.#now,
    );
  }

  listTasks(workspaceId: string): readonly TaskRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT task_id, workspace_id, lifecycle, task_spec_version, state_version FROM tasks WHERE workspace_id = ? ORDER BY created_at",
      )
      .all(workspaceId) as Omit<TaskRow, "spec_json">[];
    return rows.map((r) => ({
      taskId: r.task_id,
      workspaceId: r.workspace_id,
      lifecycle: r.lifecycle,
      taskSpecVersion: r.task_spec_version,
      stateVersion: r.state_version,
    }));
  }

  listAttempts(taskId: string): readonly AttemptRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT attempt_id, task_id, status, spec_snapshot_json, task_spec_version,
                state_version, command_kind, source_attempt_id,
                launch_confirmation_challenge_id
         FROM attempts WHERE task_id = ? ORDER BY created_seq`,
      )
      .all(taskId) as {
      attempt_id: string;
      task_id: string;
      status: AttemptStatus;
      spec_snapshot_json: string;
      task_spec_version: number;
      state_version: number;
      command_kind: "Start" | "Retry" | "Resume";
      source_attempt_id: string | null;
      launch_confirmation_challenge_id: string | null;
    }[];
    return rows.map((r) => ({
      attemptId: r.attempt_id,
      taskId: r.task_id,
      status: r.status,
      specSnapshot: JSON.parse(r.spec_snapshot_json),
      taskSpecVersion: r.task_spec_version,
      stateVersion: r.state_version,
      commandKind: r.command_kind,
      sourceAttemptId: r.source_attempt_id,
      launchConfirmationChallengeId: r.launch_confirmation_challenge_id,
    }));
  }

  listEvents(taskId: string): readonly DomainEventRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT event_id, schema_version, task_id, attempt_id, timeline_seq, type, source, confidence, payload_json, occurred_at, observed_at
         FROM domain_events WHERE task_id = ? ORDER BY timeline_seq`,
      )
      .all(taskId) as {
      event_id: string;
      schema_version: number;
      task_id: string;
      attempt_id: string | null;
      timeline_seq: number;
      type: string;
      source: string;
      confidence: "authoritative" | "inferred";
      payload_json: string;
      occurred_at: string;
      observed_at: string;
    }[];
    return rows.map((r) => ({
      eventId: r.event_id,
      schemaVersion: r.schema_version,
      taskId: r.task_id,
      attemptId: r.attempt_id,
      timelineSeq: r.timeline_seq,
      type: r.type,
      source: r.source,
      confidence: r.confidence,
      payload: JSON.parse(r.payload_json),
      occurredAt: r.occurred_at,
      observedAt: r.observed_at,
    }));
  }
}
