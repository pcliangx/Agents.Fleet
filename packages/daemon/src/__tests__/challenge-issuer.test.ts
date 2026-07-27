// S1/S2 — ChallengeIssuer: one-time, hash-bound confirmation challenges
// (RT-REPO-06 / RT-CMD-16/17/18, SV1-TRUST-09/10).

import type { ConfirmationChallenge, ConfirmationReceipt } from "@agents-fleet/contracts";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { signConfirmation as sign } from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import { ChallengeIssuer } from "../confirmation/challenge-issuer.js";

const TOKEN = new TextEncoder().encode("r0-17-test-capability-token");
const WRONG_TOKEN = new TextEncoder().encode("attacker-token");

const NOW = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const preview = {
  kind: "launch" as const,
  display: { title: "Launch Claude Code", fields: [{ label: "argv", value: "claude --print" }] },
  payload: { argv: ["claude", "--print"], baseCommitSha: "a".repeat(40) },
  bindingFacts: [{ executable: "/usr/local/bin/claude" }, { worktree: "/wt/1" }],
  impactSummary: { class: "reversible", summary: "creates one worktree" },
};

const makeIssuer = () => new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });

const signFor = (challenge: ConfirmationChallenge, token = TOKEN): ConfirmationReceipt => ({
  challengeId: challenge.challengeId,
  proof: sign(challenge, iso(NOW + 1000), token),
  confirmedAt: iso(NOW + 1000),
});

const currentFactsOf = (c: ConfirmationChallenge) => ({
  payloadHash: c.payloadHash,
  bindingHashes: c.bindingHashes,
  impactSummaryHash: c.impactSummaryHash,
});

describe("ChallengeIssuer.issue (RT-CMD-17)", () => {
  it("binds the preview facts into deterministic hashes", () => {
    const a = makeIssuer().issue(preview);
    const b = makeIssuer().issue(preview);
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.bindingHashes).toEqual(b.bindingHashes);
    expect(a.impactSummaryHash).toBe(b.impactSummaryHash);
    expect(a.expiresAt).toBe(iso(NOW + 60_000));
    expect(a.display).toEqual(preview.display);
    // challenge IDs are unique per issue (no replay-by-reissue)
    expect(a.challengeId).not.toBe(b.challengeId);
  });

  it("any fact drift changes the bound hashes", () => {
    const base = makeIssuer().issue(preview);
    const drifted = makeIssuer().issue({
      ...preview,
      payload: { ...preview.payload, baseCommitSha: "b".repeat(40) },
    });
    expect(drifted.payloadHash).not.toBe(base.payloadHash);
  });

  it("bounds the number of open challenges (RT-CMD-17 rate limit)", () => {
    const issuer = new ChallengeIssuer({ token: TOKEN, now: () => NOW, maxOpen: 1 });
    issuer.issue(preview);
    expect(() => issuer.issue(preview)).toThrow(/capacity/);
  });

  it("enforces the frozen challengeBytes display limit (RT-LIMIT-02), same as the persistent issuer", () => {
    const display = {
      title: "t",
      fields: [{ label: "l", value: "x".repeat(FROZEN_RUNTIME_LIMIT_PROFILE.challengeBytes) }],
    };
    expect(() => makeIssuer().issue({ ...preview, display })).toThrowError(
      expect.objectContaining({ code: "InvalidRequest" }),
    );
  });
});

describe("ChallengeIssuer.consume (RT-CMD-16 one-time + fail-closed)", () => {
  it("accepts exactly once; the replay is already-consumed", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(issuer.consume(receipt, "launch", currentFactsOf(challenge))).toEqual({ ok: true });
    expect(issuer.consume(receipt, "launch", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "already-consumed",
    });
  });

  it("unknown challenge id", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const forged = { ...signFor(challenge), challengeId: "ch_forged" };
    expect(issuer.consume(forged, "launch", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "unknown-challenge",
    });
  });

  it("expired challenge", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    // consume after the 60 s TTL
    const result = issuer.consume(receipt, "launch", currentFactsOf(challenge), NOW + 61_000);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("cross-command reuse is kind-mismatch", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(issuer.consume(receipt, "side-effect", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "kind-mismatch",
    });
  });

  it("recomputed facts that drift are binding-drift", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(
      issuer.consume(receipt, "launch", {
        ...currentFactsOf(challenge),
        payloadHash: "0".repeat(64),
      }),
    ).toEqual({ ok: false, reason: "binding-drift" });
  });

  it("a receipt signed without the capability token is invalid-proof", () => {
    const issuer = makeIssuer();
    const challenge = issuer.issue(preview);
    const forged = signFor(challenge, WRONG_TOKEN);
    expect(issuer.consume(forged, "launch", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "invalid-proof",
    });
  });

  it("a receipt whose MAC was minted for a different challenge is invalid-proof", () => {
    const issuer = makeIssuer();
    const a = issuer.issue(preview);
    const b = issuer.issue(preview);
    // attacker takes A's valid MAC and presents it as B's receipt
    const swapped: ConfirmationReceipt = {
      challengeId: b.challengeId,
      proof: sign(a, iso(NOW + 1000), TOKEN),
      confirmedAt: iso(NOW + 1000),
    };
    expect(issuer.consume(swapped, "launch", currentFactsOf(b))).toEqual({
      ok: false,
      reason: "invalid-proof",
    });
  });
});
