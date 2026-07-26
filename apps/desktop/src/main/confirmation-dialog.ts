// SV1-ELECTRON-07 / SV1-AUTH-10 — Electron-native confirmation dialog.
//
// The production dialog adapter for transport's confirmation flow: renders
// ONLY the Daemon challenge's fixed display fields (title + inert field
// lines) in a native dialog, with Cancel as the default action — a
// confirmation is never the accidental choice. R1 wires this into the typed
// IPC channel (handleTrustedIpc) once the Control Dispatcher routes the
// confirmation commands; the flow itself is proven through the injected seam
// (packages/daemon/src/__tests__/confirmation-e2e.test.ts).

import type { ChallengeDisplay } from "@agents-fleet/contracts";
import { dialog } from "electron";

export const showNativeConfirmation = async (
  display: ChallengeDisplay,
): Promise<"confirm" | "cancel"> => {
  const detail = display.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: display.title,
    message: display.title,
    detail,
    buttons: ["Cancel", "Confirm"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 ? "confirm" : "cancel";
};
