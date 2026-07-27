import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LaunchSpec } from "@agents-fleet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../storage/database.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { TaskStore } from "../storage/task-store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const tempDirs: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const launchSpec = (cwd: string): LaunchSpec => ({
  executablePath: process.execPath,
  argv: ["agent.mjs"],
  cwd,
  env: { PATH: "/usr/bin:/bin" },
  channel: "interactive-pty",
  capabilities: ["Discovery"],
  permissionMapping: {
    requestedMode: "Manual",
    effectiveMode: "Manual",
    launchArgumentsPreview: [],
    enforcedCapabilities: [],
    unsupportedControls: [],
    warnings: [],
  },
  secretReferenceIdentities: [],
});

const setup = (): { readonly db: DatabaseSync; readonly taskStore: TaskStore } => {
  const dir = mkdtempSync(join(tmpdir(), "af-r105-scheduler-"));
  tempDirs.push(dir);
  const opened = openDatabase({ path: join(dir, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(`database not ready: ${opened.reason}`);
  databases.push(opened.db);
  const db = opened.db;
  const now = new Date(T0).toISOString();

  db.prepare(
    `INSERT INTO repository_trusts
      (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino,
       user_identity, challenge_id, created_at, updated_at)
     VALUES ('trust-1', 1, 'Active', '/repo', 1, 2, 'user', 'challenge', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces
      (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev,
       common_git_ino, head_commit_sha, current_branch, default_base_ref,
       default_base_ref_sha, git_version, defaults_json, observed_at, created_at)
     VALUES ('workspace-1', 'trust-1', '/repo', '/repo/.git', 3, 4, ?, 'main',
             'refs/heads/main', ?, '2.50.1', '{}', ?, ?)`,
  ).run(SHA, SHA, now, now);

  for (const [taskId, attemptId, createdAt, seq, path, branch] of [
    ["task-old", "attempt-old", "2026-01-01T00:00:00.000Z", 1, "/tmp/wt-old", "fleet/old"],
    ["task-new", "attempt-new", "2026-01-02T00:00:00.000Z", 2, "/tmp/wt-new", "fleet/new"],
  ] as const) {
    db.prepare(
      `INSERT INTO tasks
        (task_id, workspace_id, lifecycle, spec_json, task_spec_version, created_at, updated_at)
       VALUES (?, 'workspace-1', 'Runnable', '{"goal":"test"}', 1, ?, ?)`,
    ).run(taskId, createdAt, createdAt);
    db.prepare(
      `INSERT INTO attempts
        (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at)
       VALUES (?, ?, 'Queued', '{"goal":"test"}', 1, ?, ?)`,
    ).run(attemptId, taskId, seq, createdAt);
    db.prepare(
      `INSERT INTO fleet_worktrees
        (worktree_id, workspace_id, task_id, state, role, canonical_path,
         repository_identity, branch_name, base_commit_sha, head_commit_sha,
         fs_dev, fs_ino, state_version, observed_at, created_at, updated_at)
       VALUES (?, 'workspace-1', ?, 'Ready', 'Active', ?, '3:4', ?, ?, ?,
               ?, ?, 1, ?, ?, ?)`,
    ).run(
      `worktree-${seq}`,
      taskId,
      path,
      branch,
      SHA,
      SHA,
      10 + seq,
      20 + seq,
      now,
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO attempt_worktree_bindings
        (attempt_id, worktree_id, base_commit_sha, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(attemptId, `worktree-${seq}`, SHA, createdAt);
  }

  return { db, taskStore: new TaskStore(db, () => T0) };
};

describe("TaskOrchestrator.scheduleNext (RT-SCHED-01..03)", () => {
  it("prepares the oldest Ready Attempt and leaves the next one queued while its Agent slot is occupied", async () => {
    const { db, taskStore } = setup();
    const orchestrator = new TaskOrchestrator({
      db,
      now: () => T0,
      prepareLaunch: async (attempt) => ({
        commandId: `command-${attempt.attemptId}`,
        agentId: "claude-code",
        launchSpec: launchSpec(attempt.worktreePath),
      }),
    });

    const prepared = await orchestrator.scheduleNext();

    expect(prepared).toMatchObject({
      kind: "prepared",
      attemptId: "attempt-old",
      commandId: "command-attempt-old",
      agentId: "claude-code",
    });
    expect(taskStore.listAttempts("task-old")[0]?.status).toBe("Starting");
    expect(taskStore.listAttempts("task-new")[0]?.status).toBe("Queued");

    await expect(orchestrator.scheduleNext()).resolves.toEqual({
      kind: "blocked",
      reason: "agent-slot-unavailable",
    });
    expect(taskStore.listAttempts("task-new")[0]?.status).toBe("Queued");
  });

  it("lets one concurrent scheduler claim the single Agent slot and reports the other as blocked", async () => {
    const { db, taskStore } = setup();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothPrepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareLaunch = async (attempt: {
      readonly attemptId: string;
      readonly worktreePath: string;
    }) => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothPrepared;
      return {
        commandId: `command-${attempt.attemptId}`,
        agentId: "claude-code",
        launchSpec: launchSpec(attempt.worktreePath),
      };
    };
    const first = new TaskOrchestrator({ db, now: () => T0, prepareLaunch });
    const second = new TaskOrchestrator({ db, now: () => T0, prepareLaunch });

    const results = await Promise.all([first.scheduleNext(), second.scheduleNext()]);

    expect(results.map((result) => result.kind).sort()).toEqual(["blocked", "prepared"]);
    expect(taskStore.listAttempts("task-old")[0]?.status).toBe("Starting");
    expect(taskStore.listAttempts("task-new")[0]?.status).toBe("Queued");
  });

  it("removes a cancelled Queued Attempt before scheduling the next Ready Attempt", async () => {
    const { db, taskStore } = setup();
    taskStore.cancelTask("task-old");
    const orchestrator = new TaskOrchestrator({
      db,
      now: () => T0,
      prepareLaunch: async (attempt) => ({
        commandId: `command-${attempt.attemptId}`,
        agentId: "claude-code",
        launchSpec: launchSpec(attempt.worktreePath),
      }),
    });

    const result = await orchestrator.scheduleNext();

    expect(taskStore.listAttempts("task-old")[0]?.status).toBe("Cancelled");
    expect(result).toMatchObject({ kind: "prepared", attemptId: "attempt-new" });
  });
});
