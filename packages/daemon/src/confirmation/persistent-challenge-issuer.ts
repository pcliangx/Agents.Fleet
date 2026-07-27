// RT-REPO-06 / RT-CMD-16/17/18 — SQLite-backed confirmation challenge issuer.
//
// Same issue / getChallenge / consume semantics as the R0 in-memory
// ChallengeIssuer (challenge-issuer.ts), but every challenge is a row: the
// one-time consume and replay protection survive a Daemon restart — a new
// issuer instance on the same database file still refuses a consumed,
// expired, drifted, cross-kind or badly-signed receipt (fail closed; every
// failure maps to `ConfirmationRequired` upstream, RT-CMD-06/08/16).
//
// The consume mark is a conditional UPDATE (WHERE consumed_at IS NULL), so
// when it runs inside a caller's command transaction (RT-STO-01) a later
// failure rolls the mark back together with every other write — a challenge
// is burned exactly when the command it authorizes commits.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChallengeDisplay,
  ConfirmationChallenge,
  ConfirmationKind,
  ConfirmationReceipt,
  ConsumeResult,
} from "@agents-fleet/contracts";
import type { Migration } from "../storage/database.js";
import {
  assertChallengeDisplayBounded,
  type ChallengePreview,
  challengeDescriptor,
  hashPreviewFact,
  type IssuerOptions,
} from "./challenge-issuer.js";
import { validateConsume } from "./consume-validation.js";

export interface PersistentIssuerOptions extends IssuerOptions {
  readonly db: DatabaseSync;
}

