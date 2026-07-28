// R1-05 — scheduler / launch / Session Runtime durable state.
//
// SQLite remains the lifecycle authority (ADR-0005). A scheduler claim writes
// the Host + Agent slot lease, Queued -> Starting transition, planned Session
// identity and Prepared LaunchIntent in one transaction (RT-SCHED-03,
// RT-LAUNCH-01). The actual Session row is created only after an Agent owner
// has been observed (RT-STATE-11).

import type { Migration } from "./database.js";

export const SESSION_RUNTIME_MIGRATIONS: readonly Migration[] = [
  {
    version: 8,
    name: "session-runtime-launch",
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE sessions ADD COLUMN process_pid INTEGER;
        ALTER TABLE sessions ADD COLUMN process_pgid INTEGER;
        ALTER TABLE sessions ADD COLUMN process_started_at TEXT;
        ALTER TABLE sessions ADD COLUMN process_command TEXT;
        ALTER TABLE sessions ADD COLUMN exit_code INTEGER;
        ALTER TABLE attempts ADD COLUMN waiting_reason TEXT;
        ALTER TABLE attempts ADD COLUMN resume_status TEXT;

        CREATE TABLE slot_leases (
          slot_lease_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
          host_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE UNIQUE INDEX idx_slot_leases_active_host
          ON slot_leases(host_id) WHERE released_at IS NULL;
        CREATE UNIQUE INDEX idx_slot_leases_active_agent
          ON slot_leases(agent_id) WHERE released_at IS NULL;

        CREATE TABLE launch_intents (
          launch_nonce TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
          command_id TEXT NOT NULL UNIQUE,
          slot_lease_id TEXT NOT NULL UNIQUE REFERENCES slot_leases(slot_lease_id),
          planned_session_id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
          argv_hash TEXT NOT NULL,
          launch_spec_json TEXT NOT NULL,
          launch_spec_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Prepared','Authorized','Aborted')),
          bootstrap_pid INTEGER,
          bootstrap_pgid INTEGER,
          bootstrap_started_at TEXT,
          commit_sent_at TEXT,
          abort_reason TEXT,
          result_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_launch_intents_status
          ON launch_intents(status, created_at);

        CREATE TABLE chunks (
          session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          chunk_path TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          PRIMARY KEY (session_id, generation, seq)
        );
        CREATE TABLE stream_cursors (
          session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          durable_seq INTEGER NOT NULL,
          PRIMARY KEY (session_id, generation)
        );
      `);
    },
  },
  {
    version: 9,
    name: "session-attachments",
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN fencing_counter INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN terminal_cols INTEGER NOT NULL DEFAULT 80;
        ALTER TABLE sessions ADD COLUMN terminal_rows INTEGER NOT NULL DEFAULT 24;

        CREATE TABLE attachments (
          attachment_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          generation INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Active','Closed','Invalidated')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_attachments_session_status
          ON attachments(session_id, status);

        CREATE TABLE control_leases (
          session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
          generation INTEGER NOT NULL,
          attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(attachment_id),
          fencing_token INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          granted_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL
        );

        CREATE TABLE input_intents (
          input_intent_id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          generation INTEGER NOT NULL,
          attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
          fencing_token INTEGER NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('Keyboard','IME','Paste','Mouse','Automation')),
          content_ref TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          redacted_preview TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Prepared','Dispatched','Uncertain')),
          data_gap INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          dispatched_at TEXT
        );

        CREATE TABLE session_snapshots (
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          generation INTEGER NOT NULL,
          covers_through_seq INTEGER NOT NULL,
          content_ref TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          package_set_json TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          truncated_before_seq INTEGER,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, generation)
        );
      `);
    },
  },
  {
    version: 13,
    name: "attempt-primary-outcome",
    up: (db) => {
      db.exec(`
        ALTER TABLE attempts ADD COLUMN primary_outcome TEXT
          CHECK (primary_outcome IN ('Succeeded','Failed','Uncertain'));
        ALTER TABLE attempts ADD COLUMN primary_exit_code INTEGER;
        ALTER TABLE attempts ADD COLUMN primary_exit_signal INTEGER;
      `);
    },
  },
];
