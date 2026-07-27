// R1-02 — PersistentChallengeIssuer: the R0 one-time, hash-bound challenge
// semantics (RT-REPO-06 / RT-CMD-16/17/18) backed by SQLite, so consume and
// replay protection survive a Daemon restart (new instance, same db file).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmationChallenge, ConfirmationReceipt } from "@agents-fleet/contracts";
import { signConfirmation as sign } from "@agents-fleet/transport";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { openDatabase } from "../storage/database.js";

const TOKEN = new TextEncoder().encode("r1-02-test-capability-token");
const WRONG_TOKEN = new TextEncoder().encode("attacker-token");

const NOW = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const preview = {
  kind: "repository-trust" as const,
  display: { title: "Grant Repository Trust", fields: [{ label: "Repository", value: "/repo/a" }] },
  payload: { canonicalRoot: "/repo/a", filesystemIdentity: { dev: 1, ino: 2 } },
  bindingFacts: [{ canonicalRoot: "/repo/a" }, { userIdentity: "uid:501" }],
  impactSummary: { impactClass: "reversible", summary: "enters PendingValidation" },
};

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const openIssuer = (options: { maxOpen?: number; now?: () => number } = {}) => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "af-r102-ch-"));
  const result = openDatabase({
    path: join(dir, "fleet.db"),
    migrations: PersistentChallengeIssuer.migrations,
    now: options.now ?? (() => NOW),
  });
  if (result.kind !== "ready") throw new Error("db not ready");
  const issuer = new PersistentChallengeIssuer({
    db: result.db,
    token: TOKEN,
    ttlMs: 60_000,
    now: options.now ?? (() => NOW),
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
  });
  return { issuer, db: result.db };
};

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

describe("PersistentChallengeIssuer.issue (RT-CMD-17)", () => {
  it("persists the challenge; getChallenge returns it and hashes are deterministic", () => {
    const { issuer } = openIssuer();
    const a = issuer.issue(preview);
    const { issuer: again } = openIssuer();
    const b = again.issue(preview);
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.bindingHashes).toEqual(b.bindingHashes);
    expect(a.impactSummaryHash).toBe(b.impactSummaryHash);
    expect(a.expiresAt).toBe(iso(NOW + 60_000));
    expect(a.challengeId).not.toBe(b.challengeId);
    expect(issuer.getChallenge(a.challengeId)).toEqual(a);
    expect(issuer.getChallenge("ch_missing")).toBeUndefined();
  });

  it("bounds the number of open challenges (RT-CMD-17 rate limit)", () => {
    const { issuer } = openIssuer({ maxOpen: 1 });
    issuer.issue(preview);
    expect(() => issuer.issue(preview)).toThrow(/capacity/);
  });
});

describe("PersistentChallengeIssuer.consume (RT-CMD-16 one-time + fail-closed)", () => {
  it("accepts exactly once; the replay is already-consumed", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(issuer.consume(receipt, "repository-trust", currentFactsOf(challenge))).toEqual({
      ok: true,
    });
    expect(issuer.consume(receipt, "repository-trust", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "already-consumed",
    });
  });

  it("unknown challenge id", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    const forged = { ...signFor(challenge), challengeId: "ch_forged" };
    expect(issuer.consume(forged, "repository-trust", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "unknown-challenge",
    });
  });

  it("expired challenge", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(
      issuer.consume(receipt, "repository-trust", currentFactsOf(challenge), NOW + 61_000),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("cross-command reuse is kind-mismatch", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(issuer.consume(receipt, "launch", currentFactsOf(challenge))).toEqual({
      ok: false,
      reason: "kind-mismatch",
    });
  });

  it("recomputed facts that drift are binding-drift", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(
      issuer.consume(receipt, "repository-trust", {
        ...currentFactsOf(challenge),
        payloadHash: "0".repeat(64),
      }),
    ).toEqual({ ok: false, reason: "binding-drift" });
  });

  it("a receipt signed without the capability token is invalid-proof", () => {
    const { issuer } = openIssuer();
    const challenge = issuer.issue(preview);
    expect(
      issuer.consume(
        signFor(challenge, WRONG_TOKEN),
        "repository-trust",
        currentFactsOf(challenge),
      ),
    ).toEqual({ ok: false, reason: "invalid-proof" });
  });

  it("a consumed challenge stays consumed across a Daemon restart (new instance, same db file)", () => {
    const first = openIssuer();
    const challenge = first.issuer.issue(preview);
    const receipt = signFor(challenge);
    expect(first.issuer.consume(receipt, "repository-trust", currentFactsOf(challenge))).toEqual({
      ok: true,
    });
    first.db.close();

    const restarted = openIssuer();
    // the receipt cannot be replayed against the new instance (RT-CMD-16)
    expect(
      restarted.issuer.consume(receipt, "repository-trust", currentFactsOf(challenge)),
    ).toEqual({ ok: false, reason: "already-consumed" });
  });

  it("an unconsumed challenge survives a restart and can still be consumed once", () => {
    const first = openIssuer();
    const challenge = first.issuer.issue(preview);
    first.db.close();

    const restarted = openIssuer();
    const persisted = restarted.issuer.getChallenge(challenge.challengeId);
    expect(persisted).toEqual(challenge);
    const receipt = signFor(challenge);
    expect(
      restarted.issuer.consume(receipt, "repository-trust", currentFactsOf(challenge)),
    ).toEqual({ ok: true });
    expect(
      restarted.issuer.consume(receipt, "repository-trust", currentFactsOf(challenge)),
    ).toEqual({ ok: false, reason: "already-consumed" });
  });
});
