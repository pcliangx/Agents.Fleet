// Electron Main — boots a window, connects the Daemon (handshake), and exposes
// connection info to the renderer via a typed preload. contextIsolation on,
// nodeIntegration off, sandbox on (SV1-AUTH-06/08). Main never loads node-pty.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
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

app.whenReady().then(() => {
  ipcMain.handle(channel, () => connectionInfo);
  createWindow();

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
