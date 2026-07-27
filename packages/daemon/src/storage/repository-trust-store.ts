// RT-REPO-03/05 + RT-OWN-01 + RT-STO-01 — Repository Trust + Workspace store.
//
// Persisted state machine (contracts RepositoryTrust, RT-REPO-05): Untrusted
// never reaches the database — the first confirmed receipt creates a
// PendingValidation row directly; only PendingValidation -> Active -> Revoked
// (and PendingValidation -> Revoked) are stored transitions, asserted through
// the contracts transition table so an illegal transition is a Conflict.
// Re-granting the same candidate creates a NEW trust_version; the Revoked row
// is kept, never resurrected. A partial unique index guarantees at most one
// non-Revoked row per candidate canonical root.
//
// RT-REPO-03: Active + Workspace + Repository binding commit in ONE
// transaction (activateWithWorkspace), so a validation failure or a Daemon
// crash can never leave an Active Trust or a Workspace behind. Revocation
// keeps the Workspace row — revoking never silently deletes data; readers
// join the Trust state (getWorkspaceWithTrust) so a Workspace bound to a
// Revoked Trust is visibly not runnable.
//
// Ordinary validation failures are recorded on the PendingValidation row
// (SV1-TRUST-08) so the same candidate can be retried idempotently.
//
// Repository Trust transitions do NOT append to domain_events: that table is
// the Task timeline (task_id NOT NULL) and RT-REPO requires no such events.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type PermissionMode, RepositoryTrust } from "@agents-fleet/contracts";
import type {
  FilesystemIdentity,
  RepositoryCandidate,
  RepositoryValidationFailure,
  ValidatedRepository,
} from "../git/restricted-git.js";
import { type Migration, transact } from "./database.js";
import { type AttemptStatus, StoreError } from "./task-store.js";

export const REPOSITORY_TRUST_MIGRATIONS: readonly Migration[] = [
  {
    version: 3,
    name: "repository-trust",
    up: (db) => {
      db.exec(`
        CREATE TABLE repository_trusts (
          trust_id TEXT PRIMARY KEY,
          trust_version INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('PendingValidation','Active','Revoked')),
          candidate_canonical_root TEXT NOT NULL,
          fs_dev INTEGER NOT NULL,
          fs_ino INTEGER NOT NULL,
          user_identity TEXT NOT NULL,
          challenge_id TEXT NOT NULL,
          validation_failure_json TEXT,
          validated_repository_json TEXT,
          revocation_process_choice TEXT CHECK (revocation_process_choice IS NULL OR revocation_process_choice IN ('stop','keep')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_repository_trusts_live_root
          ON repository_trusts(candidate_canonical_root) WHERE state != 'Revoked';
        CREATE TABLE workspaces (
          workspace_id TEXT PRIMARY KEY,
          trust_id TEXT NOT NULL REFERENCES repository_trusts(trust_id),
          canonical_root TEXT NOT NULL,
          common_git_dir TEXT NOT NULL,
          common_git_dev INTEGER NOT NULL,
          common_git_ino INTEGER NOT NULL,
          head_commit_sha TEXT NOT NULL,
          current_branch TEXT,
          default_base_ref TEXT,
          default_base_ref_sha TEXT,
          git_version TEXT NOT NULL,
          defaults_json TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_workspaces_trust ON workspaces(trust_id);
      `);
    },
  },
];

/** States that reach the database; Untrusted is the absence of a row (SV1-TRUST-01). */
export type PersistedTrustState = Exclude<RepositoryTrust.RepositoryTrustState, "Untrusted">;

export interface RepositoryTrustRecord {
  readonly trustId: string;
  /** 1 for the first grant of a candidate root; re-grant bumps it (RT-REPO-05). */
  readonly trustVersion: number;
  readonly state: PersistedTrustState;
  readonly candidateCanonicalRoot: string;
  readonly filesystemIdentity: FilesystemIdentity;
  readonly userIdentity: string;
  readonly challengeId: string;
  /** Last ordinary validation failure while PendingValidation (SV1-TRUST-08). */
  readonly validationFailure: RepositoryValidationFailure | null;
  /** Frozen at Active; the Workspace binding mirrors it (RT-REPO-03). */
  readonly validatedRepository: ValidatedRepository | null;
  /**
   * The user's stop-or-keep choice for still-running processes at revocation
   * (SV1-TRUST-05); null when not revoked or no choice was required.
   */
  readonly revocationProcessChoice: "stop" | "keep" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * RT-OWN-01 — the default selections bound to a Workspace: default Agent,
 * base branch and permission mode (CONTEXT.md project scope).
 */
export interface WorkspaceDefaults {
  readonly agentId: string | null;
  readonly baseBranch: string | null;
  readonly permissionMode: PermissionMode;
}

/** SV1-TRUST-05 — an Attempt whose processes may still be running (non-terminal status). */
export interface NonTerminalAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly status: Extract<
    AttemptStatus,
    "Queued" | "Starting" | "Running" | "Waiting" | "Stopping"
  >;
}

