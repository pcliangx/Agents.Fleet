// SV1-ELECTRON-02 — ipcMain wiring that refuses untrusted senders.
// Every command-named channel must be registered through handleTrustedIpc so
// sender / frame / origin validation cannot be skipped. Denials throw, so the
// renderer only sees a generic rejected invoke (fail closed).
//
// R1-02: handler args are the renderer's invoke arguments, forwarded as
// `unknown` — every handler must validate them itself (a compromised renderer
// is not limited to well-typed input).

import { ipcMain } from "electron";
import { type TrustedSenderContext, validateIpcSender } from "./ipc-guard.js";

export const handleTrustedIpc = (
  channel: string,
  context: TrustedSenderContext,
  handler: (...args: unknown[]) => unknown | Promise<unknown>,
): void => {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const verdict = validateIpcSender(event.sender, event.senderFrame, context);
    if (!verdict.trusted) {
      throw new Error(`IPC denied (${verdict.reason})`);
    }
    return handler(...args);
  });
};
