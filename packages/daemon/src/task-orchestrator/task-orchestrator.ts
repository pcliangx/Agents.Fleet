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
  TaskOrchestrator as TaskOrchestratorContract,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { transact } from "../storage/database.js";
import { EVENT_SCHEMA_VERSION, StoreError } from "../storage/task-store.js";

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
  readonly now?: () => number;
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
  readonly #now: () => number;

  constructor(options: TaskOrchestratorOptions) {
    this.#db = options.db;
    this.#prepareLaunch = options.prepareLaunch;
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
            "UPDATE attempts SET status = 'Starting' WHERE attempt_id = ? AND status = 'Queued'",
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

  #appendEvent(attempt: SchedulableAttempt, type: string, payload: unknown): void {
    const now = new Date(this.#now()).toISOString();
    const sequence = this.#db
      .prepare(
        "SELECT COALESCE(MAX(timeline_seq), 0) + 1 AS seq FROM domain_events WHERE task_id = ?",
      )
      .get(attempt.taskId) as { seq: number };
    this.#db
      .prepare(
        `INSERT INTO domain_events
         (event_id, schema_version, task_id, attempt_id, session_id, timeline_seq,
          type, source, confidence, payload_json, occurred_at, observed_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'daemon', 'authoritative', ?, ?, ?)`,
      )
      .run(
        `ev_${randomUUID()}`,
        EVENT_SCHEMA_VERSION,
        attempt.taskId,
        attempt.attemptId,
        sequence.seq,
        type,
        JSON.stringify(payload),
        now,
        now,
      );
  }
}
