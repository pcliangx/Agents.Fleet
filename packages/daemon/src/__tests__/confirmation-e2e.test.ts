// S4 — end-to-end: Daemon challenge → Main confirmation flow (dialog spy,
// real capability-token MAC) → Daemon consume. One valid confirmation, every
// replay / drift / forgery fails closed (RT-CMD-16, SV1-T-28/29 shape).

import type { ChallengeDisplay } from "@agents-fleet/contracts";
import { requestConfirmation, signConfirmation } from "@agents-fleet/transport";
import { describe, expect, it, vi } from "vitest";
import { ChallengeIssuer } from "../confirmation/challenge-issuer.js";

const TOKEN = new TextEncoder().encode("r0-17-e2e-capability-token");
const ATTACKER_TOKEN = new TextEncoder().encode("no-keychain-access");
const NOW = 1_800_000_000_000;

const preview = {
  kind: "repository-trust" as const,
  display: {
    title: "Trust repository?",
    fields: [
      { label: "canonical path", value: "/repo" },
      { label: "validation plan", value: "restricted git validation (8 calls)" },
    ],
  },
  payload: { canonicalRoot: "/repo", plannedAgent: "claude" },
  bindingFacts: [{ filesystemIdentity: { dev: 1, ino: 2 } }],
  impactSummary: { class: "reversible", summary: "enters PendingValidation" },
};

const drive = async (issuer: ChallengeIssuer, gesture: "confirm" | "cancel" = "confirm") => {
  const challenge = issuer.issue(preview);
  const showDialog = vi.fn(async (_display: ChallengeDisplay) => gesture);
  const receipt = await requestConfirmation(
    {
      fetchChallenge: async (id) => issuer.getChallenge(id),
      showDialog,
      sign: (c, confirmedAt) => signConfirmation(c, confirmedAt, TOKEN),
      now: () => NOW + 1000,
    },
    challenge.challengeId,
  );
  return { challenge, receipt, showDialog };
};

describe("confirmation e2e (challenge → native gesture → receipt → consume)", () => {
  it("one real gesture produces exactly one usable receipt", async () => {
    const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
    const { challenge, receipt, showDialog } = await drive(issuer);
    expect(showDialog).toHaveBeenCalledWith(preview.display);
    expect(receipt).not.toBeNull();
    if (receipt === null) throw new Error("expected a receipt from the confirm gesture");
    const current = {
      payloadHash: challenge.payloadHash,
      bindingHashes: challenge.bindingHashes,
      impactSummaryHash: challenge.impactSummaryHash,
    };
    expect(issuer.consume(receipt, "repository-trust", current)).toEqual({ ok: true });
    // replay of the same receipt: no second authorization
    expect(issuer.consume(receipt, "repository-trust", current)).toEqual({
      ok: false,
      reason: "already-consumed",
    });
  });

  it("cancel yields nothing the Daemon would accept", async () => {
    const issuer = new ChallengeIssuer({ token: TOKEN, now: () => NOW });
    const { receipt } = await drive(issuer, "cancel");
    expect(receipt).toBeNull();
  });

  it("a receipt minted without the capability token fails at the Daemon", async () => {
    const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
    const challenge = issuer.issue(preview);
    const forged = {
      challengeId: challenge.challengeId,
      proof: signConfirmation(challenge, new Date(NOW + 1000).toISOString(), ATTACKER_TOKEN),
      confirmedAt: new Date(NOW + 1000).toISOString(),
    };
    expect(
      issuer.consume(forged, "repository-trust", {
        payloadHash: challenge.payloadHash,
        bindingHashes: challenge.bindingHashes,
        impactSummaryHash: challenge.impactSummaryHash,
      }),
    ).toEqual({ ok: false, reason: "invalid-proof" });
  });

  it("facts drifting after issue fail closed at consume (RT-CMD-08/16)", async () => {
    const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
    const { challenge, receipt } = await drive(issuer);
    if (receipt === null) throw new Error("expected a receipt from the confirm gesture");
    expect(
      issuer.consume(receipt, "repository-trust", {
        payloadHash: challenge.payloadHash,
        bindingHashes: ["f".repeat(64)], // canonical root replaced after confirmation
        impactSummaryHash: challenge.impactSummaryHash,
      }),
    ).toEqual({ ok: false, reason: "binding-drift" });
  });
});
