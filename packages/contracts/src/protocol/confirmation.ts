// RT-REPO-06 / RT-CMD-17 / RT-CMD-18 — confirmation challenge & receipt types.
//
// The Daemon issues a one-time challenge bound (by hash) to the authoritative
// preview facts; Electron Main shows the challenge's fixed display fields in a
// native dialog and, only after a real user gesture, signs a receipt with the
// shared capability token. The Renderer can request that a challenge ID be
// opened — it can never supply display text, alter hashes, or mint a receipt
// (SV1-TRUST-09/10, SV1-ELECTRON-07, SV1-AUTH-10).
//
// Pure types + pure logic only; hashing/MAC lives in transport (Node crypto),
// the issuer store lives in the daemon, the dialog in Electron Main.

export type ConfirmationKind = "repository-trust" | "launch" | "side-effect";

/** One inert-text line of the confirmation dialog. Never executable payload. */
export interface ChallengeField {
  readonly label: string;
  readonly value: string;
}

/**
 * The ONLY thing the dialog renders (SV1-ELECTRON-07): structured, bounded,
 * secret-free fields produced by the Daemon. Strings are inert text; they
 * never become routes, argv, or executable payload.
 */
export interface ChallengeDisplay {
  readonly title: string;
  readonly fields: readonly ChallengeField[];
}

export type SideEffectClass = "read" | "reversible" | "destructive" | "external";

/** Public, inert identity facts shown/fetched with an RT-CMD-18 challenge. */
export interface ConfirmationTargetIdentity {
  /** Open for forward-compatible Daemon-owned target kinds across protocol versions. */
  readonly targetType: string;
  readonly targetId: string;
  readonly generation?: number;
  readonly fencingToken?: number;
}

/** Optimistic state bindings that must still match when a command executes. */
export interface ConfirmationExpectedStateVersion {
  /** Open for forward-compatible Daemon-owned target kinds across protocol versions. */
  readonly targetType: string;
  readonly targetId: string;
  readonly stateVersion: number;
}

export interface ConfirmationChallenge {
  readonly challengeId: string;
  readonly kind: ConfirmationKind;
  /**
   * RT-CMD-17/18 command discriminator, when the challenge authorizes a
   * command. Open because internal confirmation actions such as
   * TakeoverControl are not renderer-routable CommandKinds.
   */
  readonly commandType?: string;
  /** RT-CMD-18 — always Daemon-derived for a side-effect challenge. */
  readonly sideEffectClass?: SideEffectClass;
  /** RT-CMD-18 — authoritative target scope, never supplied by Renderer display text. */
  readonly targetIdentities?: readonly ConfirmationTargetIdentity[];
  /** RT-CMD-18 — state versions bound into bindingHashes. */
  readonly expectedStateVersions?: readonly ConfirmationExpectedStateVersion[];
  readonly display: ChallengeDisplay;
  /** sha256 hex of the canonicalized preview payload. */
  readonly payloadHash: string;
  /** sha256 hex of each bound fact (identity, argv, Worktree binding, …). */
  readonly bindingHashes: readonly string[];
  /** sha256 hex of the canonicalized impact summary. */
  readonly impactSummaryHash: string;
  /** ISO timestamps; expiry is enforced at consume time. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ConfirmationReceipt {
  readonly challengeId: string;
  /** HMAC-SHA256 hex over the receipt transcript (transport/confirmation-proof). */
  readonly proof: string;
  /** ISO timestamp of the user gesture. */
  readonly confirmedAt: string;
}

export type ConsumeFailure =
  /** No such challenge (forged or unknown ID). */
  | "unknown-challenge"
  /** Past expiresAt at consume time. */
  | "expired"
  /** One-time use: already consumed (RT-CMD-16) or already superseded. */
  | "already-consumed"
  /** Receipt presented for a different confirmation kind (cross-command reuse). */
  | "kind-mismatch"
  /** Recomputed preview facts differ from the bound hashes (RT-CMD-08/16). */
  | "binding-drift"
  /** MAC verification failed (missing/wrong capability token material). */
  | "invalid-proof";

export type ConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConsumeFailure };

/** Pure expiry check — the caller injects the clock. */
export const isChallengeExpired = (c: ConfirmationChallenge, nowMs: number): boolean =>
  nowMs >= Date.parse(c.expiresAt);

/**
 * The fields both sides feed into the receipt MAC, in order. Single source of
 * truth (same discipline as RT-HS-04's buildProofTranscript): any drift
 * between sign and verify shows up as a proof mismatch.
 */
export const receiptTranscriptFields = (
  challenge: ConfirmationChallenge,
  confirmedAt: string,
): readonly string[] => [
  challenge.challengeId,
  challenge.kind,
  challenge.payloadHash,
  ...challenge.bindingHashes,
  challenge.impactSummaryHash,
  challenge.expiresAt,
  confirmedAt,
];
