// Minimal typed preload (SV1-AUTH-06/08): only a command-named method, no
// generic send/invoke, no Node objects, no channel passthrough.

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./desktop-api.js";

const api = createDesktopApi(() => ipcRenderer.invoke("af:get-connection-info"));

export type { DesktopApi } from "./desktop-api.js";

contextBridge.exposeInMainWorld("agentsFleet", api);
