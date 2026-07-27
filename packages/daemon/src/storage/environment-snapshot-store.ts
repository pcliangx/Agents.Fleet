// RT-ENV-03 / RT-OWN-05 — durable immutable Environment Snapshot binding.
//
// This store is append-only per Attempt. A later scheduler may call it inside
// the outer start/retry/resume transaction; transact() nests via savepoints,
// preserving RT-STO-01 atomic composition.

import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentSnapshot, EnvironmentSnapshotRecord } from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { type Migration, transact } from "./database.js";
import { StoreError } from "./task-store.js";

export const ENVIRONMENT_SNAPSHOT_MIGRATIONS: readonly Migration[] = [
  {
    version: 6,
    name: "attempt-environment-snapshots",
    up: (db) => {
      db.exec(`
        CREATE TABLE attempt_environment_snapshots (
          attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
          snapshot_json TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

interface SnapshotRow {
  readonly snapshot_json: string;
  readonly snapshot_hash: string;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const snapshotHash = canonicalSha256;

const hasValidSnapshotHash = (snapshot: unknown, expectedHash: string): boolean => {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    (snapshot as { readonly snapshotVersion?: unknown }).snapshotVersion !== 1
  ) {
    return false;
  }
  try {
    return snapshotHash(snapshot) === expectedHash;
  } catch {
    return false;
  }
};

export class EnvironmentSnapshotStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  createForAttempt(
    attemptId: string,
    record: EnvironmentSnapshotRecord,
  ): EnvironmentSnapshotRecord {
    if (!hasValidSnapshotHash(record.snapshot, record.hash)) {
      throw new StoreError("DataIntegrityFailure", "Environment Snapshot hash is invalid");
    }
    return transact(
      this.#db,
      () => {
        if (this.getForAttempt(attemptId) !== null) {
          throw new StoreError("Conflict", "Attempt already has an Environment Snapshot");
        }
        const attempt = this.#db
          .prepare("SELECT attempt_id FROM attempts WHERE attempt_id = ?")
          .get(attemptId) as { attempt_id: string } | undefined;
        if (attempt === undefined) throw new StoreError("NotFound", "no such Attempt");
        this.#db
          .prepare(
            `INSERT INTO attempt_environment_snapshots
             (attempt_id, snapshot_json, snapshot_hash, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            attemptId,
            JSON.stringify(record.snapshot),
            record.hash,
            new Date(this.#now()).toISOString(),
          );
        return deepFreeze(structuredClone(record));
      },
      this.#now,
    );
  }

  getForAttempt(attemptId: string): EnvironmentSnapshotRecord | null {
    const row = this.#db
      .prepare(
        "SELECT snapshot_json, snapshot_hash FROM attempt_environment_snapshots WHERE attempt_id = ?",
      )
      .get(attemptId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      throw new StoreError("DataIntegrityFailure", "stored Environment Snapshot is invalid");
    }
    if (!hasValidSnapshotHash(snapshot, row.snapshot_hash)) {
      throw new StoreError("DataIntegrityFailure", "stored Environment Snapshot hash is invalid");
    }
    return deepFreeze({
      snapshot: snapshot as EnvironmentSnapshot,
      hash: row.snapshot_hash,
    });
  }
}
