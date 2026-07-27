// RT-MOD-02 / RT-SCHED-01..03 — Task Orchestrator scheduler seam.
//
// Selection is stable by queuedAt then AttemptId. Preparing an Agent launch is
// intentionally outside the SQLite transaction; after preparation, the claim
// transaction rechecks both the selected Attempt and slot availability before
// atomically writing the lease, Starting state and Prepared LaunchIntent.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  LaunchSpec,
  ScheduleNextResult,
  SessionRuntime,
  StopCommandImpact,
  StopCommandResult,
  TaskOrchestrator as TaskOrchestratorContract,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { transact } from "../storage/database.js";
import { appendDomainEvent } from "../storage/domain-event-store.js";
import { StoreError } from "../storage/task-store.js";

export interface SchedulableAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
}

export interface PreparedLaunchPlan {
  readonly commandId: string;
  readonly agentId: string;
  readonly launchSpec: LaunchSpec;
}

interface CandidateRow {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly worktree_id: string;
  readonly canonical_path: string;
}

interface TaskOrchestratorOptions {
  readonly db: DatabaseSync;
  readonly prepareLaunch: (attempt: SchedulableAttempt) => Promise<PreparedLaunchPlan>;
  readonly sessions?: Pick<SessionRuntime, "terminate">;
  readonly now?: () => number;
}

type NonterminalAttemptStatus = "Queued" | "Starting" | "Running" | "Waiting" | "Stopping";

interface StopAttemptRow {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly status: NonterminalAttemptStatus;
  readonly state_version: number;
}

interface StopTaskRow {
  readonly task_id: string;
  readonly lifecycle: "Draft" | "Runnable" | "Cancelled";
  readonly state_version: number;
}

interface StopSessionRow {
  readonly session_id: string;
  readonly generation: number;
}

const nextCandidate = (db: DatabaseSync): CandidateRow | undefined =>
  db
    .prepare(
      `SELECT attempts.attempt_id, attempts.task_id,
              fleet_worktrees.worktree_id, fleet_worktrees.canonical_path
       FROM attempts
       JOIN tasks ON tasks.task_id = attempts.task_id
       JOIN attempt_worktree_bindings
         ON attempt_worktree_bindings.attempt_id = attempts.attempt_id
       JOIN fleet_worktrees
         ON fleet_worktrees.worktree_id = attempt_worktree_bindings.worktree_id
       WHERE attempts.status = 'Queued'
         AND tasks.lifecycle = 'Runnable'
         AND fleet_worktrees.state = 'Ready'
         AND fleet_worktrees.role = 'Active'
       ORDER BY attempts.created_at, attempts.attempt_id
       LIMIT 1`,
    )
    .get() as CandidateRow | undefined;

const hasActiveSlot = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 AS occupied FROM slot_leases WHERE released_at IS NULL LIMIT 1").get() !==
  undefined;

const asAttempt = (row: CandidateRow): SchedulableAttempt => ({
  attemptId: row.attempt_id,
  taskId: row.task_id,
  worktreeId: row.worktree_id,
  worktreePath: row.canonical_path,
});

export class TaskOrchestrator implements TaskOrchestratorContract {
  readonly #db: DatabaseSync;
  readonly #prepareLaunch: TaskOrchestratorOptions["prepareLaunch"];
  readonly #sessions: Pick<SessionRuntime, "terminate"> | undefined;
  readonly #now: () => number;

  constructor(options: TaskOrchestratorOptions) {
    this.#db = options.db;
    this.#prepareLaunch = options.prepareLaunch;
    this.#sessions = options.sessions;
    this.#now = options.now ?? Date.now;
  }

