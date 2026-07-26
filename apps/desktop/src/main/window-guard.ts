// SV1-ELECTRON-03 — deny-by-default guards for every webContents and session.
// Navigation, new-window, webview attach, download and permission requests
// are all refused by default. External URLs are never loaded inside a window
// with preload privileges; they may only leave via the independent policy in
// external-url.ts plus a real user gesture and the system default browser.
//
// This module takes Electron objects as parameters (type-only imports) so the
// wiring stays in one place (`web-contents-created` in index.ts) and every
// window — including ones the renderer tricked into existence — is guarded.

import type { Session, WebContents } from "electron";

export type GuardViolationKind =
  | "navigation"
  | "new-window"
  | "webview-attach"
  | "download"
  | "permission-request"
  | "permission-check";

export type GuardViolationHandler = (kind: GuardViolationKind, detail: string) => void;

const noop: GuardViolationHandler = () => {};

/** Deny navigation / new-window / webview-attach for one webContents. */
export const guardWebContents = (
  contents: WebContents,
  onViolation: GuardViolationHandler = noop,
): void => {
  contents.setWindowOpenHandler(({ url }) => {
    onViolation("new-window", url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    onViolation("navigation", url);
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    onViolation("webview-attach", "");
    event.preventDefault();
  });
};

/** Deny downloads and all permission requests/checks for one session. */
export const guardSession = (
  targetSession: Session,
  onViolation: GuardViolationHandler = noop,
): void => {
  targetSession.on("will-download", (event) => {
    onViolation("download", "");
    event.preventDefault();
  });
  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    onViolation("permission-request", permission);
    callback(false);
  });
  targetSession.setPermissionCheckHandler((_webContents, permission) => {
    onViolation("permission-check", permission);
    return false;
  });
};
