// Minimal typed preload (SV1-AUTH-06/08): only a command-named method, no
// generic send/invoke, no Node objects, no channel passthrough.

import { contextBridge, ipcRenderer } from "electron";

const api = {
  getConnectionInfo(): Promise<string> {
    return ipcRenderer.invoke("af:get-connection-info");
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("agentsFleet", api);
