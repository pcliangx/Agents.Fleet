import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHostEnvironment } from "../host-environment/host-environment.js";
import { openDatabase } from "./database.js";
import { EnvironmentSnapshotStore } from "./environment-snapshot-store.js";
import { ALL_MIGRATIONS } from "./migrations.js";
import { TaskStore } from "./task-store.js";

let root = "";
let database: DatabaseSync | null = null;

afterEach(() => {
  database?.close();
  database = null;
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("EnvironmentSnapshotStore (RT-ENV-03 / RT-OWN-05)", () => {
  it("durably binds one immutable, hash-verified Environment Snapshot to an Attempt", async () => {
    root = mkdtempSync(join(tmpdir(), "af-r103-env-store-"));
    const dbPath = join(root, "fleet.db");
    const opened = openDatabase({ path: dbPath, migrations: ALL_MIGRATIONS });
    if (opened.kind !== "ready") throw new Error("database not ready");
    database = opened.db;
    const tasks = new TaskStore(opened.db);
    const task = tasks.createTask({
      workspaceId: "workspace-1",
      spec: { goal: "persist an Environment Snapshot" },
    });
    tasks.startTask(task.taskId);
    const attempt = tasks.listAttempts(task.taskId)[0];
    if (attempt === undefined) throw new Error("attempt not created");

    const repositoryRoot = join(root, "repository");
    const installRoot = join(root, "install");
    mkdirSync(repositoryRoot);
    mkdirSync(installRoot);
    const executablePath = join(installRoot, "claude");
    writeFileSync(executablePath, "#!/bin/sh\nprintf '2.1.218 (Claude Code)\\n'\n", {
      mode: 0o700,
    });
    chmodSync(executablePath, 0o700);
    const host = new LocalHostEnvironment({
      appDataRoot: join(root, "app-data"),
      explicitPathEntries: ["/usr/bin", "/bin"],
      inheritedEnvironment: { HOME: join(root, "home"), LANG: "C.UTF-8" },
      now: () => 1_800_000_000_000,
    });
    const candidate = await host.discoverCandidate(executablePath);
    const probe = await host.probe({
      authorization: {
        trustId: "trust-1",
        trustVersion: 1,
        state: "Active",
        repositoryRoot,
        repositoryIdentity: "repository-1",
      },
      candidate,
      versionArguments: ["--version"],
    });
    const record = host.createSnapshot({
      probe,
      cliVersion: "2.1.218",
      launchArguments: ["--permission-mode", "acceptEdits"],
      worktreeTarget: {
        kind: "Planned",
        worktreeId: "worktree-1" as never,
        canonicalPath: join(root, "worktrees", "task-1"),
        repositoryIdentity: "repository-1",
        branchStrategy: {
          kind: "create",
          branchName: "fleet/task-1",
          onCollision: "fail",
        },
      },
      secretReferenceIdentities: ["keychain:sha256:reference-only"],
    });

    const store = new EnvironmentSnapshotStore(opened.db);
    expect(store.createForAttempt(attempt.attemptId, record)).toEqual(record);
    const restored = store.getForAttempt(attempt.attemptId);
    expect(restored).toEqual(record);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored?.snapshot)).toBe(true);
    expect(() => store.createForAttempt(attempt.attemptId, record)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    expect(() =>
      store.createForAttempt("missing-attempt", {
        snapshot: record.snapshot,
        hash: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrowError(expect.objectContaining({ code: "DataIntegrityFailure" }));

    opened.db
      .prepare("UPDATE attempt_environment_snapshots SET snapshot_json = ? WHERE attempt_id = ?")
      .run('{"snapshotVersion":1,"tampered":true}', attempt.attemptId);
    expect(() => store.getForAttempt(attempt.attemptId)).toThrowError(
      expect.objectContaining({ code: "DataIntegrityFailure" }),
    );
  });
});
