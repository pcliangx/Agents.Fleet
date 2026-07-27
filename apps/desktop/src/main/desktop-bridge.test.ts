import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import type { CommandResponse, OutgoingCommand } from "./daemon-client.js";
import { DesktopBridgeCore } from "./desktop-bridge.js";

describe("DesktopBridgeCore control interface", () => {
  it("maps Task creation and Fleet reads to fixed command kinds", async () => {
    const commands: OutgoingCommand[] = [];
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(command): Promise<CommandResponse> {
          commands.push(command);
          if (command.payload.kind === "CreateTask") {
            return {
              commandId: command.commandId,
              result: {
                taskId: "tk_1",
                workspaceId: "ws_1",
                lifecycle: "Draft",
                taskSpecVersion: 1,
                stateVersion: 1,
              },
            };
          }
          return {
            commandId: command.commandId,
            result: {
              workspaceId: "ws_1",
              tasks: [],
              stateVersion: 0,
              freshness: "Fresh",
              dataGap: false,
              generatedAt: "2026-07-28T00:00:00.000Z",
            },
          };
        },
      },
    });

    await expect(
      bridge.createTask({
        workspaceId: "ws_1",
        spec: { goal: "Show the Task in the desktop UI" },
      }),
    ).resolves.toMatchObject({ ok: true, result: { taskId: "tk_1" } });
    await expect(bridge.getFleetProjection("ws_1")).resolves.toMatchObject({
      ok: true,
      result: { workspaceId: "ws_1", freshness: "Fresh" },
    });

    expect(commands.map((command) => command.payload.kind)).toEqual([
      "CreateTask",
      "GetFleetProjection",
    ]);
    expect(commands[0]).toMatchObject({
      workspaceId: "ws_1",
      payload: {
        kind: "CreateTask",
        spec: { goal: "Show the Task in the desktop UI" },
      },
    });
  });

  it("rejects unknown Task fields before crossing the Main-to-Daemon boundary", async () => {
    let sends = 0;
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(): Promise<CommandResponse> {
          sends += 1;
          throw new Error("must not send");
        },
      },
    });

    const result = await bridge.createTask({
      workspaceId: "ws_1",
      spec: { goal: "safe", argv: ["/bin/sh"] },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "InvalidRequest",
        message: "spec has unknown field: argv",
        retryable: false,
      },
    });
    expect(sends).toBe(0);
  });

  it("maps terminal control to Attachment-bound daemon commands", async () => {
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
                generation: 3,
                snapshot: { coversThroughSeq: 0, bytes: [] },
              },
            };
          }
          if (command.payload.kind === "AcquireControl") {
            return {
              commandId: command.commandId,
              result: {
                attachmentId: "att_1",
                sessionId: "se_1",
                generation: 3,
                fencingToken: 7,
                expiresAt: 99_999,
              },
            };
          }
          return { commandId: command.commandId, result: { accepted: true } };
        },
      },
    });

    const attached = await bridge.attachTerminal({ sessionId: "se_1", fromSeq: 1 });
    const controlled = await bridge.acquireControl("att_1");
    if (!controlled.ok) throw new Error("expected Control Lease");
    await bridge.writeTerminalInput({
      lease: controlled.result,
      source: "Keyboard",
      bytes: new Uint8Array([0, 255]),
    });
    await bridge.resizeTerminal({ lease: controlled.result, cols: 100, rows: 40 });
    await bridge.renewControl(controlled.result);
    await bridge.closeAttachment("att_1");

    expect(attached).toMatchObject({
      ok: true,
      result: { attachmentId: "att_1", mode: "Live" },
    });
    expect(commands.map((command) => command.payload.kind)).toEqual([
      "Attach",
      "AcquireControl",
      "WriteSessionInput",
      "ResizeSession",
      "RenewControl",
      "CloseAttachment",
    ]);
    expect(commands[2]).toMatchObject({
      sessionId: "se_1",
      expectedGeneration: 3,
      attachmentId: "att_1",
      fencingToken: 7,
      payload: { bytes: [0, 255], source: "Keyboard" },
    });
  });

  it("rejects oversized terminal input before serializing it onto the control channel", async () => {
    let sends = 0;
    const bridge = new DesktopBridgeCore({
      sender: {
        async sendCommand(): Promise<CommandResponse> {
          sends += 1;
          return { commandId: "unexpected", result: null };
        },
      },
    });

    const result = await bridge.writeTerminalInput({
      lease: {
        sessionId: "se_1",
        generation: 1,
        attachmentId: "att_1",
        fencingToken: 1,
        expiresAt: 20_000,
      },
      source: "Paste",
      bytes: new Uint8Array(FROZEN_RUNTIME_LIMIT_PROFILE.inputIntentBytes + 1),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest", message: "terminal input exceeds the runtime limit" },
    });
    expect(sends).toBe(0);
  });
});
