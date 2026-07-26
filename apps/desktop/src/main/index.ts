// Electron Main — boots a window, connects the Daemon (handshake), and exposes
// connection info to the renderer via a typed preload. contextIsolation on,
// nodeIntegration off, sandbox on (SV1-AUTH-06/08). Main never loads node-pty.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DevTokenFileTokenSource } from "@agents-fleet/transport";
import { app, BrowserWindow, ipcMain } from "electron";
import { connectDaemon } from "./daemon-client.js";

const channel = "af:get-connection-info";
let connectionInfo = "connecting…";

const createWindow = (): void => {
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

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }
};

app.whenReady().then(async () => {
  ipcMain.handle(channel, () => connectionInfo);
  createWindow();

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
  connectDaemon({ socketPath, token, clientInstanceId: randomUUID() })
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
