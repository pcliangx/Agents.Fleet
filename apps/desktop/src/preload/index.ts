// Minimal typed preload (SV1-AUTH-06/08): only command-named methods, no
// generic send/invoke, no Node objects, no channel passthrough.

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi, type RendererMessagePort } from "./desktop-api.js";

interface IsolatedMessagePort {
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

const exposeMessagePort = (port: IsolatedMessagePort): RendererMessagePort => {
  port.start?.();
  return {
    postMessage: (message) => port.postMessage(message),
    close: () => port.close(),
    onMessage(listener) {
      const receive = (event: { readonly data: unknown }) => listener(event.data);
      port.onmessage = receive;
      return () => {
        if (port.onmessage === receive) port.onmessage = null;
      };
    },
  };
};

const arrivedPorts = new Map<string, RendererMessagePort>();
const portWaiters = new Map<string, (port: RendererMessagePort) => void>();

ipcRenderer.on("af:terminal-port", (event, message: unknown) => {
  const attachmentId =
    typeof message === "object" &&
    message !== null &&
    typeof (message as { attachmentId?: unknown }).attachmentId === "string"
      ? (message as { attachmentId: string }).attachmentId
      : null;
  const isolatedPort = event.ports[0] as unknown as IsolatedMessagePort | undefined;
  if (attachmentId === null || isolatedPort === undefined) {
    isolatedPort?.close();
    return;
  }
  const port = exposeMessagePort(isolatedPort);
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
