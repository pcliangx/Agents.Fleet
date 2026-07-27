// RT-CMD-16/17/18 — shared consume validation for both challenge issuers.
//
// The R0 in-memory ChallengeIssuer and the SQLite-backed
// PersistentChallengeIssuer differ ONLY in storage and in how the one-time
// claim lands (Map flag vs conditional UPDATE). Every other consume check —
// expiry, kind, binding drift, proof — is this one pure function so the two
// issuers cannot drift apart. The fail-closed order is part of the contract:
// expired -> kind-mismatch -> binding-drift -> invalid-proof (every failure
// maps to `ConfirmationRequired` upstream, RT-CMD-06/08/16). Unknown and
// already-consumed challenges are storage-level facts and stay with each
// issuer, checked BEFORE this function runs.

import {
  type ConfirmationChallenge,
  type ConfirmationKind,
  type ConfirmationReceipt,
  type ConsumeResult,
  isChallengeExpired,
} from "@agents-fleet/contracts";
import { verifyConfirmation } from "@agents-fleet/transport";

export interface ConsumeCheckInput {
  readonly challenge: ConfirmationChallenge;
  readonly expectedKind: ConfirmationKind;
  /** Hashes recomputed from the authoritative facts at execution time (RT-CMD-08/16). */
  readonly current: {
    readonly payloadHash: string;
    readonly bindingHashes: readonly string[];
    readonly impactSummaryHash: string;
  };
  readonly receipt: ConfirmationReceipt;
  readonly token: Uint8Array;
  readonly nowMs: number;
}

/** Pure expiry / kind / binding / proof checks; the one-time claim is the caller's. */
export const validateConsume = (input: ConsumeCheckInput): ConsumeResult => {
  const { challenge, expectedKind, current, receipt, token, nowMs } = input;
  if (isChallengeExpired(challenge, nowMs)) {
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
  if (!verifyConfirmation(challenge, receipt.confirmedAt, receipt.proof, token)) {
    return { ok: false, reason: "invalid-proof" };
  }
  return { ok: true };
};
