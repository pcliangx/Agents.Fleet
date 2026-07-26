// RT-REPO-06 / RT-CMD-16/17/18 — Daemon-side confirmation challenge issuer.
//
// The Daemon owns the authoritative preview facts. issue() binds them into a
// one-time challenge (payloadHash + bindingHashes + impactSummaryHash +
// expiresAt); consume() accepts a receipt exactly once and fails closed on
// unknown / consumed / expired / cross-kind / drifted / badly-signed input —
// every failure maps to `ConfirmationRequired` upstream (RT-CMD-06/08/16).
//
// The consumed set is in-memory for R0; SQLite persistence is R1 (declared in
// the probe doc). The token is the shared capability token (SV1-AUTH-03): the
// receipt proof scheme lives in transport/confirmation-proof.ts.

import { createHash, randomUUID } from "node:crypto";
import {
  type ChallengeDisplay,
  type ConfirmationChallenge,
  type ConfirmationKind,
  type ConfirmationReceipt,
  type ConsumeResult,
  isChallengeExpired,
} from "@agents-fleet/contracts";
import { verifyConfirmation } from "@agents-fleet/transport";

export interface ChallengePreview {
  readonly kind: ConfirmationKind;
  /** The only thing the dialog renders — structured, secret-free, inert text. */
  readonly display: ChallengeDisplay;
  /** Authoritative preview payload (canonicalized + hashed into payloadHash). */
  readonly payload: unknown;
  /** Facts the confirmation binds (each canonicalized + hashed, in order). */
  readonly bindingFacts: readonly unknown[];
  /** Impact summary (canonicalized + hashed into impactSummaryHash). */
  readonly impactSummary: unknown;
}

export interface IssuerOptions {
  readonly token: Uint8Array;
  /** Challenge lifetime. R0 value; a profile field is a later decision. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Bounded open-challenge set (RT-CMD-17: bounded dedupe/rate limit). */
  readonly maxOpen?: number;
}

// Deterministic canonicalization: sorted object keys, no whitespace. Two
// previews with equal facts must hash identically; any drift must not.
const canonicalize = (value: unknown): string => JSON.stringify(sortDeep(value));

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
};

const sha256Hex = (canonical: string): string =>
  createHash("sha256").update(canonical).digest("hex");

export const hashPreviewFact = (fact: unknown): string => sha256Hex(canonicalize(fact));

type OpenChallenge = ConfirmationChallenge & { consumed: boolean };

export class ChallengeIssuer {
  readonly #token: Uint8Array;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxOpen: number;
  readonly #open = new Map<string, OpenChallenge>();

  constructor(options: IssuerOptions) {
    this.#token = options.token;
    this.#ttlMs = options.ttlMs ?? 300_000;
    this.#now = options.now ?? (() => Date.now());
    this.#maxOpen = options.maxOpen ?? 64;
  }

  issue(preview: ChallengePreview): ConfirmationChallenge {
    const openCount = [...this.#open.values()].filter((c) => !c.consumed).length;
    if (openCount >= this.#maxOpen) {
      throw new Error("confirmation-challenge-capacity: too many open challenges");
    }
    const issued = this.#now();
    const challenge: OpenChallenge = {
      challengeId: `ch_${randomUUID()}`,
      kind: preview.kind,
      display: preview.display,
      payloadHash: hashPreviewFact(preview.payload),
      bindingHashes: preview.bindingFacts.map(hashPreviewFact),
      impactSummaryHash: hashPreviewFact(preview.impactSummary),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + this.#ttlMs).toISOString(),
      consumed: false,
    };
    this.#open.set(challenge.challengeId, challenge);
    const { consumed: _consumed, ...publicChallenge } = challenge;
    return publicChallenge;
  }

  /** Main fetches the challenge to display; unknown IDs fail to undefined. */
  getChallenge(challengeId: string): ConfirmationChallenge | undefined {
    const c = this.#open.get(challengeId);
    if (c === undefined) return undefined;
    const { consumed: _consumed, ...publicChallenge } = c;
    return publicChallenge;
  }

  /**
   * One-time consume. `current` carries the hashes recomputed from the
   * authoritative facts at execution time (RT-CMD-08/16): any drift since
   * issue fails closed instead of launching on a stale confirmation.
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
    const challenge = this.#open.get(receipt.challengeId);
    if (challenge === undefined) return { ok: false, reason: "unknown-challenge" };
    if (challenge.consumed) return { ok: false, reason: "already-consumed" };
    if (isChallengeExpired(challenge, atMs ?? this.#now())) {
      return { ok: false, reason: "expired" };
    }
    if (challenge.kind !== expectedKind) return { ok: false, reason: "kind-mismatch" };
    if (
      challenge.payloadHash !== current.payloadHash ||
      challenge.impactSummaryHash !== current.impactSummaryHash ||
      challenge.bindingHashes.length !== current.bindingHashes.length ||
      challenge.bindingHashes.some((h, i) => h !== current.bindingHashes[i])
    ) {
      return { ok: false, reason: "binding-drift" };
    }
    if (!verifyConfirmation(challenge, receipt.confirmedAt, receipt.proof, this.#token)) {
      return { ok: false, reason: "invalid-proof" };
    }
    challenge.consumed = true;
    return { ok: true };
  }
}
