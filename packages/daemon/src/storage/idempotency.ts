// RT-CMD-02/07 — idempotent command records.
//
// Every mutating command persists its payload hash and result: a replayed
// commandId with the same payload returns the original result (never
// re-executes), the same commandId with a different payload is
// IdempotencyConflict. Records live at least 30 days; records for deleted
// targets are tombstoned and only purged 30 days after the tombstone
// (RT-CMD-07).

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./database.js";
import { StoreError } from "./task-store.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class IdempotencyStore {
  static readonly migrations: readonly Migration[] = [
    {
      version: 2,
      name: "idempotency",
      up: (db) => {
        db.exec(`
          CREATE TABLE command_records (
            command_id TEXT PRIMARY KEY,
            payload_hash TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            tombstoned_at TEXT
          );
        `);
      },
    },
  ];

  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  /** Original result, null when unseen; IdempotencyConflict on hash mismatch. */
  lookup(commandId: string, payloadHash: string): unknown {
    const row = this.#db
      .prepare("SELECT payload_hash, result_json FROM command_records WHERE command_id = ?")
      .get(commandId) as { payload_hash: string; result_json: string } | undefined;
    if (row === undefined) return null;
    if (row.payload_hash !== payloadHash) {
      throw new StoreError(
        "IdempotencyConflict",
        `commandId ${commandId} was used with a different payload`,
      );
    }
    return JSON.parse(row.result_json);
  }

  /** First write wins: a replayed record keeps the original result. */
  record(commandId: string, payloadHash: string, result: unknown): void {
    const existing = this.#db
      .prepare("SELECT payload_hash FROM command_records WHERE command_id = ?")
      .get(commandId) as { payload_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== payloadHash) {
        throw new StoreError(
          "IdempotencyConflict",
          `commandId ${commandId} was used with a different payload`,
        );
      }
      return; // replay: keep the original result
    }
    this.#db
      .prepare(
        "INSERT INTO command_records (command_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(commandId, payloadHash, JSON.stringify(result), new Date(this.#now()).toISOString());
  }

  /** Mark a record's target as deleted; the tombstone itself is kept 30 days. */
  tombstone(commandId: string): void {
    this.#db
      .prepare("UPDATE command_records SET tombstoned_at = ? WHERE command_id = ?")
      .run(new Date(this.#now()).toISOString(), commandId);
  }

  /** Purge tombstones older than the 30-day retention; live records stay. */
  purgeExpired(): void {
    const cutoff = new Date(this.#now() - RETENTION_MS).toISOString();
    this.#db
      .prepare("DELETE FROM command_records WHERE tombstoned_at IS NOT NULL AND tombstoned_at < ?")
      .run(cutoff);
  }
}
