// RT-REPO-05 — RepositoryTrustState.
// Untrusted -> PendingValidation -> Active; PendingValidation|Active -> Revoked.
// Revoked is terminal for that trust version; re-grant creates a new version.

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type RepositoryTrustState = "Untrusted" | "PendingValidation" | "Active" | "Revoked";

export const REPOSITORY_TRUST_TRANSITIONS = {
  Untrusted: ["PendingValidation"],
  PendingValidation: ["Active", "Revoked"],
  Active: ["Revoked"],
  Revoked: [],
} as const satisfies TransitionTable<RepositoryTrustState>;

export const REPOSITORY_TRUST_TERMINAL_STATES = [
  "Revoked",
] as const satisfies readonly RepositoryTrustState[];

export const canTransition = (from: RepositoryTrustState, to: RepositoryTrustState): boolean =>
  canTrans(REPOSITORY_TRUST_TRANSITIONS, from, to);

export const allowedNext = (from: RepositoryTrustState): readonly RepositoryTrustState[] =>
  allNext(REPOSITORY_TRUST_TRANSITIONS, from);

export const isTerminalRepositoryTrust = (s: RepositoryTrustState): boolean =>
  (REPOSITORY_TRUST_TERMINAL_STATES as readonly string[]).includes(s);