  async scheduleNext(): Promise<ScheduleNextResult> {
    const selected = nextCandidate(this.#db);
    if (selected === undefined) return { kind: "idle" };
    if (hasActiveSlot(this.#db)) {
      return { kind: "blocked", reason: "agent-slot-unavailable" };
    }

    const attempt = asAttempt(selected);
    const plan = await this.#prepareLaunch(attempt);
    if (plan.agentId.length === 0 || plan.commandId.length === 0) {
      throw new StoreError("InvalidRequest", "prepared launch identity must be non-empty");
    }
    if (plan.launchSpec.cwd !== attempt.worktreePath) {
      throw new StoreError("ConfirmationRequired", "prepared launch cwd does not match Worktree");
    }

    const slotLeaseId = `sl_${randomUUID()}`;
    const launchNonce = `ln_${randomUUID()}`;
    const plannedSessionId = `se_${randomUUID()}`;
    const now = new Date(this.#now()).toISOString();
    const argvHash = canonicalSha256(plan.launchSpec.argv);
    const launchSpecHash = canonicalSha256(plan.launchSpec);

    return transact(
      this.#db,
      () => {
        if (hasActiveSlot(this.#db)) {
          return { kind: "blocked", reason: "agent-slot-unavailable" } as const;
        }
        const current = nextCandidate(this.#db);
        if (current?.attempt_id !== selected.attempt_id) {
          throw new StoreError("Conflict", "scheduler queue changed while preparing launch");
        }

        this.#db
          .prepare(
            `INSERT INTO slot_leases
             (slot_lease_id, attempt_id, host_id, agent_id, acquired_at)
             VALUES (?, ?, 'local', ?, ?)`,
          )
          .run(slotLeaseId, attempt.attemptId, plan.agentId, now);
        const changed = this.#db
          .prepare(
            `UPDATE attempts
             SET status = 'Starting', state_version = state_version + 1
             WHERE attempt_id = ? AND status = 'Queued'`,
          )
          .run(attempt.attemptId);
        if (changed.changes !== 1) {
          throw new StoreError("Conflict", "Attempt is no longer Queued");
        }
        this.#db
          .prepare(
            `INSERT INTO launch_intents
             (launch_nonce, attempt_id, command_id, slot_lease_id, planned_session_id,
              agent_id, argv_hash, launch_spec_json, launch_spec_hash, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Prepared', ?, ?)`,
          )
          .run(
            launchNonce,
            attempt.attemptId,
            plan.commandId,
            slotLeaseId,
            plannedSessionId,
            plan.agentId,
            argvHash,
            JSON.stringify(plan.launchSpec),
            launchSpecHash,
            now,
            now,
          );
        this.#appendEvent(attempt, "launch-intent-prepared", {
          launchNonce,
          plannedSessionId,
          slotLeaseId,
          agentId: plan.agentId,
        });

        return {
          kind: "prepared",
          attemptId: attempt.attemptId,
          taskId: attempt.taskId,
          commandId: plan.commandId,
          agentId: plan.agentId,
          slotLeaseId,
          launchNonce,
          plannedSessionId,
          launchSpec: structuredClone(plan.launchSpec),
        };
      },
      this.#now,
    );
  }

  previewRequestAttemptStop(attemptId: string): StopCommandImpact {
    const attempt = this.#nonterminalAttempt(attemptId);
    const task = this.#task(attempt.task_id);
    return this.#stopImpact("RequestAttemptStop", task, attempt);
  }

  previewCancelTask(taskId: string): StopCommandImpact {
    const task = this.#task(taskId);
    if (task.lifecycle === "Cancelled") {
      throw new StoreError("Conflict", "Task is already Cancelled");
    }
    const attempt = this.#currentAttempt(taskId);
    return this.#stopImpact("CancelTask", task, attempt);
  }

  requestAttemptStop(attemptId: string): StopCommandResult {
    return transact(
      this.#db,
      () => {
        const attempt = this.#nonterminalAttempt(attemptId);
        const task = this.#task(attempt.task_id);
        if (task.lifecycle === "Draft") {
          throw new StoreError(
            "DataIntegrityFailure",
            "Draft Task cannot own a nonterminal Attempt",
          );
        }
        const sessions = this.#aliveSessions(attempt.attempt_id);
        const nextStatus = this.#requestStopTransition(attempt, sessions);
        let nextAttemptVersion = attempt.state_version;
        if (nextStatus !== attempt.status) {
          const changed = this.#db
            .prepare(
              `UPDATE attempts
               SET status = ?, state_version = state_version + 1
               WHERE attempt_id = ? AND state_version = ?`,
            )
            .run(nextStatus, attempt.attempt_id, attempt.state_version);
          if (changed.changes !== 1) {
            throw new StoreError("Conflict", "Attempt changed while requesting stop");
          }
          nextAttemptVersion += 1;
          appendDomainEvent(
            this.#db,
            {
              taskId: attempt.task_id,
              attemptId: attempt.attempt_id,
              type: nextStatus === "Stopping" ? "attempt-stop-requested" : "attempt-cancelled",
              payload: {
                previousStatus: attempt.status,
                aliveSessionIds: sessions.map((session) => session.session_id),
                gitCleanup: false,
              },
            },
            this.#now,
          );
        }
        return {
          taskId: task.task_id,
          taskLifecycle: task.lifecycle,
          taskStateVersion: task.state_version,
          attemptId: attempt.attempt_id,
          attemptStatus: nextStatus,
          attemptStateVersion: nextAttemptVersion,
          stopRequestedSessionIds: sessions.map((session) => session.session_id),
          gitCleanup: false,
        };
      },
      this.#now,
    );
  }

  cancelTask(taskId: string): StopCommandResult {
    return transact(
      this.#db,
      () => {
        const task = this.#task(taskId);
        if (task.lifecycle === "Cancelled") {
          throw new StoreError("Conflict", "Task is already Cancelled");
        }
        const attempt = this.#currentAttempt(taskId);
        const sessions = attempt === null ? [] : this.#aliveSessions(attempt.attempt_id);
        const nextStatus = attempt === null ? null : this.#requestStopTransition(attempt, sessions);
        const changed = this.#db
          .prepare(
            `UPDATE tasks
             SET lifecycle = 'Cancelled', state_version = state_version + 1, updated_at = ?
             WHERE task_id = ? AND state_version = ? AND lifecycle != 'Cancelled'`,
          )
          .run(new Date(this.#now()).toISOString(), taskId, task.state_version);
        if (changed.changes !== 1) {
          throw new StoreError("Conflict", "Task changed while cancelling");
        }
        let nextAttemptVersion = attempt?.state_version ?? null;
        if (attempt !== null && nextStatus !== attempt.status) {
          const attemptChanged = this.#db
            .prepare(
              `UPDATE attempts
               SET status = ?, state_version = state_version + 1
               WHERE attempt_id = ? AND state_version = ?`,
            )
            .run(nextStatus, attempt.attempt_id, attempt.state_version);
          if (attemptChanged.changes !== 1) {
            throw new StoreError("Conflict", "Attempt changed while cancelling Task");
          }
          nextAttemptVersion = attempt.state_version + 1;
        }
        appendDomainEvent(
          this.#db,
          {
            taskId,
            ...(attempt === null ? {} : { attemptId: attempt.attempt_id }),
            type: "task-cancelled",
            payload: {
              cascadedAttemptId: attempt?.attempt_id ?? null,
              aliveSessionIds: sessions.map((session) => session.session_id),
              gitCleanup: false,
            },
          },
          this.#now,
        );
        return {
          taskId,
          taskLifecycle: "Cancelled",
          taskStateVersion: task.state_version + 1,
          attemptId: attempt?.attempt_id ?? null,
          attemptStatus: nextStatus,
          attemptStateVersion: nextAttemptVersion,
          stopRequestedSessionIds: sessions.map((session) => session.session_id),
          gitCleanup: false,
        };
      },
      this.#now,
    );
  }

  async stopSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const sessions = this.#sessions;
    if (sessions === undefined) {
      throw new StoreError("CapabilityUnavailable", "Session Runtime is unavailable");
    }
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => await sessions.terminate(sessionId)),
    );
  }

  #task(taskId: string): StopTaskRow {
    const row = this.#db
      .prepare("SELECT task_id, lifecycle, state_version FROM tasks WHERE task_id = ?")
      .get(taskId) as StopTaskRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Task: ${taskId}`);
    return row;
  }

  #nonterminalAttempt(attemptId: string): StopAttemptRow {
    const row = this.#db
      .prepare(
        `SELECT attempt_id, task_id, status, state_version
         FROM attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as
      | (Omit<StopAttemptRow, "status"> & {
          readonly status:
            | NonterminalAttemptStatus
            | "Succeeded"
            | "Failed"
            | "Cancelled"
            | "Interrupted"
            | "Uncertain";
        })
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Attempt: ${attemptId}`);
    if (
      row.status === "Succeeded" ||
      row.status === "Failed" ||
      row.status === "Cancelled" ||
      row.status === "Interrupted" ||
      row.status === "Uncertain"
    ) {
      throw new StoreError("Conflict", `Attempt is already terminal (${row.status})`);
    }
    return row as StopAttemptRow;
  }

  #currentAttempt(taskId: string): StopAttemptRow | null {
    const rows = this.#db
      .prepare(
        `SELECT attempt_id, task_id, status, state_version
         FROM attempts
         WHERE task_id = ?
           AND status IN ('Queued','Starting','Running','Waiting','Stopping')
         ORDER BY created_seq DESC`,
      )
      .all(taskId) as unknown as StopAttemptRow[];
    if (rows.length > 1) {
      throw new StoreError("DataIntegrityFailure", "Task has multiple nonterminal Attempts");
    }
    return rows[0] ?? null;
  }

  #aliveSessions(attemptId: string): readonly StopSessionRow[] {
    return this.#db
      .prepare(
        `SELECT session_id, generation FROM sessions
         WHERE attempt_id = ? AND availability = 'Alive'
         ORDER BY created_at, session_id`,
      )
      .all(attemptId) as unknown as StopSessionRow[];
  }

  #stopImpact(
    commandType: StopCommandImpact["commandType"],
    task: StopTaskRow,
    attempt: StopAttemptRow | null,
  ): StopCommandImpact {
    const aliveSessions = attempt === null ? [] : this.#aliveSessions(attempt.attempt_id);
    return {
      commandType,
      sideEffectClass:
        commandType === "RequestAttemptStop" || attempt !== null ? "destructive" : "reversible",
      taskId: task.task_id,
      taskStateVersion: task.state_version,
      attemptId: attempt?.attempt_id ?? null,
      attemptStatus: attempt?.status ?? null,
      attemptStateVersion: attempt?.state_version ?? null,
      aliveSessions: aliveSessions.map((session) => ({
        sessionId: session.session_id,
        generation: session.generation,
      })),
      gitCleanup: false,
      worktreeChangesMayRemain: true,
    };
  }

  #requestStopTransition(
    attempt: StopAttemptRow,
    sessions: readonly StopSessionRow[],
  ): StopAttemptRow["status"] | "Cancelled" {
    switch (attempt.status) {
      case "Queued":
        return "Cancelled";
      case "Starting":
        if (sessions.length > 0) {
          throw new StoreError(
            "DataIntegrityFailure",
            "Starting Attempt has an Alive Session before Running",
          );
        }
        return "Cancelled";
      case "Running":
      case "Waiting":
        return "Stopping";
      case "Stopping":
        return "Stopping";
    }
  }

  #appendEvent(attempt: SchedulableAttempt, type: string, payload: unknown): void {
    appendDomainEvent(
      this.#db,
      {
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        type,
        payload,
      },
      this.#now,
    );
  }
}
