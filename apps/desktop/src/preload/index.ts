// Minimal typed preload (SV1-AUTH-06/08): only command-named methods, no
// generic send/invoke, no Node objects, no channel passthrough.

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi, type RendererMessagePort } from "./desktop-api.js";

const arrivedPorts = new Map<string, RendererMessagePort>();
const portWaiters = new Map<string, (port: RendererMessagePort) => void>();

ipcRenderer.on("af:terminal-port", (event, message: unknown) => {
  const attachmentId =
    typeof message === "object" &&
    message !== null &&
    typeof (message as { attachmentId?: unknown }).attachmentId === "string"
      ? (message as { attachmentId: string }).attachmentId
      : null;
  const port = event.ports[0] as unknown as RendererMessagePort | undefined;
  if (attachmentId === null || port === undefined) {
    port?.close();
    return;
  }
  const waiter = portWaiters.get(attachmentId);
  if (waiter !== undefined) {
    portWaiters.delete(attachmentId);
    waiter(port);
  } else {
    arrivedPorts.set(attachmentId, port);
  }
});

const receiveTerminalPort = async (attachmentId: string): Promise<RendererMessagePort> => {
  const arrived = arrivedPorts.get(attachmentId);
  if (arrived !== undefined) {
    arrivedPorts.delete(attachmentId);
    return arrived;
  }
  return await new Promise<RendererMessagePort>((resolve) => {
    portWaiters.set(attachmentId, resolve);
  });
};

const api = createDesktopApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  receiveTerminalPort,
);

export type {
  DesktopApi,
  RendererMessagePort,
  TerminalAttachmentResult,
  TrustChallengeRequestInput,
} from "./desktop-api.js";

contextBridge.exposeInMainWorld("agentsFleet", api);
