// R0-07 — minimal authoritative store for the at-most-once launch probe.
// Real node:sqlite, WAL + synchronous=FULL (RT-STO-06 shape, same convention
// as packages/testing/src/temp-sqlite.ts). Every RT-LAUNCH step that "commits"
// below is one BEGIN IMMEDIATE … COMMIT, so a crash either lands the whole
// step or none of it (RT-T-11: no partial Attempt / binding).

import { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL -- Draft | Runnable
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE, -- one command produces at most one Attempt
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- start | retry | resume
  status TEXT NOT NULL,            -- Attempt lifecycle (RT-STATE-18)
  snapshot_json TEXT NOT NULL,     -- immutable snapshot (RT-LAUNCH-01)
  failure_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_intents (
  launch_nonce TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE, -- at most one intent per Attempt
  command_id TEXT NOT NULL,
  argv_hash TEXT NOT NULL,
  status TEXT NOT NULL,            -- Prepared | Authorized | Aborted (RT-LAUNCH-01..08)
  bootstrap_pid INTEGER,
  bootstrap_pgid INTEGER,
  bootstrap_lstart TEXT,
  commit_sent_at TEXT,             -- NULL while CommitLaunch delivery is unrecorded
  abort_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slot_leases (
  slot_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  availability TEXT NOT NULL,      -- Planned | Alive | Lost (Session Availability)
  agent_pid INTEGER,
  agent_pgid INTEGER,
  agent_lstart TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
  command_id TEXT PRIMARY KEY,     -- RT-CMD-02: payload hash + durable result
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | completed | failed
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS domain_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

export const openLifecycleDb = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  // RT-STO-06 shape: WAL + FULL — a committed step survives SIGKILL of the
  // coordinator; an uncommitted one is fully rolled back.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(SCHEMA_DDL);
  return db;
};

/** Single-statement-style transaction helper: all-or-nothing per step. */
export const withTx = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

// --- row types ---

export interface AttemptRow {
  readonly attempt_id: string;
  readonly command_id: string;
  readonly task_id: string;
  readonly kind: string;
  readonly status: string;
  readonly snapshot_json: string;
  readonly failure_reason: string | null;
  readonly created_at: string;
}

export interface LaunchIntentRow {
  readonly launch_nonce: string;
  readonly attempt_id: string;
  readonly command_id: string;
  readonly argv_hash: string;
  readonly status: string;
  readonly bootstrap_pid: number | null;
  readonly bootstrap_pgid: number | null;
  readonly bootstrap_lstart: string | null;
  readonly commit_sent_at: string | null;
  readonly abort_reason: string | null;
  readonly created_at: string;
}

export interface SlotLeaseRow {
  readonly slot_id: string;
  readonly attempt_id: string;
  readonly released: number;
}

export interface SessionRow {
  readonly session_id: string;
  readonly attempt_id: string;
  readonly availability: string;
  readonly agent_pid: number | null;
  readonly agent_pgid: number | null;
  readonly agent_lstart: string | null;
}

export interface IdempotencyRow {
  readonly command_id: string;
  readonly payload_hash: string;
  readonly status: string;
  readonly result_json: string | null;
}

export interface DomainEventRow {
  readonly seq: number;
  readonly type: string;
  readonly payload_json: string;
}

export interface DbDump {
  readonly tasks: readonly unknown[];
  readonly attempts: readonly AttemptRow[];
  readonly launchIntents: readonly LaunchIntentRow[];
  readonly slotLeases: readonly SlotLeaseRow[];
  readonly sessions: readonly SessionRow[];
  readonly idempotency: readonly IdempotencyRow[];
  readonly domainEvents: readonly DomainEventRow[];
}

export const dumpDb = (db: DatabaseSync): DbDump => ({
  tasks: db.prepare("SELECT * FROM tasks ORDER BY task_id").all() as unknown[],
  attempts: db
    .prepare("SELECT * FROM attempts ORDER BY created_at")
    .all() as unknown as AttemptRow[],
  launchIntents: db
    .prepare("SELECT * FROM launch_intents ORDER BY created_at")
    .all() as unknown as LaunchIntentRow[],
  slotLeases: db
    .prepare("SELECT * FROM slot_leases ORDER BY slot_id")
    .all() as unknown as SlotLeaseRow[],
  sessions: db
    .prepare("SELECT * FROM sessions ORDER BY session_id")
    .all() as unknown as SessionRow[],
  idempotency: db
    .prepare("SELECT * FROM idempotency ORDER BY command_id")
    .all() as unknown as IdempotencyRow[],
  domainEvents: db
    .prepare("SELECT * FROM domain_events ORDER BY seq")
    .all() as unknown as DomainEventRow[],
});
