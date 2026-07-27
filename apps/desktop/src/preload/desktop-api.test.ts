import type { ControlLease } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { createDesktopApi, type RendererMessagePort } from "./desktop-api.js";

// SV1-AUTH-06/08 / SV1-ELECTRON-06 — the preload surface is exactly the
// command-named methods below: no PTY, socket, native object, or generic IPC
// capability, and no way to supply confirmation display text (SV1-TRUST-09/10).

describe("Desktop preload capability boundary", () => {
  it("exposes only command-named methods", () => {
    const api = createDesktopApi(async () => "connected");

    expect(Object.keys(api).sort()).toEqual(
      [
        "getConnectionInfo",
        "createTask",
        "getFleetProjection",
        "attachTerminal",
        "acquireTerminalControl",
        "writeTerminalInput",
        "resizeTerminal",
        "closeTerminal",
        "prepareTrustCandidate",
        "issueTrustChallenge",
        "requestConfirmation",
        "validateAndActivateTrust",
        "revokeTrust",
        "inspectRepository",
      ].sort(),
    );
  });

  it("forwards each method to its own command-named channel", async () => {
    const calls: { channel: string; args: unknown[] }[] = [];
    const terminalPort = {
      postMessage() {},
      start() {},
      close() {},
      onmessage: null,
    } as RendererMessagePort;
    const api = createDesktopApi(
      async (channel, ...args) => {
        calls.push({ channel, args });
        if (channel === "af:attach-terminal") {
          return {
            ok: true,
            result: {
              attachmentId: "att_1",
              mode: "Live",
              sessionId: "se_1",
              generation: 1,
              snapshot: { coversThroughSeq: 0, bytes: [] },
            },
          };
        }
        return { ok: true, result: null };
      },
      async (attachmentId) => {
        expect(attachmentId).toBe("att_1");
        return terminalPort;
      },
    );

    await api.getConnectionInfo();
    await api.createTask({ workspaceId: "ws_1", spec: { goal: "Build UI" } });
    await api.getFleetProjection("ws_1");
    await expect(api.attachTerminal({ sessionId: "se_1", fromSeq: 1 })).resolves.toMatchObject({
      ok: true,
      port: terminalPort,
    });
    const lease = {
      sessionId: "se_1",
      generation: 1,
      attachmentId: "att_1",
      fencingToken: 1,
      expiresAt: 20_000,
    } as unknown as ControlLease;
    await api.acquireTerminalControl("att_1");
    await api.writeTerminalInput({ lease, source: "Keyboard", bytes: new Uint8Array([65]) });
    await api.resizeTerminal({ lease, cols: 100, rows: 40 });
    await api.closeTerminal("att_1");
    await api.prepareTrustCandidate("/repo");
    await api.issueTrustChallenge({
      candidate: { canonicalRoot: "/repo", filesystemIdentity: { dev: 1, ino: 2 } },
      userIdentity: "uid:501",
      plannedAgent: "claude",
      dataLocation: "~/.agents-fleet",
      hostPermissionUpperBound: "Balanced",
    });
    await api.requestConfirmation("ch_1");
    await api.validateAndActivateTrust("t_1");
    await api.revokeTrust("t_1", "stop");
    await api.inspectRepository("w_1");

    expect(calls.map((c) => c.channel)).toEqual([
      "af:get-connection-info",
      "af:create-task",
      "af:get-fleet-projection",
      "af:attach-terminal",
      "af:acquire-terminal-control",
      "af:write-terminal-input",
      "af:resize-terminal",
      "af:close-terminal",
      "af:prepare-trust-candidate",
      "af:issue-trust-challenge",
      "af:request-confirmation",
      "af:validate-and-activate-trust",
      "af:revoke-trust",
      "af:inspect-repository",
    ]);
    // requestConfirmation forwards ONLY the challenge ID — there is no
    // parameter through which display text or signing material could flow.
    expect(calls[10]?.args).toEqual(["ch_1"]);
  });
});
