// SV1-ELECTRON-02 — ipcMain wiring that refuses untrusted senders.
// Every command-named channel must be registered through handleTrustedIpc so
// sender / frame / origin validation cannot be skipped. Denials throw, so the
// renderer only sees a generic rejected invoke (fail closed).

import { ipcMain } from "electron";
import { type TrustedSenderContext, validateIpcSender } from "./ipc-guard.js";

export const handleTrustedIpc = (
  channel: string,
  context: TrustedSenderContext,
  handler: () => unknown | Promise<unknown>,
): void => {
  ipcMain.handle(channel, (event) => {
    const verdict = validateIpcSender(event.sender, event.senderFrame, context);
    if (!verdict.trusted) {
      throw new Error(`IPC denied (${verdict.reason})`);
    }
    return handler();
  });
};
