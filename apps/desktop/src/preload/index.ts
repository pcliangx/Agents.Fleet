// Minimal typed preload (SV1-AUTH-06/08): only command-named methods, no
// generic send/invoke, no Node objects, no channel passthrough.

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./desktop-api.js";

const api = createDesktopApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

export type { DesktopApi, TrustChallengeRequestInput } from "./desktop-api.js";

contextBridge.exposeInMainWorld("agentsFleet", api);