// Consumed challenges are retained 30 days as replay evidence — the same
// retention discipline as idempotency tombstones (RT-CMD-07).
const CONSUMED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface ChallengeRow {
  readonly challenge_id: string;
  readonly kind: ConfirmationKind;
  /** Absent on a readable pre-v12 database opened in recovery mode. */
  readonly descriptor_json?: string;
  readonly display_json: string;
  readonly payload_hash: string;
  readonly binding_hashes_json: string;
  readonly impact_summary_hash: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

const toChallenge = (row: ChallengeRow): ConfirmationChallenge => ({
  challengeId: row.challenge_id,
  kind: row.kind,
  ...(JSON.parse(row.descriptor_json ?? "{}") as Pick<
    ConfirmationChallenge,
    "commandType" | "sideEffectClass" | "targetIdentities" | "expectedStateVersions"
  >),
  display: JSON.parse(row.display_json) as ChallengeDisplay,
  payloadHash: row.payload_hash,
  bindingHashes: JSON.parse(row.binding_hashes_json) as string[],
  impactSummaryHash: row.impact_summary_hash,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
});

export class PersistentChallengeIssuer {
  static readonly migrations: readonly Migration[] = [
    {
      version: 4,
      name: "confirmation-challenges",
      up: (db) => {
        db.exec(`
          CREATE TABLE confirmation_challenges (
            challenge_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('repository-trust','launch','side-effect')),
            display_json TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            binding_hashes_json TEXT NOT NULL,
            impact_summary_hash TEXT NOT NULL,
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
          );
        `);
      },
    },
    {
      version: 12,
      name: "confirmation-challenge-descriptor",
      up: (db) => {
        db.exec(
          "ALTER TABLE confirmation_challenges ADD COLUMN descriptor_json TEXT NOT NULL DEFAULT '{}'",
        );
      },
    },
  ];

  readonly #db: DatabaseSync;
  readonly #token: Uint8Array;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxOpen: number;

  constructor(options: PersistentIssuerOptions) {
    this.#db = options.db;
    this.#token = options.token;
    this.#ttlMs = options.ttlMs ?? 300_000;
    this.#now = options.now ?? (() => Date.now());
    this.#maxOpen = options.maxOpen ?? 64;
  }

  // RT-LIMIT-02 — bounded history retention, applied on each issue:
  // - expired-and-unconsumed rows are dead weight: consume fails closed on
  //     them ("expired"), so they are purged outright;
  // - consumed rows are kept 30 days as replay evidence, mirroring the
  //   idempotency tombstone retention discipline (RT-CMD-07), then purged.
  // maxOpen keeps its semantics: only unconsumed AND unexpired rows count as
  // open challenges.
  #purgeHistory(): void {
    const nowIso = new Date(this.#now()).toISOString();
    const consumedCutoff = new Date(this.#now() - CONSUMED_RETENTION_MS).toISOString();
    this.#db
      .prepare(
        `DELETE FROM confirmation_challenges
         WHERE (consumed_at IS NULL AND expires_at <= ?)
            OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
      )
      .run(nowIso, consumedCutoff);
  }

  #row(challengeId: string): ChallengeRow | undefined {
    return this.#db
      .prepare("SELECT * FROM confirmation_challenges WHERE challenge_id = ?")
      .get(challengeId) as ChallengeRow | undefined;
  }

  issue(preview: ChallengePreview): ConfirmationChallenge {
    // RT-LIMIT-02 — the display is measured against the frozen challengeBytes
    // limit BEFORE any row is produced; a violation yields no row at all.
    assertChallengeDisplayBounded(preview.display);
    this.#purgeHistory();
    const openRow = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM confirmation_challenges WHERE consumed_at IS NULL AND expires_at > ?",
      )
      .get(new Date(this.#now()).toISOString()) as { n: number };
    if (openRow.n >= this.#maxOpen) {
      throw new Error("confirmation-challenge-capacity: too many open challenges");
    }
    const issued = this.#now();
    const challenge: ConfirmationChallenge = {
      challengeId: `ch_${randomUUID()}`,
      kind: preview.kind,
      ...challengeDescriptor(preview),
      display: preview.display,
      payloadHash: hashPreviewFact(preview.payload),
      bindingHashes: preview.bindingFacts.map(hashPreviewFact),
      impactSummaryHash: hashPreviewFact(preview.impactSummary),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + this.#ttlMs).toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO confirmation_challenges
         (challenge_id, kind, descriptor_json, display_json, payload_hash,
          binding_hashes_json, impact_summary_hash, issued_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        challenge.challengeId,
        challenge.kind,
        JSON.stringify(challengeDescriptor(preview)),
        JSON.stringify(challenge.display),
        challenge.payloadHash,
        JSON.stringify(challenge.bindingHashes),
        challenge.impactSummaryHash,
        challenge.issuedAt,
        challenge.expiresAt,
      );
    return challenge;
  }

  /** Main fetches the challenge to display; unknown IDs fail to undefined. */
  getChallenge(challengeId: string): ConfirmationChallenge | undefined {
    const row = this.#row(challengeId);
    return row === undefined ? undefined : toChallenge(row);
  }

  /**
   * One-time consume. `current` carries the hashes recomputed from the
   * authoritative facts at execution time (RT-CMD-08/16): any drift since
   * issue fails closed instead of acting on a stale confirmation. The
   * expiry / kind / binding / proof checks are the shared validateConsume
   * (same fail-closed order as the R0 issuer); only the one-time claim is
   * issuer-specific: a conditional UPDATE (WHERE consumed_at IS NULL), so
   * when it runs inside a caller's command transaction (RT-STO-01) a later
   * failure rolls the mark back together with every other write — a
   * challenge is burned exactly when the command it authorizes commits, and
   * the mark persists across restarts because it is a database write.
   */
  consume(
    receipt: ConfirmationReceipt,
    expectedKind: ConfirmationKind,
    current: {
      readonly payloadHash: string;
      readonly bindingHashes: readonly string[];
      readonly impactSummaryHash: string;
    },
    atMs?: number,
  ): ConsumeResult {
    const row = this.#row(receipt.challengeId);
    if (row === undefined) return { ok: false, reason: "unknown-challenge" };
    if (row.consumed_at !== null) return { ok: false, reason: "already-consumed" };
    const checked = validateConsume({
      challenge: toChallenge(row),
      expectedKind,
      current,
      receipt,
      token: this.#token,
      nowMs: atMs ?? this.#now(),
    });
    if (!checked.ok) return checked;
    const consumed = this.#db
      .prepare(
        "UPDATE confirmation_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL",
      )
      .run(new Date(atMs ?? this.#now()).toISOString(), receipt.challengeId);
    if (consumed.changes !== 1) return { ok: false, reason: "already-consumed" };
    return { ok: true };
  }
}
