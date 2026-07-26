// RT-CMD-02/07 — idempotent command records.
//
// Every mutating command persists its payload hash and result: a replayed
// commandId with the same payload returns the original result (never
// re-executes), the same commandId with a different payload is
// IdempotencyConflict. Records live at least 30 days; records for deleted
// targets are tombstoned and only purged 30 days after the tombstone
// (RT-CMD-07).

import type { DatabaseSync } from "node:sqlite";
import { hashPreviewFact } from "../confirmation/challenge-issuer.js";
import type { Migration } from "./database.js";
import { transact } from "./database.js";
import { StoreError } from "./task-store.js";

/** Canonical hash of a command payload (RT-CMD-01/02 — same canonicalization as confirmation facts). */
export const hashCommandPayload = (payload: unknown): string => hashPreviewFact(payload);

/**
 * RT-T-04 / RT-CMD-02/03 — run a mutating command idempotently: a replayed
 * commandId with the same payload returns the ORIGINAL result without
 * re-executing; the same commandId with a different payload is
 * IdempotencyConflict. State writes, the idempotency record and domain
 * events commit in one transaction (RT-STO-01).
 */
export const executeIdempotent = <T>(
  db: DatabaseSync,
  idem: IdempotencyStore,
  command: {
    readonly commandId: string;
    readonly payload: unknown;
    readonly target: { readonly type: string; readonly id: string };
  },
  fn: () => T,
): T =>
  transact(db, () => {
    const payloadHash = hashCommandPayload(command.payload);
    const hit = idem.lookup(command.commandId, payloadHash);
    if (hit !== null) return hit as T;
    const result = fn();
    idem.record(command.commandId, payloadHash, result, command.target);
    return result;
  });

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
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            tombstoned_at TEXT
          );
          CREATE INDEX idx_command_records_target ON command_records(target_type, target_id);
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

  #storedHash(commandId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT payload_hash FROM command_records WHERE command_id = ?")
      .get(commandId) as { payload_hash: string } | undefined;
    return row?.payload_hash;
  }

  #assertSamePayload(commandId: string, storedHash: string, payloadHash: string): void {
    if (storedHash !== payloadHash) {
      throw new StoreError(
        "IdempotencyConflict",
        `commandId ${commandId} was used with a different payload`,
      );
    }
  }

  /** Original result, null when unseen; IdempotencyConflict on hash mismatch. */
  lookup(commandId: string, payloadHash: string): unknown {
    const row = this.#db
      .prepare("SELECT payload_hash, result_json FROM command_records WHERE command_id = ?")
      .get(commandId) as { payload_hash: string; result_json: string } | undefined;
    if (row === undefined) return null;
    this.#assertSamePayload(commandId, row.payload_hash, payloadHash);
    return JSON.parse(row.result_json);
  }

  /** First write wins: a replayed record keeps the original result. */
  record(
    commandId: string,
    payloadHash: string,
    result: unknown,
    target: { readonly type: string; readonly id: string },
  ): void {
    const stored = this.#storedHash(commandId);
    if (stored !== undefined) {
      this.#assertSamePayload(commandId, stored, payloadHash);
      return; // replay: keep the original result
    }
    this.#db
      .prepare(
        "INSERT INTO command_records (command_id, payload_hash, result_json, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        commandId,
        payloadHash,
        JSON.stringify(result),
        target.type,
        target.id,
        new Date(this.#now()).toISOString(),
      );
  }

  /** Mark one record's target as deleted; the tombstone itself is kept 30 days. */
  tombstone(commandId: string): void {
    this.#db
      .prepare("UPDATE command_records SET tombstoned_at = ? WHERE command_id = ?")
      .run(new Date(this.#now()).toISOString(), commandId);
  }

  /** RT-CMD-07 — tombstone every record bound to a deleted target; the records
   * themselves are kept 30 days for replay audit. Backed by
   * idx_command_records_target so it stays cheap as the table grows. */
  tombstoneByTarget(targetType: string, targetId: string): void {
    this.#db
      .prepare(
        "UPDATE command_records SET tombstoned_at = ? WHERE target_type = ? AND target_id = ? AND tombstoned_at IS NULL",
      )
      .run(new Date(this.#now()).toISOString(), targetType, targetId);
  }

  /** Purge tombstones older than the 30-day retention; live records stay. */
  purgeExpired(): void {
    const cutoff = new Date(this.#now() - RETENTION_MS).toISOString();
    this.#db
      .prepare("DELETE FROM command_records WHERE tombstoned_at IS NOT NULL AND tombstoned_at < ?")
      .run(cutoff);
  }
}
