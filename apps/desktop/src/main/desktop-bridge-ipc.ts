// RT-MOD-10 / RT-STREAM-06 — trusted IPC registration plus Attachment-bound
// MessagePort delivery.

import type { AttachResult } from "@agents-fleet/contracts";
import { MessageChannelMain, type MessagePortMain } from "electron";
import {
  AttachmentPortBinding,
  type AttachmentStream,
  type MainMessagePort,
} from "./attachment-port-binding.js";
import { DaemonAttachmentStream } from "./daemon-attachment-stream.js";
import type { DesktopBridgeCore, DesktopBridgeResult } from "./desktop-bridge.js";
import type { TrustedSenderContext } from "./ipc-guard.js";
import { ReconnectingAttachmentStream } from "./reconnecting-attachment-stream.js";
import { handleTrustedIpc } from "./trusted-ipc.js";

export interface DesktopBridgeIpcOptions {
  readonly context: TrustedSenderContext;
  readonly bridge: DesktopBridgeCore;
  readonly streamSocketPath: string;
  readonly token: Uint8Array;
  readonly clientInstanceId: string;
  readonly openStream?: (input: {
    readonly attachmentId: string;
    readonly fromSeq: number;
  }) => Promise<AttachmentStream>;
}

const rendererFrameIdentity = (context: TrustedSenderContext): string => {
  const frame = context.expectedWebContents.mainFrame;
  return `${frame.processId}:${frame.routingId}`;
};

const wrapMainPort = (port: MessagePortMain): MainMessagePort => ({
  postMessage: (message) => port.postMessage(message),
  on(event, listener) {
    if (event === "message") {
      port.on("message", listener as (event: { readonly data: unknown }) => void);
    } else {
      port.on("close", listener as () => void);
    }
  },
  start: () => port.start(),
  close: () => port.close(),
});

export class DesktopBridgeIpc {
  readonly #options: DesktopBridgeIpcOptions;
  readonly #bindings = new Map<string, AttachmentPortBinding>();

  constructor(options: DesktopBridgeIpcOptions) {
    this.#options = options;
  }

  async attachTerminal(input: unknown): Promise<DesktopBridgeResult<AttachResult>> {
    const attached = await this.#options.bridge.attachTerminal(input);
    if (!attached.ok) return attached;
    const result = attached.result;
    const fromSeq = (result.snapshot.coversThroughSeq as number) + 1;
    let stream: AttachmentStream;
    try {
      stream =
        this.#options.openStream === undefined
          ? await ReconnectingAttachmentStream.open({
              fromSeq,
              open: async (cursor) =>
                await DaemonAttachmentStream.connect({
                  socketPath: this.#options.streamSocketPath,
                  token: this.#options.token,
                  clientInstanceId: this.#options.clientInstanceId,
                  attachmentId: result.attachmentId,
                  fromSeq: cursor,
                }),
            })
          : await this.#options.openStream({
              attachmentId: result.attachmentId,
              fromSeq,
            });
    } catch {
      await this.#options.bridge.closeAttachment(result.attachmentId);
      return {
        ok: false,
        error: {
          code: "InternalFailure",
          message: "terminal stream is unavailable",
          retryable: true,
        },
      };
    }
    const { port1, port2 } = new MessageChannelMain();
    const binding = new AttachmentPortBinding({
      attached: result,
      rendererFrameIdentity: rendererFrameIdentity(this.#options.context),
      port: wrapMainPort(port1),
      stream,
      bridge: this.#options.bridge,
    });
    this.#bindings.set(result.attachmentId, binding);
    port1.once("close", () => this.#bindings.delete(result.attachmentId));
    binding.start();
    this.#options.context.expectedWebContents.postMessage(
      "af:terminal-port",
      { attachmentId: result.attachmentId },
      [port2],
    );
    return attached;
  }

  async acquireControl(attachmentId: unknown) {
    const acquired = await this.#options.bridge.acquireControl(attachmentId);
    if (acquired.ok) {
      this.#bindings.get(acquired.result.attachmentId)?.holdControl(acquired.result);
    }
    return acquired;
  }

  closeAttachment(attachmentId: unknown) {
    if (typeof attachmentId === "string") {
      const binding = this.#bindings.get(attachmentId);
      if (binding !== undefined) {
        this.#bindings.delete(attachmentId);
        binding.close();
        return Promise.resolve({ ok: true, result: { closed: true as const } });
      }
    }
    return this.#options.bridge.closeAttachment(attachmentId);
  }

  closeAll(): void {
    for (const binding of this.#bindings.values()) binding.close();
    this.#bindings.clear();
  }
}

export const registerDesktopBridgeIpc = (options: DesktopBridgeIpcOptions): DesktopBridgeIpc => {
  const ipc = new DesktopBridgeIpc(options);
  handleTrustedIpc("af:create-task", options.context, (input) => options.bridge.createTask(input));
  handleTrustedIpc("af:get-fleet-projection", options.context, (workspaceId) =>
    options.bridge.getFleetProjection(workspaceId),
  );
  handleTrustedIpc("af:attach-terminal", options.context, (input) => ipc.attachTerminal(input));
  handleTrustedIpc("af:acquire-terminal-control", options.context, (attachmentId) =>
    ipc.acquireControl(attachmentId),
  );
  handleTrustedIpc("af:write-terminal-input", options.context, (input) =>
    options.bridge.writeTerminalInput(input),
  );
  handleTrustedIpc("af:resize-terminal", options.context, (input) =>
    options.bridge.resizeTerminal(input),
  );
  handleTrustedIpc("af:close-terminal", options.context, (attachmentId) =>
    ipc.closeAttachment(attachmentId),
  );
  return ipc;
};
