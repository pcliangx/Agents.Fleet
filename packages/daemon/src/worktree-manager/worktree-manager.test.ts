// R1-04 Worktree Manager Interface — provision vertical slice.
// Real Git + real temporary SQLite; the R0 no-external-program materializer is
// composed with the R1 durable state / idempotency transaction.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CommandId, WorktreeId } from "@agents-fleet/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeProvisioner } from "../git/provision-worktree.js";
import { openDatabase } from "../storage/database.js";
import { IdempotencyStore } from "../storage/idempotency.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { TaskStore } from "../storage/task-store.js";
import { WorktreeStore } from "../storage/worktree-store.js";
import { WorktreeManagerImpl } from "./worktree-manager.js";

const GIT = "/usr/bin/git";
const T0 = Date.parse("2026-07-27T09:00:00.000Z");
const SETUP_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8", env: SETUP_ENV }).trim();

let root = "";
let repo = "";
let db: DatabaseSync;
let tasks: TaskStore;
let worktrees: WorktreeStore;
let manager: WorktreeManagerImpl;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "af-r104-manager-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["-c", "user.name=fixture", "-c", "user.email=f@example.invalid", "add", "."]);
  git(repo, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);

  const opened = openDatabase({ path: join(root, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(opened.reason);
  db = opened.db;
  tasks = new TaskStore(db, () => T0);
  worktrees = new WorktreeStore(db, () => T0);
  const repositoryStat = lstatSync(repo);
  const commonGitDir = realpathSync(join(repo, ".git"));
  const commonStat = lstatSync(commonGitDir);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const now = new Date(T0).toISOString();
  db.prepare(
    `INSERT INTO repository_trusts
     (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino,
      user_identity, challenge_id, created_at, updated_at)
     VALUES ('rt-1', 1, 'Active', ?, ?, ?, 'user-1', 'challenge-1', ?, ?)`,
  ).run(repo, repositoryStat.dev, repositoryStat.ino, now, now);
  db.prepare(
    `INSERT INTO workspaces
     (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev, common_git_ino,
      head_commit_sha, current_branch, default_base_ref, default_base_ref_sha, git_version,
      defaults_json, observed_at, created_at)
     VALUES ('ws-1', 'rt-1', ?, ?, ?, ?, ?, 'main', NULL, NULL, 'git version 2.50.1',
      '{"agentId":null,"baseBranch":"main","permissionMode":"Balanced"}', ?, ?)`,
  ).run(repo, commonGitDir, commonStat.dev, commonStat.ino, head, now, now);
  manager = new WorktreeManagerImpl({
    db,
    store: worktrees,
    idempotency: new IdempotencyStore(db, () => T0),
    now: () => T0,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const plan = (suffix = "one") => {
  const task = tasks.createTask({ workspaceId: "ws-1", spec: { goal: "implement" } });
  tasks.startTask(task.taskId);
  const attempt = tasks.listAttempts(task.taskId)[0];
  if (attempt === undefined) throw new Error("missing Attempt");
  return worktrees.createPlanned({
    taskId: task.taskId,
    attemptId: attempt.attemptId,
    workspaceId: "ws-1",
    canonicalPath: join(root, `wt-${suffix}`),
    branchName: `fleet/${suffix}`,
    baseCommitSha: git(repo, ["rev-parse", "HEAD"]),
  });
};

describe("WorktreeManager.provision (RT-WORKTREE-05/06/10/11)", () => {
  it("materializes the managed branch and commits Ready + Active", async () => {
    const planned = plan();
    const result = await manager.provision({
      commandId: "cmd-provision-1" as CommandId,
      worktreeId: planned.worktreeId,
    });

    expect(result).toMatchObject({
      ok: true,
      worktreeId: planned.worktreeId,
      state: "Ready",
      role: "Active",
    });
    expect(worktrees.get(planned.worktreeId)).toMatchObject({
      state: "Ready",
      role: "Active",
      branchName: "fleet/one",
    });
    expect(git(planned.canonicalPath, ["branch", "--show-current"])).toBe("fleet/one");
  });

  it("replays the same command result without provisioning a second Worktree", async () => {
    const planned = plan();
    const input = {
      commandId: "cmd-provision-replay" as CommandId,
      worktreeId: planned.worktreeId,
    };

    const first = await manager.provision(input);
    const replay = await manager.provision(input);

    expect(replay).toEqual(first);
    expect(git(repo, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(2);
    const commandCount = (
      db
        .prepare("SELECT COUNT(*) AS count FROM command_records WHERE command_id = ?")
        .get(input.commandId) as { count: number }
    ).count;
    expect(commandCount).toBe(1);
  });

  it("fails closed before Ready when the Repository needs an external filter", async () => {
    writeFileSync(join(repo, ".gitattributes"), "README.md filter=required-driver\n");
    git(repo, ["add", ".gitattributes"]);
    git(repo, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-m",
      "requires filter",
    ]);
    const planned = plan("filter");

    const result = await manager.provision({
      commandId: "cmd-provision-filter" as CommandId,
      worktreeId: planned.worktreeId as WorktreeId,
    });

    expect(result).toMatchObject({
      ok: false,
      state: "Failed",
      failure: { kind: "CapabilityUnavailable" },
    });
    expect(worktrees.get(planned.worktreeId)).toMatchObject({
      state: "Failed",
      role: "Pending",
    });
    expect(() => lstatSync(planned.canonicalPath)).toThrow();
  });

  it("reconciles the one exact Worktree left after Git success but before Ready commit", async () => {
    const planned = plan("crash-window");
    const repositoryStat = lstatSync(repo);
    const materialized = await new WorktreeProvisioner().provisionWorktree({
      repository: {
        workingTreeRoot: repo,
        filesystemIdentity: { dev: repositoryStat.dev, ino: repositoryStat.ino },
      },
      baseCommitSha: planned.baseCommitSha,
      targetPath: planned.canonicalPath,
      branchName: planned.branchName,
    });
    expect(materialized.ok).toBe(true);
    expect(worktrees.get(planned.worktreeId).state).toBe("Planned");

    const reconciled = await manager.provision({
      commandId: "cmd-provision-crash-window" as CommandId,
      worktreeId: planned.worktreeId,
    });

    expect(reconciled).toMatchObject({
      ok: true,
      state: "Ready",
      role: "Active",
    });
    expect(git(repo, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(2);
  });

  it("classifies path and branch collisions as Orphaned without overwriting either", async () => {
    const pathCollision = plan("path-collision");
    mkdirSync(pathCollision.canonicalPath);
    writeFileSync(join(pathCollision.canonicalPath, "foreign.txt"), "foreign\n");
    const pathResult = await manager.provision({
      commandId: "cmd-provision-path-collision" as CommandId,
      worktreeId: pathCollision.worktreeId,
    });
    expect(pathResult).toMatchObject({ ok: false, state: "Orphaned" });
    expect(
      execFileSync("/bin/cat", [join(pathCollision.canonicalPath, "foreign.txt")], {
        encoding: "utf8",
      }),
    ).toBe("foreign\n");

    const branchCollision = plan("branch-collision");
    git(repo, ["branch", branchCollision.branchName, branchCollision.baseCommitSha]);
    const branchResult = await manager.provision({
      commandId: "cmd-provision-branch-collision" as CommandId,
      worktreeId: branchCollision.worktreeId,
    });
    expect(branchResult).toMatchObject({ ok: false, state: "Orphaned" });
    expect(existsSync(branchCollision.canonicalPath)).toBe(false);
    expect(
      git(repo, ["show-ref", "--verify", `refs/heads/${branchCollision.branchName}`]),
    ).toContain(branchCollision.baseCommitSha);
  });

  it("accepts a complete provision result after CancelTask only as Ready + Historical", async () => {
    let materialized!: () => void;
    const didMaterialize = new Promise<void>((resolve) => {
      materialized = resolve;
    });
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    class PausingProvisioner extends WorktreeProvisioner {
      override async provisionWorktree(
        input: Parameters<WorktreeProvisioner["provisionWorktree"]>[0],
      ) {
        const result = await super.provisionWorktree(input);
        materialized();
        await mayFinish;
        return result;
      }
    }
    const racingManager = new WorktreeManagerImpl({
      db,
      store: worktrees,
      idempotency: new IdempotencyStore(db, () => T0),
      provisioner: new PausingProvisioner(),
      now: () => T0,
    });
    const planned = plan("cancel-race");
    const pending = racingManager.provision({
      commandId: "cmd-provision-cancel-race" as CommandId,
      worktreeId: planned.worktreeId,
    });
    await didMaterialize;
    tasks.cancelTask(planned.taskId);
    finish();

    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      state: "Ready",
      role: "Historical",
    });
    expect(
      worktrees.listForTask(planned.taskId).filter((record) => record.role === "Active"),
    ).toEqual([]);
  });

  it("creates a clean rebaseline target without copying old staged, unstaged, or untracked data", async () => {
    const old = plan("old-dirty");
    await manager.provision({
      commandId: "cmd-provision-old-dirty" as CommandId,
      worktreeId: old.worktreeId,
    });
    writeFileSync(join(old.canonicalPath, "staged.txt"), "staged\n");
    git(old.canonicalPath, ["add", "staged.txt"]);
    writeFileSync(join(old.canonicalPath, "README.md"), "unstaged\n");
    writeFileSync(join(old.canonicalPath, "untracked.txt"), "untracked\n");
    const oldAttempt = (
      db
        .prepare("SELECT attempt_id FROM attempt_worktree_bindings WHERE worktree_id = ?")
        .get(old.worktreeId) as { attempt_id: string }
    ).attempt_id;
    db.prepare("UPDATE attempts SET status = 'Failed' WHERE attempt_id = ?").run(oldAttempt);
    db.prepare(
      `INSERT INTO attempts
       (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at)
       VALUES ('at-rebaseline', ?, 'Queued', '{"goal":"rebaseline"}', 1, 2, ?)`,
    ).run(old.taskId, new Date(T0).toISOString());
    const next = worktrees.createPlanned({
      taskId: old.taskId,
      attemptId: "at-rebaseline",
      workspaceId: old.workspaceId,
      canonicalPath: join(root, "wt-rebaseline"),
      branchName: "fleet/rebaseline",
      baseCommitSha: old.baseCommitSha,
    });

    const result = await manager.provision({
      commandId: "cmd-provision-rebaseline" as CommandId,
      worktreeId: next.worktreeId,
    });

    expect(result).toMatchObject({ ok: true, state: "Ready", role: "Active" });
    expect(worktrees.get(old.worktreeId).role).toBe("Historical");
    expect(git(old.canonicalPath, ["status", "--porcelain"])).toContain("staged.txt");
    expect(git(old.canonicalPath, ["status", "--porcelain"])).toContain("untracked.txt");
    expect(git(next.canonicalPath, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(next.canonicalPath, "staged.txt"))).toBe(false);
    expect(existsSync(join(next.canonicalPath, "untracked.txt"))).toBe(false);
  });
});

describe("WorktreeManager.inspect (RT-WORKTREE-07 / RT-EVIDENCE-03)", () => {
  it("returns a complete canonical GitObservation and bounded diff from local refs only", async () => {
    const planned = plan("inspect");
    const provisioned = await manager.provision({
      commandId: "cmd-provision-inspect" as CommandId,
      worktreeId: planned.worktreeId,
    });
    expect(provisioned.ok).toBe(true);

    writeFileSync(join(planned.canonicalPath, "README.md"), "staged\n");
    git(planned.canonicalPath, ["add", "README.md"]);
    writeFileSync(join(planned.canonicalPath, "README.md"), "unstaged\n");
    writeFileSync(join(planned.canonicalPath, "new.txt"), "untracked\n");
    const base = git(repo, ["rev-parse", "refs/heads/main"]);

    const result = await manager.inspect({
      worktreeId: planned.worktreeId,
      comparison: { ref: "refs/heads/main", sha: base },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection).toMatchObject({
      branchName: "fleet/inspect",
      detached: false,
      headSha: base,
      baseSha: base,
      comparisonRef: "refs/heads/main",
      comparisonSha: base,
      ahead: 0,
      behind: 0,
      refFreshness: "LocalObservationOnly",
      fingerprintBlocker: null,
    });
    expect(result.inspection.gitObservation).toMatchObject({
      worktreeId: planned.worktreeId,
      stateFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      refSource: "LocalOnly",
      refFreshness: "LocalObservationOnly",
      staged: [{ path: "README.md", status: "Modified" }],
      unstaged: [{ path: "README.md", status: "Modified" }],
      untracked: [
        {
          path: "new.txt",
          type: "file",
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          bytes: 10,
        },
      ],
    });
    expect(result.inspection.diff.staged).toContain("+staged");
    expect(result.inspection.diff.unstaged).toContain("+unstaged");
    expect(result.inspection.disposeBlockers.map((blocker) => blocker.kind)).toContain("dirty");

    const repeated = await manager.inspect({
      worktreeId: planned.worktreeId,
      comparison: { ref: "refs/heads/main", sha: base },
    });
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.inspection.gitObservation?.stateFingerprint).toBe(
      result.inspection.gitObservation?.stateFingerprint,
    );

    writeFileSync(join(planned.canonicalPath, "new.txt"), "changed\n");
    const changed = await manager.inspect({ worktreeId: planned.worktreeId });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.inspection.gitObservation?.stateFingerprint).not.toBe(
      result.inspection.gitObservation?.stateFingerprint,
    );
  });

  it("neutralizes Repository-declared programs and never fetches while inspecting", async () => {
    const planned = plan("inspect-filter");
    await manager.provision({
      commandId: "cmd-provision-inspect-filter" as CommandId,
      worktreeId: planned.worktreeId,
    });
    const sentinel = join(root, "filter-executed");
    const filter = join(root, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\n/usr/bin/touch '${sentinel}'\n/bin/cat\n`);
    chmodSync(filter, 0o755);
    git(repo, ["config", "filter.evil.clean", filter]);
    git(repo, ["config", "filter.evil.smudge", filter]);
    git(repo, ["config", "filter.evil.process", filter]);
    git(repo, ["config", "filter.evil.required", "true"]);
    git(repo, ["config", "core.fsmonitor", filter]);
    git(repo, ["config", "core.pager", filter]);
    git(repo, ["config", "diff.external", filter]);
    git(repo, ["config", "diff.evil.textconv", filter]);
    git(repo, ["config", "credential.helper", filter]);
    git(repo, ["config", "submodule.recurse", "true"]);
    git(repo, ["remote", "add", "hostile", "https://127.0.0.1:1/never-fetch"]);
    writeFileSync(
      join(planned.canonicalPath, ".gitattributes"),
      "README.md filter=evil diff=evil\n",
    );
    writeFileSync(join(planned.canonicalPath, "README.md"), "dirty\n");

    const result = await manager.inspect({ worktreeId: planned.worktreeId });

    expect(result.ok).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("fails closed when a named comparison ref no longer resolves to the previewed SHA", async () => {
    const planned = plan("target-drift");
    await manager.provision({
      commandId: "cmd-provision-target-drift" as CommandId,
      worktreeId: planned.worktreeId,
    });

    const result = await manager.inspect({
      worktreeId: planned.worktreeId,
      comparison: { ref: "refs/heads/main", sha: "f".repeat(40) },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "Conflict", detail: "comparison target drifted" },
    });
  });

  it("returns a blocker instead of a partial fingerprint above the frozen file budget", async () => {
    const planned = plan("fingerprint-limit");
    await manager.provision({
      commandId: "cmd-provision-fingerprint-limit" as CommandId,
      worktreeId: planned.worktreeId,
    });
    const many = join(planned.canonicalPath, "many");
    mkdirSync(many);
    // README is the one tracked index entry; 20,000 untracked files put the
    // full fingerprint at limit + 1.
    for (let index = 0; index < 20_000; index++) {
      writeFileSync(join(many, `${String(index).padStart(5, "0")}.txt`), "");
    }

    const result = await manager.inspect({ worktreeId: planned.worktreeId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.gitObservation).toBeNull();
    expect(result.inspection.fingerprintBlocker).toMatchObject({
      reason: "file-count-limit",
      filesObserved: 20_001,
    });
    expect(result.inspection.disposeBlockers.map((blocker) => blocker.kind)).toContain(
      "fingerprint-incomplete",
    );
  });
});

describe("WorktreeManager.dispose (SV1-FILE-04/05/09, SV1-T-18)", () => {
  const readyForDispose = async (suffix: string) => {
    const planned = plan(suffix);
    await manager.provision({
      commandId: `cmd-provision-${suffix}` as CommandId,
      worktreeId: planned.worktreeId,
    });
    const attemptId = (
      db
        .prepare("SELECT attempt_id FROM attempt_worktree_bindings WHERE worktree_id = ?")
        .get(planned.worktreeId) as { attempt_id: string }
    ).attempt_id;
    return {
      planned,
      attemptId,
      integrationTarget: {
        ref: "refs/heads/main",
        sha: git(repo, ["rev-parse", "refs/heads/main"]),
      },
    };
  };

  it("disposes a clean Worktree, records Disposed + Historical, and preserves its branch", async () => {
    const fixture = await readyForDispose("dispose-clean");
    db.prepare("UPDATE attempts SET status = 'Succeeded' WHERE attempt_id = ?").run(
      fixture.attemptId,
    );
    const preview = await manager.previewDispose({
      worktreeId: fixture.planned.worktreeId,
      integrationTarget: fixture.integrationTarget,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview).toMatchObject({
      preservedBranch: "fleet/dispose-clean",
      blockers: [],
      stateFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      estimatedReclaimBytes: expect.any(Number),
    });

    const result = await manager.dispose({
      commandId: "cmd-dispose-clean" as CommandId,
      worktreeId: fixture.planned.worktreeId,
      expectedStateVersion: preview.preview.stateVersion,
      expectedFilesystemIdentity: preview.preview.filesystemIdentity,
      expectedStateFingerprint: preview.preview.stateFingerprint as string,
      integrationTarget: fixture.integrationTarget,
      branchDisposition: "preserve",
    });

    expect(result).toMatchObject({
      ok: true,
      state: "Disposed",
      preservedBranch: "fleet/dispose-clean",
    });
    expect(worktrees.get(fixture.planned.worktreeId)).toMatchObject({
      state: "Disposed",
      role: "Historical",
    });
    expect(existsSync(fixture.planned.canonicalPath)).toBe(false);
    expect(git(repo, ["show-ref", "--verify", "refs/heads/fleet/dispose-clean"])).toContain(
      fixture.integrationTarget.sha,
    );
  });

  it("reports every lifecycle blocker and leaves the Worktree untouched", async () => {
    const fixture = await readyForDispose("dispose-lifecycle");
    const now = new Date(T0).toISOString();
    db.prepare(
      `INSERT INTO sessions
       (session_id, attempt_id, availability, role, completion_policy, created_at, updated_at)
       VALUES ('ses-alive', ?, 'Alive', 'Shell', 'DoesNotBlockAttemptCompletion', ?, ?)`,
    ).run(fixture.attemptId, now, now);
    db.prepare(
      `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
       VALUES (?, 'OrphanFound', ?)`,
    ).run(fixture.attemptId, now);

    const preview = await manager.previewDispose({
      worktreeId: fixture.planned.worktreeId,
      integrationTarget: fixture.integrationTarget,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.blockers.map((blocker) => blocker.kind)).toEqual(
      expect.arrayContaining([
        "nonterminal-attempt",
        "alive-session",
        "pending-process-disposition",
      ]),
    );
    expect(existsSync(fixture.planned.canonicalPath)).toBe(true);
  });

  it("blocks dirty state, unmerged commits, target drift, and fingerprint drift", async () => {
    const dirty = await readyForDispose("dispose-dirty");
    db.prepare("UPDATE attempts SET status = 'Succeeded' WHERE attempt_id = ?").run(
      dirty.attemptId,
    );
    writeFileSync(join(dirty.planned.canonicalPath, "dirty.txt"), "dirty\n");
    const dirtyPreview = await manager.previewDispose({
      worktreeId: dirty.planned.worktreeId,
      integrationTarget: dirty.integrationTarget,
    });
    expect(dirtyPreview.ok).toBe(true);
    if (!dirtyPreview.ok) return;
    expect(dirtyPreview.preview.blockers.map((blocker) => blocker.kind)).toContain("dirty");

    const unmerged = await readyForDispose("dispose-unmerged");
    writeFileSync(join(unmerged.planned.canonicalPath, "commit.txt"), "commit\n");
    git(unmerged.planned.canonicalPath, ["add", "commit.txt"]);
    git(unmerged.planned.canonicalPath, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-m",
      "unmerged",
    ]);
    db.prepare("UPDATE attempts SET status = 'Succeeded' WHERE attempt_id = ?").run(
      unmerged.attemptId,
    );
    const unmergedPreview = await manager.previewDispose({
      worktreeId: unmerged.planned.worktreeId,
      integrationTarget: unmerged.integrationTarget,
    });
    expect(unmergedPreview.ok).toBe(true);
    if (!unmergedPreview.ok) return;
    expect(unmergedPreview.preview.blockers.map((blocker) => blocker.kind)).toContain(
      "unmerged-commit",
    );

    const driftedTarget = await manager.previewDispose({
      worktreeId: unmerged.planned.worktreeId,
      integrationTarget: { ...unmerged.integrationTarget, sha: "f".repeat(40) },
    });
    expect(driftedTarget.ok).toBe(true);
    if (!driftedTarget.ok) return;
    expect(driftedTarget.preview.blockers.map((blocker) => blocker.kind)).toContain("target-drift");

    rmSync(join(dirty.planned.canonicalPath, "dirty.txt"));
    const cleanPreview = await manager.previewDispose({
      worktreeId: dirty.planned.worktreeId,
      integrationTarget: dirty.integrationTarget,
    });
    expect(cleanPreview.ok).toBe(true);
    if (!cleanPreview.ok || cleanPreview.preview.stateFingerprint === null) return;
    writeFileSync(join(dirty.planned.canonicalPath, "changed-after-preview.txt"), "changed\n");
    const changed = await manager.dispose({
      commandId: "cmd-dispose-state-drift" as CommandId,
      worktreeId: dirty.planned.worktreeId,
      expectedStateVersion: cleanPreview.preview.stateVersion,
      expectedFilesystemIdentity: cleanPreview.preview.filesystemIdentity,
      expectedStateFingerprint: cleanPreview.preview.stateFingerprint,
      integrationTarget: dirty.integrationTarget,
      branchDisposition: "preserve",
    });
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.blockers.map((blocker) => blocker.kind)).toEqual(
      expect.arrayContaining(["dirty", "state-changed"]),
    );
    expect(existsSync(dirty.planned.canonicalPath)).toBe(true);
  });

  it("rejects identity replacement and a runtime branch-delete request", async () => {
    const identity = await readyForDispose("dispose-identity");
    db.prepare("UPDATE attempts SET status = 'Succeeded' WHERE attempt_id = ?").run(
      identity.attemptId,
    );
    const moved = `${identity.planned.canonicalPath}-moved`;
    const replacement = `${identity.planned.canonicalPath}-replacement`;
    mkdirSync(replacement);
    const { renameSync } = await import("node:fs");
    renameSync(identity.planned.canonicalPath, moved);
    renameSync(replacement, identity.planned.canonicalPath);

    const drifted = await manager.previewDispose({
      worktreeId: identity.planned.worktreeId,
      integrationTarget: identity.integrationTarget,
    });
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) return;
    expect(drifted.preview.blockers.map((blocker) => blocker.kind)).toContain("identity-drift");

    // Restore the registered Worktree so afterEach's Git cleanup remains
    // ordinary, then prove the runtime schema rejects branch deletion.
    rmSync(identity.planned.canonicalPath, { recursive: true, force: true });
    renameSync(moved, identity.planned.canonicalPath);
    const preview = await manager.previewDispose({
      worktreeId: identity.planned.worktreeId,
      integrationTarget: identity.integrationTarget,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.preview.stateFingerprint === null) return;
    const rejected = await manager.dispose({
      commandId: "cmd-dispose-delete-branch" as CommandId,
      worktreeId: identity.planned.worktreeId,
      expectedStateVersion: preview.preview.stateVersion,
      expectedFilesystemIdentity: preview.preview.filesystemIdentity,
      expectedStateFingerprint: preview.preview.stateFingerprint,
      integrationTarget: identity.integrationTarget,
      branchDisposition: "delete" as never,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.blockers.map((blocker) => blocker.kind)).toContain("branch-delete-requested");
    expect(existsSync(identity.planned.canonicalPath)).toBe(true);
  });
});
