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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { APP_ORIGIN, installAppProtocol, registerAppSchemePrivileges } from "./app-protocol.js";
import { installContentSecurityPolicy, RENDERER_CSP } from "./csp.js";
import { connectDaemon } from "./daemon-client.js";
import { handleTrustedIpc } from "./trusted-ipc.js";
import { guardSession, guardWebContents } from "./window-guard.js";

// Must run before app is ready (SV1-ELECTRON-01).
registerAppSchemePrivileges();

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

app.whenReady().then(() => {
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
  handleTrustedIpc(channel, { expectedWebContents: win.webContents, allowedOrigin }, () => {
    return connectionInfo;
  });

  const socketPath = process.env.AGENTS_FLEET_SOCKET;
  if (!socketPath) {
    connectionInfo = "no daemon socket (set AGENTS_FLEET_SOCKET)";
    return;
  }
  connectDaemon({ socketPath, clientInstanceId: randomUUID() })
    .then((hello) => {
      connectionInfo = `Connected to daemon — protocol v${hello.selectedProtocolVersion}, generation ${hello.daemonGeneration}`;
    })
    .catch((err: unknown) => {
      connectionInfo = `daemon error: ${String(err)}`;
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
