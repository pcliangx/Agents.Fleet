import { describe, expect, it } from "vitest";
import type { AttachmentStream } from "./attachment-port-binding.js";
import type { CommandResponse, OutgoingCommand } from "./daemon-client.js";
import { DesktopBridgeCore } from "./desktop-bridge.js";
import { DesktopBridgeIpc, type DesktopBridgeIpcOptions } from "./desktop-bridge-ipc.js";

describe("DesktopBridgeIpc", () => {
  it("closes the new Attachment when the binary stream cannot be established", async () => {
    const commands: OutgoingCommand[] = [];
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(command): Promise<CommandResponse> {
          commands.push(command);
          if (command.payload.kind === "Attach") {
            return {
              commandId: command.commandId,
              result: {
                attachmentId: "att_1",
                mode: "Live",
                sessionId: "se_1",
                generation: 1,
                snapshot: { coversThroughSeq: 0, bytes: [] },
              },
            };
          }
          return { commandId: command.commandId, result: { closed: true } };
        },
      },
    });
    const ipc = new DesktopBridgeIpc({
      context: {} as never,
      bridge,
      streamSocketPath: "/missing/stream.sock",
      token: new Uint8Array(),
      clientInstanceId: "test",
      openStream: async (): Promise<AttachmentStream> => {
        throw new Error("stream unavailable");
      },
    } as unknown as DesktopBridgeIpcOptions);

    await expect(ipc.attachTerminal({ sessionId: "se_1" })).resolves.toEqual({
      ok: false,
      error: {
        code: "InternalFailure",
        message: "terminal stream is unavailable",
        retryable: true,
      },
    });
    expect(commands.map((command) => command.payload.kind)).toEqual(["Attach", "CloseAttachment"]);
  });
});
