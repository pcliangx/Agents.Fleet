// Electron Main — boots a window, connects the Daemon (handshake), and exposes
// connection info to the renderer via a typed preload. contextIsolation on,
// nodeIntegration off, sandbox on (SV1-AUTH-08). Main never loads node-pty
// (SV1-AUTH-09).
//
// Boundary posture (SV1-ELECTRON-01..06):
// - release loads the renderer via the restricted af-app protocol, never file://
// - strict CSP on every af-app response
// - navigation / new-window / webview / download / permission all denied
// - IPC only via handleTrustedIpc (sender + frame + origin validation)
// - packaged builds verify the release fuse posture before booting
//   (SV1-ELECTRON-05); dev binaries ship Electron's default fuses and skip

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DevTokenFileTokenSource } from "@agents-fleet/transport";
import { app, BrowserWindow, dialog, session } from "electron";
import { APP_ORIGIN, installAppProtocol, registerAppSchemePrivileges } from "./app-protocol.js";
import { registerTrustIpc } from "./confirmation-ipc.js";
import { installContentSecurityPolicy, RENDERER_CSP } from "./csp.js";
import { DaemonClient } from "./daemon-client.js";
import { type FuseReport, frameworkBinaryPath, verifyReleaseFuses } from "./fuses.js";
import { handleTrustedIpc } from "./trusted-ipc.js";
import { guardSession, guardWebContents } from "./window-guard.js";

// Must run before app is ready (SV1-ELECTRON-01).
registerAppSchemePrivileges();

// SV1-ELECTRON-05 — a packaged build must fail closed on a non-compliant
// fuse posture (or on a binary whose wire cannot be verified at all). Dev
// runs skip this: the shipped dev binary carries Electron's default fuses
// (docs/probes/r0-11-electron-boundary.md), and only the release pipeline
// can fix and sign the final posture.
const enforceReleaseFusePosture = (): boolean => {
  if (!app.isPackaged) return true;
  let report: FuseReport;
  try {
    report = verifyReleaseFuses(readFileSync(frameworkBinaryPath(app.getPath("exe"))));
  } catch (e) {
    dialog.showErrorBox(
      "Agents.Fleet cannot start",
      `fuse verification could not read the framework binary: ${String(e)}`,
    );
    app.exit(1);
    return false;
  }
  if (!report.compliant) {
    // Violations are fuse names and on/off states only — no paths or secrets.
    dialog.showErrorBox(
      "Agents.Fleet cannot start",
      `non-compliant release fuse posture:\n${report.violations.join("\n")}`,
    );
    app.exit(1);
    return false;
  }
  return true;
};

const channel = "af:get-connection-info";
let connectionInfo = "connecting…";

const createWindow = (devUrl: string | undefined): BrowserWindow => {
  const win = new BrowserWindow({
    width: 520,
    height: 220,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (devUrl !== undefined) {
    // Dev-only form: vite dev server over http://localhost. The af-app
    // protocol and its CSP are release-only; the IPC origin allowlist below
    // is bound to whichever origin the window actually loaded.
    void win.loadURL(devUrl);
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }
  return win;
};

app.whenReady().then(async () => {
  if (!enforceReleaseFusePosture()) return;
  const defaultSession = session.defaultSession;
  installAppProtocol({
    assetRoot: join(__dirname, "..", "renderer"),
    contentSecurityPolicy: RENDERER_CSP,
  });
  installContentSecurityPolicy(defaultSession);
  guardSession(defaultSession);
  app.on("web-contents-created", (_event, contents) => {
    guardWebContents(contents);
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const win = createWindow(devUrl);
  const allowedOrigin = devUrl !== undefined ? new URL(devUrl).origin : APP_ORIGIN;
  const ipcContext = { expectedWebContents: win.webContents, allowedOrigin };
  handleTrustedIpc(channel, ipcContext, () => {
    return connectionInfo;
  });

  const socketPath = process.env.AGENTS_FLEET_SOCKET;
  const devTokenPath = process.env.AGENTS_FLEET_DEV_TOKEN;
  if (!socketPath) {
    connectionInfo = "no daemon socket (set AGENTS_FLEET_SOCKET)";
    return;
  }
  if (!devTokenPath) {
    connectionInfo = "no dev token (set AGENTS_FLEET_DEV_TOKEN)";
    return;
  }
  // RT-HS-04 — dev path reads the shared capability token from a 0600 file
  // (SV1-AUTH-07). The prod path reads the Keychain entry via the same access
  // group as the Daemon (signed-binary boundary, R0-02).
  let token: Uint8Array;
  try {
    token = await new DevTokenFileTokenSource(devTokenPath).read();
  } catch (err) {
    connectionInfo = `token error: ${String(err)}`;
    return;
  }
  DaemonClient.connect({ socketPath, token, clientInstanceId: randomUUID() })
    .then((client) => {
      connectionInfo = `Connected to daemon — protocol v${client.hello.selectedProtocolVersion}, generation ${client.hello.daemonGeneration}`;
      // R1-02 — the trust-chain + confirmation channels. The capability token
      // stays in Main: it keys both the handshake proof and the receipt MAC
      // (SV1-TRUST-09); the Renderer can only name command/channel IDs.
      registerTrustIpc({ context: ipcContext, sender: client, token });
    })
    .catch((err: unknown) => {
      connectionInfo = `daemon error: ${String(err)}`;
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
