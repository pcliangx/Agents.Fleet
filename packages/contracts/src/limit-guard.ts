// RT-LIMIT-02 — boundary limit guard.
//
// Every component (Daemon, Electron Main, Renderer, Snapshot Worker) checks a
// measurement against the SAME versioned profile before parsing / allocating /
// persisting / forwarding. This pure, Node-free guard is that check: the
// caller maps a violation to the surface's contract — `InvalidRequest` for
// untrusted input, `StoragePressure` for durable-capacity pressure
// (RT-LIMIT-02). An untrusted length field never decides a preallocation
// size: non-finite or negative actuals fail closed as violations.

import type { RuntimeLimitProfile, TerminalLimits } from "./limits.js";

export type ProfileLimitField = Exclude<keyof RuntimeLimitProfile, "profileVersion" | "terminal">;
export type TerminalLimitField = keyof TerminalLimits;

export interface LimitViolation {
  readonly ok: false;
  readonly scope: "profile" | "terminal";
  readonly field: string;
  readonly allowed: number;
  readonly actual: number;
}

export type LimitCheckResult = { readonly ok: true } | LimitViolation;

const check = (
  scope: LimitViolation["scope"],
  field: string,
  allowed: number,
  actual: number,
): LimitCheckResult => {
  // Fail closed: an unverifiable actual is a violation, never an allocation
  // size. The cap itself is inclusive (limit - 1 / limit pass, limit + 1
  // violates — the R0-06 boundary evidence).
  if (!Number.isFinite(actual) || actual < 0 || actual > allowed) {
    return { ok: false, scope, field, allowed, actual };
  }
  return { ok: true };
};

/** Check `actual` against a top-level profile limit. */
export function checkLimit(
  profile: RuntimeLimitProfile,
  field: ProfileLimitField,
  actual: number,
): LimitCheckResult {
  return check("profile", field, profile[field], actual);
}

/** Check `actual` against a nested terminal-surface limit. */
export function checkTerminalLimit(
  profile: RuntimeLimitProfile,
  field: TerminalLimitField,
  actual: number,
): LimitCheckResult {
  return check("terminal", field, profile.terminal[field], actual);
}
