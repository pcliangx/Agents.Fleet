import { describe, expect, it } from "vitest";
import { createDesktopApi } from "./desktop-api.js";

// SV1-AUTH-06/08 / SV1-ELECTRON-06 — the preload surface is exactly the
// command-named methods below: no PTY, socket, native object, or generic IPC
// capability, and no way to supply confirmation display text (SV1-TRUST-09/10).

describe("Desktop preload capability boundary", () => {
  it("exposes only command-named methods", () => {
    const api = createDesktopApi(async () => "connected");

    expect(Object.keys(api).sort()).toEqual(
      [
        "getConnectionInfo",
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
    const api = createDesktopApi(async (channel, ...args) => {
      calls.push({ channel, args });
      return { ok: true, result: null };
    });

    await api.getConnectionInfo();
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
      "af:prepare-trust-candidate",
      "af:issue-trust-challenge",
      "af:request-confirmation",
      "af:validate-and-activate-trust",
      "af:revoke-trust",
      "af:inspect-repository",
    ]);
    // requestConfirmation forwards ONLY the challenge ID — there is no
    // parameter through which display text or signing material could flow.
    expect(calls[3]?.args).toEqual(["ch_1"]);
  });
});
