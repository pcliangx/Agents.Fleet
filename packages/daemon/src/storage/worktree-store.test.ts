// R1-04 — durable Worktree record and Ready transaction.
// RT-WORKTREE-05/06/10 + RT-STO-01: tests use a real temporary SQLite
// database; lifecycle state, role, Attempt outcome and domain events move in
// one transaction.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, transact } from "./database.js";
import { ALL_MIGRATIONS } from "./migrations.js";
import { TaskStore } from "./task-store.js";
import {
  type PlannedWorktreeInput,
  type ProvisionedWorktreeFacts,
  WorktreeStore,
} from "./worktree-store.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T0 = Date.parse("2026-07-27T08:00:00.000Z");

let dir = "";
let db: DatabaseSync;
let tasks: TaskStore;
let worktrees: WorktreeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "af-r104-store-"));
  const opened = openDatabase({ path: join(dir, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(opened.reason);
  db = opened.db;
  tasks = new TaskStore(db, () => T0);
  worktrees = new WorktreeStore(db, () => T0);

  db.prepare(
    `INSERT INTO repository_trusts
     (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino,
      user_identity, challenge_id, created_at, updated_at)
     VALUES ('rt-1', 1, 'Active', ?, 11, 12, 'user-1', 'challenge-1', ?, ?)`,
  ).run(join(dir, "repo"), new Date(T0).toISOString(), new Date(T0).toISOString());
  db.prepare(
    `INSERT INTO workspaces
     (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev, common_git_ino,
      head_commit_sha, current_branch, default_base_ref, default_base_ref_sha, git_version,
      defaults_json, observed_at, created_at)
     VALUES ('ws-1', 'rt-1', ?, ?, 21, 22, ?, 'main', NULL, NULL, 'git version 2.50.1',
      '{"agentId":null,"baseBranch":"main","permissionMode":"Balanced"}', ?, ?)`,
  ).run(
    join(dir, "repo"),
    join(dir, "repo", ".git"),
    SHA_A,
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const createQueuedAttempt = (): { taskId: string; attemptId: string } => {
  const task = tasks.createTask({ workspaceId: "ws-1", spec: { goal: "work" } });
  tasks.startTask(task.taskId);
  const attempt = tasks.listAttempts(task.taskId)[0];
  if (attempt === undefined) throw new Error("missing queued Attempt");
  return { taskId: task.taskId, attemptId: attempt.attemptId };
};

const plannedInput = (taskId: string, attemptId: string, suffix = "one"): PlannedWorktreeInput => ({
  taskId,
  attemptId,
  workspaceId: "ws-1",
  canonicalPath: join(dir, `worktree-${suffix}`),
  branchName: `fleet/${suffix}`,
  baseCommitSha: SHA_A,
});

const provisionedFacts = (
  record: ReturnType<WorktreeStore["createPlanned"]>,
): ProvisionedWorktreeFacts => ({
  canonicalPath: record.canonicalPath,
  repositoryIdentity: record.repositoryIdentity,
  branchName: record.branchName,
  baseCommitSha: record.baseCommitSha,
  headCommitSha: record.baseCommitSha,
  filesystemIdentity: { dev: 31, ino: 32 },
  observedAt: new Date(T0 + 1_000).toISOString(),
});

describe("WorktreeStore planned records (RT-WORKTREE-05/10)", () => {
  it("creates Planned + Pending and binds the creating Attempt", () => {
    const { taskId, attemptId } = createQueuedAttempt();
    const record = worktrees.createPlanned(plannedInput(taskId, attemptId));

    expect(record).toMatchObject({
      taskId,
      workspaceId: "ws-1",
      state: "Planned",
      role: "Pending",
      repositoryIdentity: "21:22",
      baseCommitSha: SHA_A,
      branchName: "fleet/one",
      filesystemIdentity: null,
      stateVersion: 1,
    });
    expect(worktrees.worktreeForAttempt(attemptId)?.worktreeId).toBe(record.worktreeId);
  });

  it("composes with Attempt creation in one outer transaction", () => {
    const task = tasks.createTask({ workspaceId: "ws-1", spec: { goal: "atomic" } });

    expect(() =>
      transact(db, () => {
        tasks.startTask(task.taskId);
        const attempt = tasks.listAttempts(task.taskId)[0];
        if (attempt === undefined) throw new Error("missing Attempt");
        worktrees.createPlanned(plannedInput(task.taskId, attempt.attemptId));
        throw new Error("crash before commit");
      }),
    ).toThrow("crash before commit");

    expect(tasks.listAttempts(task.taskId)).toEqual([]);
    expect(worktrees.listForTask(task.taskId)).toEqual([]);
    expect(tasks.listTasks("ws-1")[0]?.lifecycle).toBe("Draft");
  });

  it("rejects a planned path or branch collision without creating a second record", () => {
    const first = createQueuedAttempt();
    worktrees.createPlanned(plannedInput(first.taskId, first.attemptId));

    const second = createQueuedAttempt();
    expect(() =>
      worktrees.createPlanned(plannedInput(second.taskId, second.attemptId)),
    ).toThrowError(expect.objectContaining({ code: "Conflict" }));
    expect(worktrees.listForTask(second.taskId)).toEqual([]);
  });
});

describe("WorktreeStore Ready transaction (RT-WORKTREE-05/06/10)", () => {
  it("makes the complete result Ready + Active and records actual identity", () => {
    const { taskId, attemptId } = createQueuedAttempt();
    const planned = worktrees.createPlanned(plannedInput(taskId, attemptId));

    const ready = worktrees.commitProvisioned(planned.worktreeId, provisionedFacts(planned));

    expect(ready).toMatchObject({
      state: "Ready",
      role: "Active",
      filesystemIdentity: { dev: 31, ino: 32 },
      headCommitSha: SHA_A,
      stateVersion: 2,
    });
    expect(tasks.listAttempts(taskId)[0]?.status).toBe("Queued");
    expect(tasks.listEvents(taskId).at(-1)).toMatchObject({
      type: "worktree-ready",
      attemptId,
    });
  });

  it("switches the old Active Worktree to Historical in the same transaction", () => {
    const first = createQueuedAttempt();
    const old = worktrees.createPlanned(plannedInput(first.taskId, first.attemptId, "old"));
    worktrees.commitProvisioned(old.worktreeId, provisionedFacts(old));

    // R1-07 will own retry creation. This fixture inserts its Queued Attempt
    // directly so the R1-04 Ready transaction can prove the ownership switch.
    db.prepare(
      `INSERT INTO attempts
       (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at)
       VALUES ('at-retry', ?, 'Queued', '{"goal":"retry"}', 1, 2, ?)`,
    ).run(first.taskId, new Date(T0).toISOString());
    const next = worktrees.createPlanned(plannedInput(first.taskId, "at-retry", "next"));

    const ready = worktrees.commitProvisioned(next.worktreeId, provisionedFacts(next));

    expect(ready.role).toBe("Active");
    expect(worktrees.get(old.worktreeId).role).toBe("Historical");
    expect(
      worktrees.listForTask(first.taskId).filter((record) => record.role === "Active"),
    ).toEqual([ready]);
  });

  it("accepts a complete CancelTask race only as Ready + Historical", () => {
    const { taskId, attemptId } = createQueuedAttempt();
    const planned = worktrees.createPlanned(plannedInput(taskId, attemptId));
    tasks.cancelTask(taskId);

    const ready = worktrees.commitProvisioned(planned.worktreeId, provisionedFacts(planned));

    expect(ready).toMatchObject({ state: "Ready", role: "Historical" });
    expect(worktrees.listForTask(taskId).filter((record) => record.role === "Active")).toEqual([]);
  });

  it("classifies mismatched provision facts as Orphaned + Pending and fails Queued Attempt", () => {
    const { taskId, attemptId } = createQueuedAttempt();
    const planned = worktrees.createPlanned(plannedInput(taskId, attemptId));

    const orphaned = worktrees.commitProvisioned(planned.worktreeId, {
      ...provisionedFacts(planned),
      headCommitSha: SHA_B,
    });

    expect(orphaned).toMatchObject({
      state: "Orphaned",
      role: "Pending",
      failureReason: "provision-result-mismatch",
    });
    expect(tasks.listAttempts(taskId)[0]?.status).toBe("Failed");
  });

  it("maps proven-clean failure to Failed and possible leftovers to Orphaned", () => {
    const clean = createQueuedAttempt();
    const cleanPlan = worktrees.createPlanned(
      plannedInput(clean.taskId, clean.attemptId, "clean-failure"),
    );
    const failed = worktrees.commitProvisionFailure(cleanPlan.worktreeId, {
      reason: "git-failed",
      detail: "no Worktree was created",
      leftover: "none",
    });
    expect(failed).toMatchObject({ state: "Failed", role: "Pending" });
    expect(tasks.listAttempts(clean.taskId)[0]?.status).toBe("Failed");

    const uncertain = createQueuedAttempt();
    const uncertainPlan = worktrees.createPlanned(
      plannedInput(uncertain.taskId, uncertain.attemptId, "unknown-leftover"),
    );
    const orphaned = worktrees.commitProvisionFailure(uncertainPlan.worktreeId, {
      reason: "git-failed",
      detail: "path may remain",
      leftover: "unknown",
    });
    expect(orphaned).toMatchObject({ state: "Orphaned", role: "Pending" });
    expect(tasks.listAttempts(uncertain.taskId)[0]?.status).toBe("Failed");
  });
});

describe("WorktreeStore lifecycle observations (RT-WORKTREE-07 / RT-STATE-23)", () => {
  it.each([
    ["Probing", true],
    ["OrphanFound", true],
    ["KeepRequested", true],
    ["StopRequested", true],
    ["ConfirmedAbsent", false],
    ["ConfirmedStopped", false],
  ] as const)(
    "returns %s and only blocks disposal while a process may remain",
    (disposition, blocks) => {
      const { taskId, attemptId } = createQueuedAttempt();
      const planned = worktrees.createPlanned(plannedInput(taskId, attemptId, disposition));
      const observedAt = new Date(T0 + 2_000).toISOString();
      db.prepare(
        `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
       VALUES (?, ?, ?)`,
      ).run(attemptId, disposition, observedAt);

      const facts = worktrees.disposeLifecycleFacts(planned.worktreeId);

      expect(facts.processDispositions).toEqual([{ attemptId, disposition, observedAt }]);
      expect(facts.pendingProcessAttemptIds).toEqual(blocks ? [attemptId] : []);
    },
  );
});
