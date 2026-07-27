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

import { randomUUID } from "node:crypto";
import {
  type ChallengeDisplay,
  type ConfirmationChallenge,
  type ConfirmationKind,
  type ConfirmationReceipt,
  type ConsumeResult,
  checkLimit,
  FROZEN_RUNTIME_LIMIT_PROFILE,
} from "@agents-fleet/contracts";
import { canonicalSha256Hex } from "../crypto/canonical-hash.js";
import { StoreError } from "../storage/task-store.js";
import { validateConsume } from "./consume-validation.js";

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

export const hashPreviewFact = canonicalSha256Hex;

// RT-LIMIT-02 — the challenge display is bounded by the frozen profile's
// challengeBytes, measured as UTF-8 bytes of its JSON serialization BEFORE
// any row or Map entry is produced. Shared by both issuers so the persistent
// and in-memory paths enforce the same bound.
export const assertChallengeDisplayBounded = (display: ChallengeDisplay): void => {
  const bytes = Buffer.byteLength(JSON.stringify(display), "utf8");
  const within = checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "challengeBytes", bytes);
  if (!within.ok) {
    throw new StoreError(
      "InvalidRequest",
      `challenge display is ${bytes} bytes, limit ${within.allowed}`,
    );
  }
};

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
    assertChallengeDisplayBounded(preview.display);
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
   * issue fails closed instead of launching on a stale confirmation. The
   * expiry / kind / binding / proof checks are the shared validateConsume;
   * only the one-time claim (the in-memory flag) is issuer-specific.
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
    const checked = validateConsume({
      challenge,
      expectedKind,
      current,
      receipt,
      token: this.#token,
      nowMs: atMs ?? this.#now(),
    });
    if (!checked.ok) return checked;
    challenge.consumed = true;
    return { ok: true };
  }
}
