// RT-WORKTREE-05/06/10 + RT-STO-01 — durable Worktree records.
//
// The Worktree state and role are coupled state machines. This store owns
// their persistence constraints and the Ready transaction: revalidate the
// complete provision result, record the actual filesystem identity, move the
// previous Active Worktree to Historical, and select Active versus Historical
// from current Task / Attempt facts in one SQLite transaction.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  checkLimit,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  ProcessDisposition,
  Worktree,
  type WorktreeId,
} from "@agents-fleet/contracts";
import type { FilesystemIdentity } from "../git/restricted-git.js";
import { type Migration, transact } from "./database.js";
import { appendDomainEvent } from "./domain-event-store.js";
import { type AttemptStatus, StoreError } from "./task-store.js";

export const WORKTREE_MIGRATIONS: readonly Migration[] = [
  {
    version: 7,
    name: "worktree-records",
    up: (db) => {
      db.exec(`
        CREATE TABLE fleet_worktrees (
          worktree_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          state TEXT NOT NULL CHECK (state IN ('Planned','Ready','Failed','Orphaned','Disposed')),
          role TEXT NOT NULL CHECK (role IN ('Pending','Active','Historical')),
          canonical_path TEXT NOT NULL UNIQUE,
          repository_identity TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          base_commit_sha TEXT NOT NULL,
          head_commit_sha TEXT,
          fs_dev INTEGER,
          fs_ino INTEGER,
          state_version INTEGER NOT NULL CHECK (state_version >= 1),
          failure_reason TEXT,
          failure_detail TEXT,
          observed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disposed_at TEXT,
          CHECK (
            (state IN ('Planned','Orphaned') AND role = 'Pending') OR
            (state = 'Ready' AND role IN ('Active','Historical')) OR
            (state = 'Failed' AND role IN ('Pending','Historical')) OR
            (state = 'Disposed' AND role = 'Historical')
          ),
          CHECK (
            (state IN ('Ready','Disposed') AND fs_dev IS NOT NULL AND fs_ino IS NOT NULL
              AND head_commit_sha IS NOT NULL) OR
            (state NOT IN ('Ready','Disposed') AND fs_dev IS NULL AND fs_ino IS NULL)
          )
        );
        CREATE UNIQUE INDEX idx_fleet_worktrees_workspace_branch
          ON fleet_worktrees(workspace_id, branch_name);
        CREATE UNIQUE INDEX idx_fleet_worktrees_one_active_per_task
          ON fleet_worktrees(task_id) WHERE role = 'Active';
        CREATE INDEX idx_fleet_worktrees_task
          ON fleet_worktrees(task_id, created_at);

        CREATE TABLE attempt_worktree_bindings (
          attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
          worktree_id TEXT NOT NULL REFERENCES fleet_worktrees(worktree_id),
          base_commit_sha TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_attempt_worktree_bindings_worktree
          ON attempt_worktree_bindings(worktree_id);

        -- R1-04 owns the dispose blockers' durable facts. R1-05 extends the
        -- Session rows with process-owner data; R1-09 drives dispositions.
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
          availability TEXT NOT NULL CHECK (availability IN ('Alive','Exited','Lost')),
          role TEXT NOT NULL CHECK (role IN ('PrimaryAgent','Shell','TestRunner')),
          completion_policy TEXT NOT NULL CHECK (
            completion_policy IN ('BlocksAttemptCompletion','DoesNotBlockAttemptCompletion')
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_sessions_attempt_availability
          ON sessions(attempt_id, availability);

        CREATE TABLE process_dispositions (
          attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
          disposition TEXT NOT NULL CHECK (
            disposition IN (
              'Probing','ConfirmedAbsent','OrphanFound','KeepRequested',
              'StopRequested','ConfirmedStopped'
            )
          ),
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export interface PlannedWorktreeInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly branchName: string;
  readonly baseCommitSha: string;
}

export interface ProvisionedWorktreeFacts {
  readonly canonicalPath: string;
  readonly repositoryIdentity: string;
  readonly branchName: string;
  readonly baseCommitSha: string;
  readonly headCommitSha: string;
  readonly filesystemIdentity: FilesystemIdentity;
  readonly observedAt: string;
}

export interface ProvisionFailureFacts {
  readonly reason: string;
  readonly detail: string;
  readonly leftover: "none" | "unknown";
}

export interface WorktreeRecord {
  readonly worktreeId: WorktreeId;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly state: Worktree.WorktreeState;
  readonly role: Worktree.WorktreeRole;
  readonly canonicalPath: string;
  readonly repositoryIdentity: string;
  readonly branchName: string;
  readonly baseCommitSha: string;
  readonly headCommitSha: string | null;
  readonly filesystemIdentity: FilesystemIdentity | null;
  readonly stateVersion: number;
  readonly failureReason: string | null;
  readonly failureDetail: string | null;
  readonly observedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disposedAt: string | null;
}

export interface ManagedWorktreeContext {
  readonly record: WorktreeRecord;
  readonly repository: {
    readonly workingTreeRoot: string;
    readonly filesystemIdentity: FilesystemIdentity;
    readonly commonGitDir: string;
    readonly commonGitDirIdentity: FilesystemIdentity;
  };
}

export interface WorktreeDisposeLifecycleFacts {
  readonly taskIds: readonly string[];
  readonly attemptIds: readonly string[];
  readonly nonterminalAttemptIds: readonly string[];
  readonly aliveSessions: readonly {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly observedAt: string;
  }[];
  readonly aliveSessionIds: readonly string[];
  readonly processDispositions: readonly {
    readonly attemptId: string;
    readonly disposition: ProcessDisposition.ProcessDisposition;
    readonly observedAt: string;
  }[];
  readonly pendingProcessAttemptIds: readonly string[];
}

interface WorktreeRow {
  readonly worktree_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly state: Worktree.WorktreeState;
  readonly role: Worktree.WorktreeRole;
  readonly canonical_path: string;
  readonly repository_identity: string;
  readonly branch_name: string;
  readonly base_commit_sha: string;
  readonly head_commit_sha: string | null;
  readonly fs_dev: number | null;
  readonly fs_ino: number | null;
  readonly state_version: number;
  readonly failure_reason: string | null;
  readonly failure_detail: string | null;
  readonly observed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disposed_at: string | null;
}

interface AttemptTaskRow {
  readonly status: AttemptStatus;
  readonly lifecycle: "Draft" | "Runnable" | "Cancelled";
  readonly task_id: string;
}

interface WorkspaceIdentityRow {
  readonly common_git_dev: number;
  readonly common_git_ino: number;
  readonly trust_state: "PendingValidation" | "Active" | "Revoked";
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const repositoryIdentityOf = (identity: FilesystemIdentity): string =>
  `${identity.dev}:${identity.ino}`;

const rowToRecord = (row: WorktreeRow): WorktreeRecord => {
  if (!Worktree.isValidStateRolePair(row.state, row.role)) {
    throw new StoreError(
      "DataIntegrityFailure",
      `stored Worktree has invalid state/role ${row.state}/${row.role}`,
    );
  }
  const hasIdentity = row.fs_dev !== null && row.fs_ino !== null;
  return {
    worktreeId: row.worktree_id as WorktreeId,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    state: row.state,
    role: row.role,
    canonicalPath: row.canonical_path,
    repositoryIdentity: row.repository_identity,
    branchName: row.branch_name,
    baseCommitSha: row.base_commit_sha,
    headCommitSha: row.head_commit_sha,
    filesystemIdentity: hasIdentity
      ? { dev: row.fs_dev as number, ino: row.fs_ino as number }
      : null,
    stateVersion: row.state_version,
    failureReason: row.failure_reason,
    failureDetail: row.failure_detail,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disposedAt: row.disposed_at,
  };
};

const isTerminalAttemptStatus = (status: AttemptStatus): boolean =>
  status === "Succeeded" ||
  status === "Failed" ||
  status === "Cancelled" ||
  status === "Interrupted" ||
  status === "Uncertain";

export class WorktreeStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  #row(worktreeId: string): WorktreeRow {
    const row = this.#db
      .prepare("SELECT * FROM fleet_worktrees WHERE worktree_id = ?")
      .get(worktreeId) as WorktreeRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Worktree: ${worktreeId}`);
    return row;
  }

  #attemptTask(attemptId: string): AttemptTaskRow {
    const row = this.#db
      .prepare(
        `SELECT attempts.status, attempts.task_id, tasks.lifecycle
         FROM attempts JOIN tasks ON tasks.task_id = attempts.task_id
         WHERE attempts.attempt_id = ?`,
      )
      .get(attemptId) as AttemptTaskRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Attempt: ${attemptId}`);
    return row;
  }

  #workspaceIdentity(workspaceId: string): WorkspaceIdentityRow {
    const row = this.#db
      .prepare(
        `SELECT workspaces.common_git_dev, workspaces.common_git_ino,
                repository_trusts.state AS trust_state
         FROM workspaces
         JOIN repository_trusts ON repository_trusts.trust_id = workspaces.trust_id
         WHERE workspaces.workspace_id = ?`,
      )
      .get(workspaceId) as WorkspaceIdentityRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Workspace: ${workspaceId}`);
    if (row.trust_state !== "Active") {
      throw new StoreError("Conflict", "Worktree requires Active Repository Trust");
    }
    return row;
  }

  #appendEvent(taskId: string, attemptId: string, type: string, payload: unknown): void {
    appendDomainEvent(this.#db, { taskId, attemptId, type, payload }, this.#now);
  }

  #failQueuedAttempt(attemptId: string): void {
    this.#db
      .prepare("UPDATE attempts SET status = 'Failed' WHERE attempt_id = ? AND status = 'Queued'")
      .run(attemptId);
  }

  get(worktreeId: string): WorktreeRecord {
    return rowToRecord(this.#row(worktreeId));
  }

  listForTask(taskId: string): readonly WorktreeRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM fleet_worktrees WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as unknown as WorktreeRow[];
    return rows.map(rowToRecord);
  }

  worktreeForAttempt(attemptId: string): WorktreeRecord | null {
    const row = this.#db
      .prepare(
        `SELECT fleet_worktrees.*
         FROM attempt_worktree_bindings
         JOIN fleet_worktrees
           ON fleet_worktrees.worktree_id = attempt_worktree_bindings.worktree_id
         WHERE attempt_worktree_bindings.attempt_id = ?`,
      )
      .get(attemptId) as WorktreeRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * SV1-FILE-01/06/10 — internal context for Worktree Git operations.
   * Common Git directory facts never cross the Worktree Manager Interface.
   */
  context(worktreeId: string): ManagedWorktreeContext {
    const row = this.#db
      .prepare(
        `SELECT fleet_worktrees.*,
                workspaces.canonical_root AS repository_root,
                workspaces.common_git_dir,
                workspaces.common_git_dev,
                workspaces.common_git_ino,
                repository_trusts.fs_dev AS repository_dev,
                repository_trusts.fs_ino AS repository_ino,
                repository_trusts.state AS trust_state
         FROM fleet_worktrees
         JOIN workspaces ON workspaces.workspace_id = fleet_worktrees.workspace_id
         JOIN repository_trusts ON repository_trusts.trust_id = workspaces.trust_id
         WHERE fleet_worktrees.worktree_id = ?`,
      )
      .get(worktreeId) as
      | (WorktreeRow & {
          repository_root: string;
          repository_dev: number;
          repository_ino: number;
          common_git_dir: string;
          common_git_dev: number;
          common_git_ino: number;
          trust_state: "PendingValidation" | "Active" | "Revoked";
        })
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Worktree: ${worktreeId}`);
    if (row.trust_state !== "Active") {
      throw new StoreError("Conflict", "Worktree operation requires Active Repository Trust");
    }
    return {
      record: rowToRecord(row),
      repository: {
        workingTreeRoot: row.repository_root,
        filesystemIdentity: { dev: row.repository_dev, ino: row.repository_ino },
        commonGitDir: row.common_git_dir,
        commonGitDirIdentity: { dev: row.common_git_dev, ino: row.common_git_ino },
      },
    };
  }

  disposeLifecycleFacts(worktreeId: string): WorktreeDisposeLifecycleFacts {
    this.#row(worktreeId);
    const attempts = this.#db
      .prepare(
        `SELECT attempts.attempt_id, attempts.task_id, attempts.status
         FROM attempt_worktree_bindings
         JOIN attempts ON attempts.attempt_id = attempt_worktree_bindings.attempt_id
         WHERE attempt_worktree_bindings.worktree_id = ?
         ORDER BY attempts.created_seq`,
      )
      .all(worktreeId) as {
      attempt_id: string;
      task_id: string;
      status: AttemptStatus;
    }[];
    const attemptIds = attempts.map((attempt) => attempt.attempt_id);
    const taskIds = [...new Set(attempts.map((attempt) => attempt.task_id))];
    const nonterminalAttemptIds = attempts
      .filter((attempt) => !isTerminalAttemptStatus(attempt.status))
      .map((attempt) => attempt.attempt_id);
    const aliveSessions = this.#db
      .prepare(
        `SELECT sessions.session_id, sessions.attempt_id, sessions.updated_at
         FROM sessions
         JOIN attempt_worktree_bindings
           ON attempt_worktree_bindings.attempt_id = sessions.attempt_id
         WHERE attempt_worktree_bindings.worktree_id = ?
           AND sessions.availability = 'Alive'
         ORDER BY sessions.created_at, sessions.session_id`,
      )
      .all(worktreeId)
      .map((row) => {
        const session = row as {
          session_id: string;
          attempt_id: string;
          updated_at: string;
        };
        return {
          sessionId: session.session_id,
          attemptId: session.attempt_id,
          observedAt: session.updated_at,
        };
      });
    const processDispositions = this.#db
      .prepare(
        `SELECT process_dispositions.attempt_id, process_dispositions.disposition,
                process_dispositions.updated_at
         FROM process_dispositions
         JOIN attempt_worktree_bindings
           ON attempt_worktree_bindings.attempt_id = process_dispositions.attempt_id
         WHERE attempt_worktree_bindings.worktree_id = ?
         ORDER BY process_dispositions.attempt_id`,
      )
      .all(worktreeId)
      .map((row) => {
        const fact = row as {
          attempt_id: string;
          disposition: ProcessDisposition.ProcessDisposition;
          updated_at: string;
        };
        return {
          attemptId: fact.attempt_id,
          disposition: fact.disposition,
          observedAt: fact.updated_at,
        };
      });
    const aliveSessionIds = aliveSessions.map((session) => session.sessionId);
    const pendingProcessAttemptIds = processDispositions
      .filter((fact) => ProcessDisposition.dispositionHoldsSlot(fact.disposition))
      .map((fact) => fact.attemptId);
    return {
      taskIds,
      attemptIds,
      nonterminalAttemptIds,
      aliveSessions,
      aliveSessionIds,
      processDispositions,
      pendingProcessAttemptIds,
    };
  }

  createPlanned(input: PlannedWorktreeInput): WorktreeRecord {
    if (!isAbsolute(input.canonicalPath) || input.canonicalPath.includes("\0")) {
      throw new StoreError(
        "InvalidRequest",
        "planned Worktree path must be canonical and absolute",
      );
    }
    const pathBytes = Buffer.byteLength(input.canonicalPath, "utf8");
    if (!checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "pathBytes", pathBytes).ok) {
      throw new StoreError("InvalidRequest", "planned Worktree path exceeds RuntimeLimitProfile");
    }
    if (input.branchName.length === 0 || input.branchName.includes("\0")) {
      throw new StoreError("InvalidRequest", "managed branch name must be non-empty");
    }
    if (!SHA_RE.test(input.baseCommitSha)) {
      throw new StoreError("InvalidRequest", "baseCommitSha must be a full commit SHA");
    }

    return transact(
      this.#db,
      () => {
        const attempt = this.#attemptTask(input.attemptId);
        if (
          attempt.task_id !== input.taskId ||
          attempt.status !== "Queued" ||
          attempt.lifecycle !== "Runnable"
        ) {
          throw new StoreError(
            "Conflict",
            "Planned Worktree requires the Task's Runnable Queued Attempt",
          );
        }
        const task = this.#db
          .prepare("SELECT workspace_id FROM tasks WHERE task_id = ?")
          .get(input.taskId) as { workspace_id: string };
        if (task.workspace_id !== input.workspaceId) {
          throw new StoreError("Conflict", "Task and planned Worktree Workspace differ");
        }
        if (this.worktreeForAttempt(input.attemptId) !== null) {
          throw new StoreError("Conflict", "Attempt already has a Worktree binding");
        }
        const workspace = this.#workspaceIdentity(input.workspaceId);
        const worktreeId = `wt_${randomUUID()}` as WorktreeId;
        const now = new Date(this.#now()).toISOString();
        try {
          this.#db
            .prepare(
              `INSERT INTO fleet_worktrees
               (worktree_id, workspace_id, task_id, state, role, canonical_path,
                repository_identity, branch_name, base_commit_sha, head_commit_sha,
                fs_dev, fs_ino, state_version, created_at, updated_at)
               VALUES (?, ?, ?, 'Planned', 'Pending', ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)`,
            )
            .run(
              worktreeId,
              input.workspaceId,
              input.taskId,
              input.canonicalPath,
              repositoryIdentityOf({
                dev: workspace.common_git_dev,
                ino: workspace.common_git_ino,
              }),
              input.branchName,
              input.baseCommitSha,
              now,
              now,
            );
          this.#db
            .prepare(
              `INSERT INTO attempt_worktree_bindings
               (attempt_id, worktree_id, base_commit_sha, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(input.attemptId, worktreeId, input.baseCommitSha, now);
        } catch (error) {
          if (
            error instanceof Error &&
            /UNIQUE constraint failed: fleet_worktrees\.(canonical_path|workspace_id)/.test(
              error.message,
            )
          ) {
            throw new StoreError("Conflict", "planned Worktree path or branch is already managed");
          }
          throw error;
        }
        this.#appendEvent(input.taskId, input.attemptId, "worktree-planned", {
          worktreeId,
          baseCommitSha: input.baseCommitSha,
        });
        return this.get(worktreeId);
      },
      this.#now,
    );
  }

  commitProvisioned(worktreeId: string, facts: ProvisionedWorktreeFacts): WorktreeRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#row(worktreeId);
        if (!Worktree.canTransitionState(row.state, "Ready")) {
          throw new StoreError(
            "Conflict",
            `cannot commit provision result from Worktree state ${row.state}`,
          );
        }
        const binding = this.#db
          .prepare("SELECT attempt_id FROM attempt_worktree_bindings WHERE worktree_id = ?")
          .get(worktreeId) as { attempt_id: string } | undefined;
        if (binding === undefined) {
          throw new StoreError("DataIntegrityFailure", "Planned Worktree has no Attempt binding");
        }

        const factsMatch =
          facts.canonicalPath === row.canonical_path &&
          facts.repositoryIdentity === row.repository_identity &&
          facts.branchName === row.branch_name &&
          facts.baseCommitSha === row.base_commit_sha &&
          facts.headCommitSha === row.base_commit_sha;
        if (!factsMatch) {
          return this.#commitOrphaned(
            row,
            binding.attempt_id,
            "provision-result-mismatch",
            "materialized Worktree does not match its managed plan",
          );
        }

        const attempt = this.#attemptTask(binding.attempt_id);
        let role: Worktree.WorktreeRole;
        if (attempt.status === "Queued" && attempt.lifecycle === "Runnable") {
          role = "Active";
        } else if (attempt.lifecycle === "Cancelled" || isTerminalAttemptStatus(attempt.status)) {
          role = "Historical";
        } else {
          return this.#commitOrphaned(
            row,
            binding.attempt_id,
            "ownership-conflict",
            `Attempt is ${attempt.status} while provision completes`,
          );
        }

        const now = new Date(this.#now()).toISOString();
        if (role === "Active") {
          const previous = this.#db
            .prepare(
              `SELECT fleet_worktrees.worktree_id, attempt_worktree_bindings.attempt_id
               FROM fleet_worktrees
               JOIN attempt_worktree_bindings
                 ON attempt_worktree_bindings.worktree_id = fleet_worktrees.worktree_id
               WHERE fleet_worktrees.task_id = ?
                 AND fleet_worktrees.role = 'Active'
                 AND fleet_worktrees.worktree_id != ?
               ORDER BY attempt_worktree_bindings.created_at DESC
               LIMIT 1`,
            )
            .get(row.task_id, worktreeId) as
            | { worktree_id: string; attempt_id: string }
            | undefined;
          this.#db
            .prepare(
              `UPDATE fleet_worktrees
               SET role = 'Historical', state_version = state_version + 1, updated_at = ?
               WHERE task_id = ? AND role = 'Active' AND worktree_id != ?`,
            )
            .run(now, row.task_id, worktreeId);
          if (previous !== undefined) {
            this.#appendEvent(row.task_id, previous.attempt_id, "worktree-historical", {
              worktreeId: previous.worktree_id,
              replacedBy: worktreeId,
            });
          }
        }
        this.#db
          .prepare(
            `UPDATE fleet_worktrees
             SET state = 'Ready', role = ?, head_commit_sha = ?, fs_dev = ?, fs_ino = ?,
                 state_version = state_version + 1, failure_reason = NULL, failure_detail = NULL,
                 observed_at = ?, updated_at = ?
             WHERE worktree_id = ?`,
          )
          .run(
            role,
            facts.headCommitSha,
            facts.filesystemIdentity.dev,
            facts.filesystemIdentity.ino,
            facts.observedAt,
            now,
            worktreeId,
          );
        this.#appendEvent(row.task_id, binding.attempt_id, "worktree-ready", {
          worktreeId,
          role,
          observedAt: facts.observedAt,
        });
        return this.get(worktreeId);
      },
      this.#now,
    );
  }

  #commitOrphaned(
    row: WorktreeRow,
    attemptId: string,
    reason: string,
    detail: string,
  ): WorktreeRecord {
    const now = new Date(this.#now()).toISOString();
    this.#db
      .prepare(
        `UPDATE fleet_worktrees
         SET state = 'Orphaned', role = 'Pending', state_version = state_version + 1,
             failure_reason = ?, failure_detail = ?, updated_at = ?
         WHERE worktree_id = ?`,
      )
      .run(reason, detail, now, row.worktree_id);
    this.#failQueuedAttempt(attemptId);
    this.#appendEvent(row.task_id, attemptId, "worktree-orphaned", {
      worktreeId: row.worktree_id,
      reason,
    });
    return this.get(row.worktree_id);
  }

  commitProvisionFailure(worktreeId: string, failure: ProvisionFailureFacts): WorktreeRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#row(worktreeId);
        const nextState: Worktree.WorktreeState =
          failure.leftover === "none" ? "Failed" : "Orphaned";
        if (!Worktree.canTransitionState(row.state, nextState)) {
          throw new StoreError(
            "Conflict",
            `cannot commit provision failure from Worktree state ${row.state}`,
          );
        }
        const binding = this.#db
          .prepare("SELECT attempt_id FROM attempt_worktree_bindings WHERE worktree_id = ?")
          .get(worktreeId) as { attempt_id: string } | undefined;
        if (binding === undefined) {
          throw new StoreError("DataIntegrityFailure", "Planned Worktree has no Attempt binding");
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE fleet_worktrees
             SET state = ?, role = 'Pending', state_version = state_version + 1,
                 failure_reason = ?, failure_detail = ?, updated_at = ?
             WHERE worktree_id = ?`,
          )
          .run(nextState, failure.reason, failure.detail, now, worktreeId);
        this.#failQueuedAttempt(binding.attempt_id);
        this.#appendEvent(
          row.task_id,
          binding.attempt_id,
          nextState === "Failed" ? "worktree-provision-failed" : "worktree-orphaned",
          { worktreeId, reason: failure.reason },
        );
        return this.get(worktreeId);
      },
      this.#now,
    );
  }

  markDisposed(
    worktreeId: string,
    input: {
      readonly expectedStateVersion: number;
      readonly observedAt: string;
    },
  ): WorktreeRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#row(worktreeId);
        if (
          row.state_version !== input.expectedStateVersion ||
          !Worktree.canTransitionState(row.state, "Disposed")
        ) {
          throw new StoreError("Conflict", "Worktree state changed before dispose commit");
        }
        const binding = this.#db
          .prepare(
            `SELECT attempt_id FROM attempt_worktree_bindings
             WHERE worktree_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(worktreeId) as { attempt_id: string } | undefined;
        if (binding === undefined) {
          throw new StoreError("DataIntegrityFailure", "Ready Worktree has no Attempt binding");
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE fleet_worktrees
             SET state = 'Disposed', role = 'Historical',
                 state_version = state_version + 1, observed_at = ?,
                 updated_at = ?, disposed_at = ?
             WHERE worktree_id = ?`,
          )
          .run(input.observedAt, now, now, worktreeId);
        this.#appendEvent(row.task_id, binding.attempt_id, "worktree-disposed", {
          worktreeId,
          preservedBranch: row.branch_name,
        });
        return this.get(worktreeId);
      },
      this.#now,
    );
  }
}
