// SV1-ELECTRON-04 / SV1-TERM-02 — strict renderer Content Security Policy.
// Only assets served from the installed bundle (the af-app origin, i.e.
// 'self') may execute or render. No inline script, no eval, no remote code,
// no framing by foreign origins. Untrusted text (Repository, Hook,
// Transcript, PTY, titles) therefore cannot become script even if it reaches
// the DOM — it must be rendered as text only.

import type { Session } from "electron";
import { APP_ORIGIN } from "./app-protocol.js";

export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Defense-in-depth on top of the CSP header that app-protocol.ts attaches to
 * every response: also stamp the header at the webRequest layer so a future
 * handler refactor cannot silently drop it.
 */
export const installContentSecurityPolicy = (targetSession: Session): void => {
  targetSession.webRequest.onHeadersReceived({ urls: [`${APP_ORIGIN}/*`] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [RENDERER_CSP],
      },
    });
  });
};
