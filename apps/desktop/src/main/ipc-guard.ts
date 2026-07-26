// SV1-ELECTRON-02 — sender / frame validation for every IPC request.
// A request is only serviced when it comes from the one expected webContents
// (the main window created by Main), from its top-level frame, and from the
// expected application origin. Subframes, navigated-away frames, destroyed
// senders and foreign origins are all refused by default.
//
// Pure validation lives here (type-only Electron imports, unit-testable);
// the ipcMain wiring lives in trusted-ipc.ts.
//
// R0 boundary note: schema / size / rate limits and per-route capability are
// enforced Daemon-side (SV1-AUTH-06) once the RuntimeLimitProfile is frozen;
// this guard covers the Electron-side identity checks only.

import type { WebContents, WebFrameMain } from "electron";

export interface TrustedSenderContext {
  /** The exact webContents Main created for the app window. */
  readonly expectedWebContents: WebContents;
  /** af-app origin in release builds; the dev-server origin in dev only. */
  readonly allowedOrigin: string;
}

export type SenderVerdict =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly reason: string };

const refuse = (reason: string): SenderVerdict => ({ trusted: false, reason });

export const validateIpcSender = (
  sender: WebContents | undefined,
  senderFrame: WebFrameMain | null | undefined,
  context: TrustedSenderContext,
): SenderVerdict => {
  if (sender === undefined) return refuse("missing sender");
  if (sender.isDestroyed()) return refuse("destroyed sender");
  if (sender !== context.expectedWebContents) return refuse("unexpected webContents");
  if (senderFrame == null) return refuse("missing sender frame");
  if (senderFrame.top !== senderFrame) return refuse("subframe sender");
  // Note: Node's WHATWG URL (used in the Main process) reports origin "null"
  // for non-special schemes like af-app, unlike Chromium. Compare
  // protocol + host explicitly instead.
  try {
    const frameUrl = new URL(senderFrame.url);
    const allowedUrl = new URL(context.allowedOrigin);
    if (frameUrl.protocol !== allowedUrl.protocol || frameUrl.host !== allowedUrl.host) {
      return refuse("unexpected frame origin");
    }
  } catch {
    return refuse("unparseable frame URL");
  }
  return { trusted: true };
};
