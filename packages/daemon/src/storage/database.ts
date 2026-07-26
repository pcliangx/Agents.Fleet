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
//   the newest 3 (RT-STO-07);
// - RT-STO-07 rolling backups: committed transactions bump a meta change
//   counter, and maybeRollBackup creates a verified backup once changes are
//   at least 24h old — again keeping the newest 3;
// - restoreFromBackup is the user-confirmed recovery path: the backup is
//   integrity-verified first and the corrupt sample is moved aside, never
//   overwritten (RT-STO-06).

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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
  return rows[0]?.integrity_check === "ok";
};

const applyPragmas = (db: DatabaseSync): void => {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  // Node 24.14+ defaults defensive=ON; pin it explicitly so a future Node
  // default change can never silently weaken the posture (SV1-SUPPLY / RT-STO-06).
  db.exec("PRAGMA defensive = ON");
};

/**
 * RT-STO-01 / RT-INV-07 — the atomic unit of lifecycle work: state changes,
 * idempotency results and domain events commit together or not at all.
 * Re-entrant: the outermost call runs BEGIN IMMEDIATE / COMMIT / ROLLBACK,
 * nested calls (a store method inside a composed command transaction) run as
 * SAVEPOINTs, so RT-STO-01's "one transaction" holds for composed commands.
 *
 * Each outermost commit also bumps the meta change counter that drives the
 * RT-STO-07 rolling 24h backup (maybeRollBackup below).
 */
const txDepth = new WeakMap<DatabaseSync, number>();

export const transact = <T>(db: DatabaseSync, fn: () => T, now: () => number = Date.now): T => {
  const depth = txDepth.get(db) ?? 0;
  if (depth === 0) {
    db.exec("BEGIN IMMEDIATE");
  } else {
    db.exec(`SAVEPOINT af_sp_${depth}`);
  }
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    txDepth.set(db, depth);
    if (depth === 0) {
      // Bump the RT-STO-07 change counter BEFORE COMMIT so a crash between the
      // bump and the commit can never under-count: an aborted commit rolls the
      // bump back with it, a successful commit carries both atomically.
      db.prepare(
        "UPDATE _meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'change_seq'",
      ).run();
      db.prepare("UPDATE _meta SET value = ? WHERE key = 'last_change_at'").run(String(now()));
      db.exec("COMMIT");
    } else {
      db.exec(`RELEASE SAVEPOINT af_sp_${depth}`);
    }
    return result;
  } catch (e) {
    txDepth.set(db, depth);
    if (depth === 0) {
      db.exec("ROLLBACK");
    } else {
      db.exec(`ROLLBACK TO SAVEPOINT af_sp_${depth}`);
      db.exec(`RELEASE SAVEPOINT af_sp_${depth}`);
    }
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
  // Meta table for the RT-STO-07 rolling-backup bookkeeping. Idempotent by
  // design; schema history lives in user_version migrations, not here.
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const key of ["change_seq", "backup_change_seq", "last_backup_at", "last_change_at"]) {
    db.prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES (?, '0')").run(key);
  }
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

const metaValue = (db: DatabaseSync, key: string): number => {
  const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row === undefined ? 0 : Number(row.value);
};

export interface RollBackupOptions {
  readonly backupDir?: string;
  readonly now?: () => number;
  /** Rolling interval; RT-STO-07 freezes it at 24h. */
  readonly intervalMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * RT-STO-07 — create a verified rolling backup when the database changed and
 * the last backup is at least 24h old; keep the newest 3. Returns the backup
 * path, or null when nothing is due.
 */
export const maybeRollBackup = (
  db: DatabaseSync,
  path: string,
  options: RollBackupOptions = {},
): string | null => {
  const backupDir = options.backupDir ?? join(path, "..", "backups");
  const now = options.now ?? (() => Date.now());
  const interval = options.intervalMs ?? DAY_MS;

  const changeSeq = metaValue(db, "change_seq");
  const backedUpSeq = metaValue(db, "backup_change_seq");
  const lastBackupAt = metaValue(db, "last_backup_at");
  if (changeSeq <= backedUpSeq) return null; // nothing changed since the last backup
  // the interval runs from the last backup, or from the first recorded change
  const baseline = lastBackupAt > 0 ? lastBackupAt : metaValue(db, "last_change_at");
  if (now() - baseline < interval) return null;

  const target = verifiedBackup(db, path, backupDir, now());
  pruneBackups(backupDir, 3);
  db.prepare("UPDATE _meta SET value = ? WHERE key = 'backup_change_seq'").run(String(changeSeq));
  db.prepare("UPDATE _meta SET value = ? WHERE key = 'last_backup_at'").run(String(now()));
  return target;
};

/**
 * RT-STO-06 — user-confirmed restore from a verified backup. The backup must
 * pass an integrity check first; the corrupt sample is moved aside (never
 * overwritten), then the backup takes the original's place.
 */
export const restoreFromBackup = (corruptPath: string, backupPath: string): void => {
  const check = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (!integrityOk(check)) {
      throw new Error(`restore refused: backup failed integrity check: ${backupPath}`);
    }
  } finally {
    check.close();
  }
  const stamp = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    const live = `${corruptPath}${suffix}`;
    if (existsSync(live)) {
      renameSync(live, `${corruptPath}.corrupt-${stamp}${suffix}`);
    }
  }
  copyFileSync(backupPath, corruptPath);
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
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
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
    // RT-STO-07 driver: on open, roll a backup if one is due (changes since the
    // last backup + >= 24h elapsed). Per-commit rolling stays the daemon
    // scheduler's job; this covers the reopen-after-24h case so a long-lived
    // database never silently exceeds the 24h budget between reopens.
    const rollingBackup = maybeRollBackup(db, path, { backupDir, now });
    const allBackups = rollingBackup === null ? backupsCreated : [...backupsCreated, rollingBackup];
    return { kind: "ready", db, backupsCreated: allBackups };
  } catch (e) {
    try {
      db.close();
    } catch {
      // already closed
    }
    return recovery(path, `integrity: ${(e as Error).message}`);
  }
};