/** RT-OWN-01 — a Workspace binds one Repository (commonGitDir + its dev/ino is the common Repository identity). */
export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly trustId: string;
  readonly canonicalRoot: string;
  readonly commonGitDir: string;
  /** dev/ino of the realpath'd commonGitDir, frozen at Active (SV1-FILE-10). */
  readonly commonGitDirIdentity: FilesystemIdentity;
  readonly headCommitSha: string;
  readonly currentBranch: string | null;
  readonly defaultBaseRef: string | null;
  readonly defaultBaseRefSha: string | null;
  readonly gitVersion: string;
  readonly defaults: WorkspaceDefaults;
  readonly observedAt: string;
  readonly createdAt: string;
}

interface TrustRow {
  readonly trust_id: string;
  readonly trust_version: number;
  readonly state: PersistedTrustState;
  readonly candidate_canonical_root: string;
  readonly fs_dev: number;
  readonly fs_ino: number;
  readonly user_identity: string;
  readonly challenge_id: string;
  readonly validation_failure_json: string | null;
  readonly validated_repository_json: string | null;
  readonly revocation_process_choice: "stop" | "keep" | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly trust_id: string;
  readonly canonical_root: string;
  readonly common_git_dir: string;
  readonly common_git_dev: number;
  readonly common_git_ino: number;
  readonly head_commit_sha: string;
  readonly current_branch: string | null;
  readonly default_base_ref: string | null;
  readonly default_base_ref_sha: string | null;
  readonly git_version: string;
  readonly defaults_json: string;
  readonly observed_at: string;
  readonly created_at: string;
}

