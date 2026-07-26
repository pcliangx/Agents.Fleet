// RT-STO-05/06/07 — Fleet lifecycle database layer.
//
// SQLite is the single authority for lifecycle state, idempotent command
// results and domain events (ADR-0005). This module owns the durability
// posture and the failure modes:
//
// - WAL + synchronous=FULL on every handle (RT-STO-06);
// - integrity check on open and after every migration; on failure the
//   database opens ReadOnlyRecovery — the corrupt original is preserved
//   untouched, nothing is writable, and only a user-confirmed restore from a
//   verified backup can bring it back (RT-STO-06, RT-STATE-27);
// - every migration runs inside one transaction (DDL included), preceded by a
//   verified backup (checkpoint → copy → reopen → integrity check), rolling
//   the newest 3 (RT-STO-07).

import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly migrations: readonly Migration[];
  /** Defaults to `<dir of path>/backups`. */
  readonly backupDir?: string;
  readonly now?: () => number;
}

export type OpenDatabaseResult =
  | {
      readonly kind: "ready";
      readonly db: DatabaseSync;
      readonly backupsCreated: readonly string[];
    }
  | {
      readonly kind: "read-only-recovery";
      readonly reason: string;
      readonly db: DatabaseSync | null;
    };

const integrityOk = (db: DatabaseSync): boolean => {
  const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  return rows.length > 0 && rows[0]?.integrity_check === "ok";
};

const applyPragmas = (db: DatabaseSync): void => {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
};

/**
 * RT-STO-01 / RT-INV-07 — the atomic unit of lifecycle work: state changes,
 * idempotency results and domain events commit together or not at all. Every
 * store mutation and every composed command goes through this. Not
 * re-entrant: compose multi-store operations at the outermost command
 * boundary (SQLite rejects a nested BEGIN).
 */
export const transact = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};

const schemaVersion = (db: DatabaseSync): number => {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
};

const openWritable = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  applyPragmas(db);
  return db;
};

const openReadonly = (path: string): DatabaseSync | null => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
};

const recovery = (path: string, reason: string): OpenDatabaseResult => ({
  kind: "read-only-recovery",
  reason,
  db: openReadonly(path),
});

/** Checkpoint + copy + reopen + integrity check. Throws on any failure. */
const verifiedBackup = (
  db: DatabaseSync,
  path: string,
  backupDir: string,
  stamp: number,
): string => {
  mkdirSync(backupDir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const target = join(backupDir, `${String(stamp)}.db`);
  copyFileSync(path, target);
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    if (!integrityOk(check)) throw new Error(`backup integrity check failed: ${target}`);
  } finally {
    check.close();
  }
  return target;
};

/** Keep only the newest `keep` backups (RT-STO-07). */
const pruneBackups = (backupDir: string, keep: number): void => {
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith(".db"))
    .sort();
  for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, stale), { force: true });
  }
};

const migrate = (db: DatabaseSync, migrations: readonly Migration[], fromVersion: number): void => {
  for (const m of migrations.filter((x) => x.version > fromVersion)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
};

export const openDatabase = (options: OpenDatabaseOptions): OpenDatabaseResult => {
  const { path, migrations } = options;
  const backupDir = options.backupDir ?? join(path, "..", "backups");
  const now = options.now ?? (() => Date.now());
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  let db: DatabaseSync;
  try {
    db = openWritable(path);
  } catch (e) {
    return recovery(path, `integrity: cannot open database: ${(e as Error).message}`);
  }

  try {
    if (!integrityOk(db)) {
      db.close();
      return recovery(path, "integrity: integrity_check failed on open");
    }

    const fromVersion = schemaVersion(db);
    const backupsCreated: string[] = [];
    if (sorted.some((m) => m.version > fromVersion)) {
      backupsCreated.push(verifiedBackup(db, path, backupDir, now()));
      pruneBackups(backupDir, 3);
      try {
        migrate(db, sorted, fromVersion);
      } catch (e) {
        db.close();
        return recovery(path, `integrity: migration failed: ${(e as Error).message}`);
      }
      if (!integrityOk(db)) {
        db.close();
        return recovery(path, "integrity: integrity_check failed after migration");
      }
    }
    return { kind: "ready", db, backupsCreated };
  } catch (e) {
    try {
      db.close();
    } catch {
      // already closed
    }
    return recovery(path, `integrity: ${(e as Error).message}`);
  }
};
