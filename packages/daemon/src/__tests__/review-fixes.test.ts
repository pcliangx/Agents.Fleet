// Review-fix tests — command-level idempotency (RT-T-04, RT-CMD-02/03) and
// RT-STO-07 rolling 24h backup + verified restore (RT-STO-06).

import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, restoreFromBackup, rollBackupIfDue } from "../storage/database.js";
import { executeIdempotent, IdempotencyStore } from "../storage/idempotency.js";
import { TASK_MIGRATIONS, TaskStore } from "../storage/task-store.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const ALL_MIGRATIONS = [...TASK_MIGRATIONS, ...IdempotencyStore.migrations];

const makeDb = () => {
  dir = mkdtempSync(join(tmpdir(), "af-r101-review-"));
  const result = openDatabase({ path: join(dir, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (result.kind !== "ready") throw new Error("db not ready");
  return result;
};

describe("executeIdempotent (RT-T-04 / RT-CMD-03)", () => {
  it("a replayed command returns the original result without re-executing", () => {
    const { db } = makeDb();
    const idem = new IdempotencyStore(db);
    const tasks = new TaskStore(db);
    const fn = vi.fn(() => tasks.startTask(taskId));
    const taskId = tasks.createTask({ workspaceId: "ws1", spec: { goal: "g" } }).taskId;

    const first = executeIdempotent(db, idem, { commandId: "cmd_1", payload: { taskId } }, fn);
    const second = executeIdempotent(db, idem, { commandId: "cmd_1", payload: { taskId } }, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(tasks.listAttempts(taskId)).toHaveLength(1);
    db.close();
  });

  it("the same commandId with a different payload is IdempotencyConflict and runs nothing", () => {
    const { db } = makeDb();
    const idem = new IdempotencyStore(db);
    const tasks = new TaskStore(db);
    const taskId = tasks.createTask({ workspaceId: "ws1", spec: { goal: "g" } }).taskId;
    const fn = vi.fn(() => tasks.startTask(taskId));

    executeIdempotent(db, idem, { commandId: "cmd_1", payload: { taskId } }, fn);
    expect(() =>
      executeIdempotent(db, idem, { commandId: "cmd_1", payload: { taskId: "other" } }, fn),
    ).toThrowError(expect.objectContaining({ code: "IdempotencyConflict" }));
    expect(fn).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe("rollBackupIfDue (RT-STO-07)", () => {
  it("no backup before 24h, one verified backup after, newest 3 kept", () => {
    const root = mkdtempSync(join(tmpdir(), "af-r101-roll-"));
    dir = root;
    const path = join(root, "fleet.db");
    const backups = join(root, "backups");
    const opened = openDatabase({ path, migrations: TASK_MIGRATIONS });
    if (opened.kind !== "ready") throw new Error("db not ready");
    const db = opened.db;
    let now = T0;
    const tasks = new TaskStore(db, () => now);
    // a change happened (transaction committed) — but the interval has not passed
    tasks.createTask({ workspaceId: "ws1", spec: { goal: "g" } });
    expect(rollBackupIfDue(db, path, { backupDir: backups, now: () => now })).toBeNull();

    now = T0 + 25 * HOUR;
    const first = rollBackupIfDue(db, path, { backupDir: backups, now: () => now });
    expect(first).not.toBeNull();
    // the backup is a verified, openable copy
    const check = openDatabase({ path: first as string, migrations: TASK_MIGRATIONS });
    expect(check.kind).toBe("ready");
    if (check.kind === "ready") check.db.close();

    // no new backup until the next interval — even with further changes
    tasks.createTask({ workspaceId: "ws1", spec: { goal: "g2" } });
    expect(rollBackupIfDue(db, path, { backupDir: backups, now: () => now })).toBeNull();

    // four more intervals → only the newest 3 survive
    for (let i = 1; i <= 4; i++) {
      now = T0 + (25 + i * 24) * HOUR;
      tasks.createTask({ workspaceId: "ws1", spec: { goal: `g${i + 2}` } });
      expect(rollBackupIfDue(db, path, { backupDir: backups, now: () => now })).not.toBeNull();
    }
    expect(readdirSync(backups).filter((f) => f.endsWith(".db"))).toHaveLength(3);
    db.close();
  });
});

describe("restoreFromBackup (RT-STO-06)", () => {
  it("a corrupt original is preserved aside and the verified backup takes over", () => {
    const root = mkdtempSync(join(tmpdir(), "af-r101-restore-"));
    dir = root;
    const path = join(root, "fleet.db");
    const opened = openDatabase({ path, migrations: TASK_MIGRATIONS });
    if (opened.kind !== "ready") throw new Error("db not ready");
    opened.db
      .prepare(
        "INSERT INTO tasks (task_id, workspace_id, lifecycle, spec_json, task_spec_version, created_at, updated_at) VALUES ('t1', 'ws1', 'Draft', '{}', 1, 'now', 'now')",
      )
      .run();
    opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    opened.db.close();
    const backupPath = join(root, "good-backup.db");
    copyFileSync(path, backupPath);

    // corrupt the live file
    writeFileSync(path, "garbage".repeat(256));
    const corrupt = openDatabase({ path, migrations: TASK_MIGRATIONS });
    expect(corrupt.kind).toBe("read-only-recovery");

    restoreFromBackup(path, backupPath);
    // the corrupt sample is preserved, never overwritten
    expect(readdirSync(root).some((f) => f.startsWith("fleet.db.corrupt-"))).toBe(true);
    const restored = openDatabase({ path, migrations: TASK_MIGRATIONS });
    expect(restored.kind).toBe("ready");
    if (restored.kind === "ready") {
      expect(restored.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
      restored.db.close();
    }
  });

  it("the read-only-recovery handle refuses writes (RT-STO-06)", () => {
    const root = mkdtempSync(join(tmpdir(), "af-r101-ro-"));
    dir = root;
    const path = join(root, "fleet.db");
    writeFileSync(path, "garbage".repeat(256));
    const result = openDatabase({ path, migrations: TASK_MIGRATIONS });
    expect(result.kind).toBe("read-only-recovery");
    if (result.kind === "read-only-recovery" && result.db !== null) {
      expect(() => result.db?.exec("CREATE TABLE x (id INTEGER)")).toThrow();
      result.db.close();
    }
  });
});
