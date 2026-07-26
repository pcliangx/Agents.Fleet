// S1 — Fleet database layer (RT-STO-05/06/07): WAL + FULL durability,
// startup integrity check, backup-before-migration, ReadOnlyRecovery on
// integrity/migration failure. Real temp SQLite files, no mocks.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Migration, openDatabase } from "../storage/database.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const tempRoot = (): string => {
  dir = mkdtempSync(join(tmpdir(), "af-r101-db-"));
  return dir;
};

const pragma = (db: import("node:sqlite").DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "tasks",
    up: (db) => {
      db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    },
  },
  {
    version: 2,
    name: "tasks-goal",
    up: (db) => {
      db.exec("ALTER TABLE tasks ADD COLUMN goal TEXT");
    },
  },
];

describe("openDatabase (RT-STO-06)", () => {
  it("creates a fresh database in WAL + synchronous=FULL and applies migrations", () => {
    const result = openDatabase({ path: join(tempRoot(), "fleet.db"), migrations: MIGRATIONS });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(pragma(result.db, "journal_mode")).toBe("wal");
    expect(pragma(result.db, "synchronous")).toBe(2); // FULL
    expect(pragma(result.db, "user_version")).toBe(2);
    result.db.close();
  });

  it("persists across reopen and does not re-apply migrations", () => {
    const path = join(tempRoot(), "fleet.db");
    const first = openDatabase({ path, migrations: MIGRATIONS });
    if (first.kind !== "ready") throw new Error("expected ready");
    first.db.exec("INSERT INTO tasks (id, created_at, goal) VALUES ('t1', 'now', 'g')");
    first.db.close();
    const second = openDatabase({ path, migrations: MIGRATIONS });
    expect(second.kind).toBe("ready");
    if (second.kind !== "ready") return;
    const row = second.db.prepare("SELECT goal FROM tasks WHERE id = 't1'").get() as {
      goal: string;
    };
    expect(row.goal).toBe("g");
    second.db.close();
  });

  it("writes a verified backup before migrating an older database (RT-STO-07)", () => {
    const root = tempRoot();
    const path = join(root, "fleet.db");
    const first = openDatabase({ path, migrations: MIGRATIONS.slice(0, 1) });
    if (first.kind !== "ready") throw new Error("expected ready");
    first.db.exec("INSERT INTO tasks (id, created_at) VALUES ('t1', 'now')");
    first.db.close();

    const backups = join(root, "backups");
    const second = openDatabase({ path, migrations: MIGRATIONS, backupDir: backups });
    if (second.kind !== "ready") throw new Error("expected ready");
    // a verified (openable, integrity-checked) backup of the v1 database exists
    expect(second.backupsCreated).toHaveLength(1);
    const backup = openDatabase({
      path: second.backupsCreated[0] ?? "",
      migrations: MIGRATIONS.slice(0, 1),
    });
    expect(backup.kind).toBe("ready");
    if (backup.kind === "ready") {
      expect((backup.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(
        1,
      );
      backup.db.close();
    }
  });

  it("a corrupt database opens read-only-recovery, never writable (RT-STO-06)", () => {
    const path = join(tempRoot(), "fleet.db");
    writeFileSync(path, Buffer.from("this is not a sqlite database at all".repeat(64)));
    const result = openDatabase({ path, migrations: MIGRATIONS });
    expect(result.kind).toBe("read-only-recovery");
    if (result.kind !== "read-only-recovery") return;
    expect(result.reason).toContain("integrity");
  });

  it("a failing migration preserves the original and enters recovery (RT-STO-05)", () => {
    const path = join(tempRoot(), "fleet.db");
    const first = openDatabase({ path, migrations: MIGRATIONS.slice(0, 1) });
    if (first.kind !== "ready") throw new Error("expected ready");
    first.db.close();

    const broken: Migration = {
      version: 2,
      name: "broken",
      up: (db) => {
        db.exec("ALTER TABLE tasks ADD COLUMN x TEXT");
        throw new Error("injected migration failure");
      },
    };
    const result = openDatabase({ path, migrations: [...MIGRATIONS.slice(0, 1), broken] });
    expect(result.kind).toBe("read-only-recovery");
    // the original v1 database is untouched and still opens cleanly
    const again = openDatabase({ path, migrations: MIGRATIONS.slice(0, 1) });
    expect(again.kind).toBe("ready");
    if (again.kind === "ready") {
      expect(pragma(again.db, "user_version")).toBe(1);
      again.db.close();
    }
  });
});