const trustRecord = (row: TrustRow): RepositoryTrustRecord => ({
  trustId: row.trust_id,
  trustVersion: row.trust_version,
  state: row.state,
  candidateCanonicalRoot: row.candidate_canonical_root,
  filesystemIdentity: { dev: row.fs_dev, ino: row.fs_ino },
  userIdentity: row.user_identity,
  challengeId: row.challenge_id,
  validationFailure:
    row.validation_failure_json === null
      ? null
      : (JSON.parse(row.validation_failure_json) as RepositoryValidationFailure),
  validatedRepository:
    row.validated_repository_json === null
      ? null
      : (JSON.parse(row.validated_repository_json) as ValidatedRepository),
  revocationProcessChoice: row.revocation_process_choice,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workspaceRecord = (row: WorkspaceRow): WorkspaceRecord => ({
  workspaceId: row.workspace_id,
  trustId: row.trust_id,
  canonicalRoot: row.canonical_root,
  commonGitDir: row.common_git_dir,
  commonGitDirIdentity: { dev: row.common_git_dev, ino: row.common_git_ino },
  headCommitSha: row.head_commit_sha,
  currentBranch: row.current_branch,
  defaultBaseRef: row.default_base_ref,
  defaultBaseRefSha: row.default_base_ref_sha,
  gitVersion: row.git_version,
  defaults: JSON.parse(row.defaults_json) as WorkspaceDefaults,
  observedAt: row.observed_at,
  createdAt: row.created_at,
});

// RT-REPO-05 — every stored transition goes through the contracts transition
// table; anything the table does not allow is a Conflict, never a silent write.
const assertTransition = (from: PersistedTrustState, to: PersistedTrustState): void => {
  if (!RepositoryTrust.canTransition(from, to)) {
    throw new StoreError("Conflict", `illegal Repository Trust transition ${from} -> ${to}`);
  }
};

export class RepositoryTrustStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  #trustRow(trustId: string): TrustRow {
    const row = this.#db
      .prepare("SELECT * FROM repository_trusts WHERE trust_id = ?")
      .get(trustId) as TrustRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Repository Trust: ${trustId}`);
    return row;
  }

  /** The live (non-Revoked) Trust for a candidate root, when one exists. */
  liveTrustForRoot(candidateCanonicalRoot: string): RepositoryTrustRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM repository_trusts WHERE candidate_canonical_root = ? AND state != 'Revoked'",
      )
      .get(candidateCanonicalRoot) as TrustRow | undefined;
    return row === undefined ? null : trustRecord(row);
  }

  getTrust(trustId: string): RepositoryTrustRecord {
    return trustRecord(this.#trustRow(trustId));
  }

  /** Every grant the root has ever seen, oldest first; revoked versions are kept (RT-REPO-05). */
  listTrustVersions(candidateCanonicalRoot: string): readonly RepositoryTrustRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM repository_trusts WHERE candidate_canonical_root = ? ORDER BY trust_version",
      )
      .all(candidateCanonicalRoot) as unknown as TrustRow[];
    return rows.map(trustRecord);
  }

  // First confirmation: Untrusted -> PendingValidation is the INSERT itself.
  // One live Trust per root; a re-grant of a revoked root gets the next
  // trust_version (RT-REPO-05).
  createPendingTrust(input: {
    readonly candidate: RepositoryCandidate;
    readonly userIdentity: string;
    readonly challengeId: string;
  }): RepositoryTrustRecord {
    return transact(
      this.#db,
      () => {
        const root = input.candidate.canonicalRoot;
        if (this.liveTrustForRoot(root) !== null) {
          throw new StoreError(
            "Conflict",
            `a non-Revoked Repository Trust already exists for ${root}`,
          );
        }
        const versionRow = this.#db
          .prepare(
            "SELECT COALESCE(MAX(trust_version), 0) + 1 AS v FROM repository_trusts WHERE candidate_canonical_root = ?",
          )
          .get(root) as { v: number };
        const trustId = `rt_${randomUUID()}`;
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `INSERT INTO repository_trusts
             (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino, user_identity, challenge_id, validation_failure_json, validated_repository_json, created_at, updated_at)
             VALUES (?, ?, 'PendingValidation', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            trustId,
            versionRow.v,
            root,
            input.candidate.filesystemIdentity.dev,
            input.candidate.filesystemIdentity.ino,
            input.userIdentity,
            input.challengeId,
            now,
            now,
          );
        return trustRecord(this.#trustRow(trustId));
      },
      this.#now,
    );
  }

  // SV1-TRUST-08 — an ordinary validation failure keeps PendingValidation and
  // records the failure for inspection; only root-mismatch / identity-drift
  // revoke (markRevoked below).
  recordValidationFailure(
    trustId: string,
    failure: RepositoryValidationFailure,
  ): RepositoryTrustRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#trustRow(trustId);
        if (row.state !== "PendingValidation") {
          throw new StoreError(
            "Conflict",
            `cannot record a validation failure on a ${row.state} Repository Trust`,
          );
        }
        this.#db
          .prepare(
            "UPDATE repository_trusts SET validation_failure_json = ?, updated_at = ? WHERE trust_id = ?",
          )
          .run(JSON.stringify(failure), new Date(this.#now()).toISOString(), trustId);
        return trustRecord(this.#trustRow(trustId));
      },
      this.#now,
    );
  }

  // RT-REPO-03 — the only path to Active: the Trust flip, the Workspace and
  // the Repository binding commit in this one transaction, so a crash can
  // never leave an Active Trust without its Workspace (or vice versa). The
  // common Git directory's dev/ino is frozen alongside its path (SV1-FILE-10),
  // and the Workspace's initial default selections are derived from the
  // validated Repository (RT-OWN-01): baseBranch comes from the current
  // branch, falling back to the clone-recorded default base ref, else null —
  // never guessed.
  activateWithWorkspace(
    trustId: string,
    validated: ValidatedRepository,
  ): { trust: RepositoryTrustRecord; workspace: WorkspaceRecord } {
    return transact(
      this.#db,
      () => {
        const row = this.#trustRow(trustId);
        assertTransition(row.state, "Active");
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            "UPDATE repository_trusts SET state = 'Active', validated_repository_json = ?, validation_failure_json = NULL, updated_at = ? WHERE trust_id = ?",
          )
          .run(JSON.stringify(validated), now, trustId);
        const workspaceId = `ws_${randomUUID()}`;
        const initialDefaults: WorkspaceDefaults = {
          agentId: null,
          baseBranch: validated.currentBranch ?? validated.defaultBaseRef ?? null,
          permissionMode: "Balanced",
        };
        this.#db
          .prepare(
            `INSERT INTO workspaces
             (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev, common_git_ino, head_commit_sha, current_branch, default_base_ref, default_base_ref_sha, git_version, defaults_json, observed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            trustId,
            validated.workingTreeRoot,
            validated.commonGitDir,
            validated.commonGitDirIdentity.dev,
            validated.commonGitDirIdentity.ino,
            validated.headCommitSha,
            validated.currentBranch,
            validated.defaultBaseRef,
            validated.defaultBaseRefSha,
            validated.gitVersion,
            JSON.stringify(initialDefaults),
            validated.observedAt,
            now,
          );
        return {
          trust: trustRecord(this.#trustRow(trustId)),
          workspace: workspaceRecord(this.#workspaceRow(workspaceId)),
        };
      },
      this.#now,
    );
  }

  // RT-REPO-05 — PendingValidation|Active -> Revoked; Revoked is terminal for
  // this trust_version. `cause` records why (user revoke or identity drift).
  // `processChoice` persists the user's stop-or-keep decision for still
  // potentially running processes (SV1-TRUST-05); executing a "stop" is the
  // Session runtime's job (R1-05) — this slice only records the choice.
  markRevoked(
    trustId: string,
    cause?: RepositoryValidationFailure,
    processChoice?: "stop" | "keep",
  ): RepositoryTrustRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#trustRow(trustId);
        assertTransition(row.state, "Revoked");
        this.#db
          .prepare(
            "UPDATE repository_trusts SET state = 'Revoked', validation_failure_json = COALESCE(?, validation_failure_json), revocation_process_choice = COALESCE(?, revocation_process_choice), updated_at = ? WHERE trust_id = ?",
          )
          .run(
            cause === undefined ? null : JSON.stringify(cause),
            processChoice ?? null,
            new Date(this.#now()).toISOString(),
            trustId,
          );
        return trustRecord(this.#trustRow(trustId));
      },
      this.#now,
    );
  }

  // SV1-TRUST-05 — Attempts of this Trust's Workspaces that may still have
  // running processes (non-terminal status). Used by revoke to require the
  // explicit stop-or-keep choice. Alive Sessions are not queryable yet — the
  // Session runtime lands in R1-05; when it does, revoke must surface them
  // here too.
  listNonTerminalAttemptsForTrust(trustId: string): readonly NonTerminalAttempt[] {
    const rows = this.#db
      .prepare(
        `SELECT a.attempt_id AS attempt_id, a.task_id AS task_id, a.status AS status
         FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
         JOIN workspaces w ON w.workspace_id = t.workspace_id
         WHERE w.trust_id = ? AND a.status IN ('Queued','Starting','Running','Waiting','Stopping')
         ORDER BY a.created_seq`,
      )
      .all(trustId) as unknown as { attempt_id: string; task_id: string; status: string }[];
    return rows.map((r) => ({
      attemptId: r.attempt_id,
      taskId: r.task_id,
      status: r.status as NonTerminalAttempt["status"],
    }));
  }

  #workspaceRow(workspaceId: string): WorkspaceRow {
    const row = this.#db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Workspace: ${workspaceId}`);
    return row;
  }

  // Revocation never deletes the Workspace row (SV1-TRUST-05: no silent data
  // loss); the joined Trust state tells callers the Workspace is not runnable.
  getWorkspaceWithTrust(workspaceId: string): {
    workspace: WorkspaceRecord;
    trust: RepositoryTrustRecord;
  } {
    const row = this.#workspaceRow(workspaceId);
    return { workspace: workspaceRecord(row), trust: this.getTrust(row.trust_id) };
  }

  // RT-OWN-01 — replace a Workspace's default selections. The caller
  // (TrustService.updateWorkspaceDefaults) validates the shape, merges the
  // patch and gates on an Active Trust; this is the single persisted write.
  updateWorkspaceDefaults(workspaceId: string, defaults: WorkspaceDefaults): WorkspaceRecord {
    this.#workspaceRow(workspaceId); // NotFound before any write
    this.#db
      .prepare("UPDATE workspaces SET defaults_json = ? WHERE workspace_id = ?")
      .run(JSON.stringify(defaults), workspaceId);
    return workspaceRecord(this.#workspaceRow(workspaceId));
  }
}
