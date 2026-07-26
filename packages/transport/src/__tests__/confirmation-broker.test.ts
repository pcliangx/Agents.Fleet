// S3 — confirmation flow attack surface (SV1-ELECTRON-07 / SV1-AUTH-10 /
// SV1-TRUST-09, Renderer-compromise shape).

import type { ChallengeDisplay, ConfirmationChallenge } from "@agents-fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { type ConfirmationFlowDeps, requestConfirmation } from "../confirmation-broker.js";

const challenge: ConfirmationChallenge = {
  challengeId: "ch_real",
  kind: "launch",
  display: { title: "Launch", fields: [{ label: "argv", value: "claude --print" }] },
  payloadHash: "p".repeat(64),
  bindingHashes: ["b".repeat(64)],
  impactSummaryHash: "i".repeat(64),
  issuedAt: "2027-01-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:05:00.000Z",
};

const makeDeps = (over: Partial<ConfirmationFlowDeps> = {}) => {
  const showDialog = vi.fn(async (_display: ChallengeDisplay) => "confirm" as const);
  const sign = vi.fn(() => "deadbeef".repeat(8));
  const fetchChallenge = vi.fn(async (id: string) => (id === "ch_real" ? challenge : undefined));
  const deps: ConfirmationFlowDeps = {
    fetchChallenge,
    showDialog,
    sign,
    now: () => 1_800_000_000_000,
    ...over,
  };
  return { deps, showDialog, sign, fetchChallenge };
};

describe("requestConfirmation attack surface (SV1-T-28/29 shape)", () => {
  it("forged or unknown challenge id: no dialog, no signature, no receipt", async () => {
    const { deps, showDialog, sign } = makeDeps();
    expect(await requestConfirmation(deps, "ch_forged")).toBeNull();
    expect(showDialog).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("non-string / empty input cannot reach the channel", async () => {
    const { deps, fetchChallenge } = makeDeps();
    for (const bad of [42, {}, [], null, undefined, ""]) {
      expect(await requestConfirmation(deps, bad)).toBeNull();
    }
    expect(fetchChallenge).not.toHaveBeenCalled();
  });

  it("cancel (no real user gesture) produces no receipt", async () => {
    const { deps, sign } = makeDeps({
      showDialog: vi.fn(async () => "cancel" as const),
    });
    expect(await requestConfirmation(deps, "ch_real")).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it("the dialog receives exactly the Daemon's display — nothing else flows in", async () => {
    const { deps, showDialog } = makeDeps();
    await requestConfirmation(deps, "ch_real");
    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(showDialog).toHaveBeenCalledWith(challenge.display);
  });

  it("a real confirm gesture yields a receipt bound to the same challenge", async () => {
    const { deps, sign } = makeDeps();
    const receipt = await requestConfirmation(deps, "ch_real");
    expect(receipt).not.toBeNull();
    expect(receipt?.challengeId).toBe("ch_real");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(challenge, new Date(1_800_000_000_000).toISOString());
  });
});
