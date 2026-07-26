// SV1-ELECTRON-07 / SV1-AUTH-10 / SV1-TRUST-09/10 — confirmation flow core.
//
// The Main-side half of the challenge→native-confirmation→receipt chain,
// expressed against injected seams so the attack surface is testable without
// an Electron process:
//   - fetchChallenge: Main's authenticated channel to the Daemon (R0-12
//     already proves the channel; R1 routes the command over it);
//   - showDialog: the native dialog (Electron Main injects
//     dialog.showMessageBox) — it receives ONLY the challenge's display;
//   - sign: the capability-token MAC (transport/confirmation-proof).
//
// The Renderer-facing contract this enforces by construction: a caller can
// only name a challenge ID. It cannot supply display text, alter hashes,
// reach the token, or mint a receipt — there is no parameter, return value,
// or callback through which any of those could flow.

import type {
  ChallengeDisplay,
  ConfirmationChallenge,
  ConfirmationReceipt,
} from "@agents-fleet/contracts";

export interface ConfirmationFlowDeps {
  /** Main↔Daemon channel; unknown/forged IDs resolve to undefined. */
  readonly fetchChallenge: (challengeId: string) => Promise<ConfirmationChallenge | undefined>;
  /** Native dialog; returns the user's actual gesture. */
  readonly showDialog: (display: ChallengeDisplay) => Promise<"confirm" | "cancel">;
  /** Capability-token receipt proof (daemon verifies the same transcript). */
  readonly sign: (challenge: ConfirmationChallenge, confirmedAt: string) => string;
  readonly now?: () => number;
}

/**
 * Open a confirmation for a challenge ID. Returns the receipt on a real
 * confirm gesture, null otherwise (unknown challenge, cancel, malformed
 * input) — a null never carries a proof.
 */
export const requestConfirmation = async (
  deps: ConfirmationFlowDeps,
  challengeId: unknown,
): Promise<ConfirmationReceipt | null> => {
  // Runtime guard beneath the typed interface: a compromised Renderer is not
  // limited to well-typed input.
  if (typeof challengeId !== "string" || challengeId.length === 0) return null;
  const challenge = await deps.fetchChallenge(challengeId);
  if (challenge === undefined) return null;

  // ONLY the Daemon's structured fields reach the dialog (SV1-ELECTRON-07).
  const answer = await deps.showDialog(challenge.display);
  if (answer !== "confirm") return null;

  const confirmedAt = new Date((deps.now ?? (() => Date.now()))()).toISOString();
  return {
    challengeId: challenge.challengeId,
    proof: deps.sign(challenge, confirmedAt),
    confirmedAt,
  };
};
