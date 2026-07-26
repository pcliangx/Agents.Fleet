// SV1-ELECTRON-03 — independent policy for external URLs.
// An external URL may only ever reach the system default browser, only over
// https, only from an explicit allowlist when one is configured, and only on
// a real user gesture. It is never loaded inside an app window (see
// window-guard.ts). Kept Electron-free (shell is injected) for unit tests.

import type { Shell } from "electron";

export interface ExternalUrlRequest {
  readonly url: string;
  /** Must come from a trusted Main-side gesture signal, never from renderer text. */
  readonly userGesture: boolean;
}

export interface ExternalUrlPolicy {
  /** When set, only these exact hostnames may be opened. */
  readonly allowedHosts?: readonly string[];
}

export type ExternalUrlDecision =
  | { readonly allowed: true; readonly url: URL }
  | { readonly allowed: false; readonly reason: string };

const refuse = (reason: string): ExternalUrlDecision => ({ allowed: false, reason });

export const evaluateExternalUrl = (
  request: ExternalUrlRequest,
  policy: ExternalUrlPolicy = {},
): ExternalUrlDecision => {
  if (!request.userGesture) return refuse("missing user gesture");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refuse("unparseable URL");
  }
  if (url.protocol !== "https:") return refuse("only https: URLs may leave the app");
  if (url.username !== "" || url.password !== "") return refuse("userinfo not allowed");
  if (policy.allowedHosts !== undefined && !policy.allowedHosts.includes(url.hostname)) {
    return refuse("host not in allowlist");
  }
  return { allowed: true, url };
};

/**
 * Open an external URL in the system default browser — the only sanctioned
 * way for a URL to leave the app (SV1-ELECTRON-03 / SV1-TERM-03). Returns the
 * decision so callers can audit refusals.
 */
export const openExternalUrl = async (
  shell: Shell,
  request: ExternalUrlRequest,
  policy: ExternalUrlPolicy = {},
): Promise<ExternalUrlDecision> => {
  const decision = evaluateExternalUrl(request, policy);
  if (!decision.allowed) return decision;
  await shell.openExternal(decision.url.toString());
  return decision;
};
