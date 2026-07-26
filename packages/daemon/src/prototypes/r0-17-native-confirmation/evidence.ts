// R0-17 — native confirmation surface evidence CLI.
// Drives the full challenge → flow → consume chain with the real capability
// token and records every accept / fail-closed verdict, including the
// SV1-T-28/29 attack table. Writes docs/probes/r0-17/evidence.json.
//
// Usage: pnpm prototype:r0-17

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChallengeDisplay, ConfirmationReceipt } from "@agents-fleet/contracts";
import { requestConfirmation, signConfirmation } from "@agents-fleet/transport";
import { ChallengeIssuer } from "../../confirmation/challenge-issuer.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = join(ROOT, "docs", "probes", "r0-17");

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const TOKEN = new TextEncoder().encode("r0-17-evidence-capability-token");
const NOW = 1_800_000_000_000;

const previews = {
  "repository-trust": {
    kind: "repository-trust" as const,
    display: {
      title: "Trust repository?",
      fields: [
        { label: "canonical path", value: "/repo" },
        { label: "validation plan", value: "restricted git validation (bounded)" },
        { label: "host permission upper bound", value: "current user, no root" },
      ],
    },
    payload: { canonicalRoot: "/repo", plannedAgent: "claude" },
    bindingFacts: [{ filesystemIdentity: { dev: 1, ino: 2 } }],
    impactSummary: { class: "reversible", summary: "enters PendingValidation" },
  },
  launch: {
    kind: "launch" as const,
    display: {
      title: "Launch Claude Code?",
      fields: [
        { label: "argv (redacted)", value: "claude --print" },
        { label: "baseCommitSha", value: "a".repeat(40) },
      ],
    },
    payload: { argv: ["claude", "--print"], baseCommitSha: "a".repeat(40) },
    bindingFacts: [{ executable: "/usr/local/bin/claude" }, { worktree: "/wt/1" }],
    impactSummary: { class: "reversible", summary: "one worktree, one session" },
  },
  "side-effect": {
    kind: "side-effect" as const,
    display: {
      title: "Stop attempt?",
      fields: [
        { label: "class", value: "destructive" },
        { label: "target", value: "attempt at_1 (all alive sessions)" },
      ],
    },
    payload: { attemptId: "at_1" },
    bindingFacts: [{ attemptStateVersion: 3 }, { aliveSessions: ["se_1"] }],
    impactSummary: { class: "destructive", summary: "stops processes, keeps worktree" },
  },
};

const currentOf = (c: {
  payloadHash: string;
  bindingHashes: readonly string[];
  impactSummaryHash: string;
}) => ({
  payloadHash: c.payloadHash,
  bindingHashes: c.bindingHashes,
  impactSummaryHash: c.impactSummaryHash,
});

const confirmWith = async (
  issuer: ChallengeIssuer,
  challengeId: string,
  token: Uint8Array = TOKEN,
): Promise<ConfirmationReceipt | null> =>
  await requestConfirmation(
    {
      fetchChallenge: async (id) => issuer.getChallenge(id),
      showDialog: async (_display: ChallengeDisplay) => "confirm",
      sign: (c, confirmedAt) => signConfirmation(c, confirmedAt, token),
      now: () => NOW + 1000,
    },
    challengeId,
  );

const main = async (): Promise<void> => {
  const cases: Record<string, unknown> = {};

  // The three confirmation kinds issue with distinct, hash-bound challenges.
  for (const [name, preview] of Object.entries(previews)) {
    const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
    const challenge = issuer.issue(preview);
    const receipt = await confirmWith(issuer, challenge.challengeId);
    if (receipt === null) throw new Error(`expected a receipt for ${name}`);
    const accepted = issuer.consume(receipt, preview.kind, currentOf(challenge));
    const replayed = issuer.consume(receipt, preview.kind, currentOf(challenge));
    cases[`${name} happy path + one-time`] = {
      kindMatches: challenge.kind === preview.kind,
      expiresAt: challenge.expiresAt,
      accepted,
      replayed,
      pass:
        accepted.ok === true &&
        replayed.ok === false &&
        replayed.ok === false &&
        (replayed as { reason: string }).reason === "already-consumed",
    };
  }

  // Attack table (SV1-T-28/29 shape): every forgery fails closed.
  const attacks: Record<string, () => { pass: boolean; detail: unknown }> = {
    "forged challenge id": () => {
      const issuer = new ChallengeIssuer({ token: TOKEN, now: () => NOW });
      const challenge = issuer.issue(previews.launch);
      const forged = {
        challengeId: "ch_forged",
        proof: "0".repeat(64),
        confirmedAt: new Date(NOW).toISOString(),
      };
      const r = issuer.consume(forged, "launch", currentOf(challenge));
      return {
        pass: r.ok === false && (r as { reason: string }).reason === "unknown-challenge",
        detail: r,
      };
    },
    "receipt without capability token": () => {
      const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
      const challenge = issuer.issue(previews.launch);
      const forged = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(
          challenge,
          new Date(NOW + 1000).toISOString(),
          new TextEncoder().encode("attacker"),
        ),
        confirmedAt: new Date(NOW + 1000).toISOString(),
      };
      const r = issuer.consume(forged, "launch", currentOf(challenge));
      return {
        pass: r.ok === false && (r as { reason: string }).reason === "invalid-proof",
        detail: r,
      };
    },
    "tampered challenge binding (drift)": () => {
      const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
      const challenge = issuer.issue(previews.launch);
      const receipt = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(challenge, new Date(NOW + 1000).toISOString(), TOKEN),
        confirmedAt: new Date(NOW + 1000).toISOString(),
      };
      const r = issuer.consume(receipt, "launch", {
        ...currentOf(challenge),
        payloadHash: "f".repeat(64),
      });
      return {
        pass: r.ok === false && (r as { reason: string }).reason === "binding-drift",
        detail: r,
      };
    },
    "cross-command reuse (kind mismatch)": () => {
      const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 60_000, now: () => NOW });
      const challenge = issuer.issue(previews.launch);
      const receipt = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(challenge, new Date(NOW + 1000).toISOString(), TOKEN),
        confirmedAt: new Date(NOW + 1000).toISOString(),
      };
      const r = issuer.consume(receipt, "side-effect", currentOf(challenge));
      return {
        pass: r.ok === false && (r as { reason: string }).reason === "kind-mismatch",
        detail: r,
      };
    },
    "expired challenge": () => {
      const issuer = new ChallengeIssuer({ token: TOKEN, ttlMs: 1, now: () => NOW });
      const challenge = issuer.issue(previews.launch);
      const receipt = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(challenge, new Date(NOW + 1000).toISOString(), TOKEN),
        confirmedAt: new Date(NOW + 1000).toISOString(),
      };
      const r = issuer.consume(receipt, "launch", currentOf(challenge), NOW + 2_000);
      return { pass: r.ok === false && (r as { reason: string }).reason === "expired", detail: r };
    },
  };

  for (const [name, fn] of Object.entries(attacks)) {
    cases[name] = fn();
  }

  {
    // Renderer can only name an ID through the flow: a forged ID yields null.
    const issuer = new ChallengeIssuer({ token: TOKEN, now: () => NOW });
    const receipt = await confirmWith(issuer, "ch_forged");
    cases["renderer requests forged id through the flow"] = { pass: receipt === null, receipt };
  }
  {
    // No gesture (cancel): nothing is signed, nothing to consume.
    const issuer = new ChallengeIssuer({ token: TOKEN, now: () => NOW });
    const challenge = issuer.issue(previews.launch);
    const receipt = await requestConfirmation(
      {
        fetchChallenge: async (id) => issuer.getChallenge(id),
        showDialog: async () => "cancel",
        sign: (c, at) => signConfirmation(c, at, TOKEN),
        now: () => NOW,
      },
      challenge.challengeId,
    );
    cases["cancel produces no receipt"] = { pass: receipt === null, receipt };
  }

  const pass = Object.values(cases).every((c) => (c as { pass: boolean }).pass === true);
  const evidence = {
    probeId: "r0-17-native-confirmation",
    capturedAt: new Date().toISOString(),
    baseCommit: git("rev-parse", "HEAD"),
    challengeTtlMs: 60_000,
    cases,
    verdict: pass ? "PASS" : "FAIL",
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const out = join(EVIDENCE_DIR, "evidence.json");
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  for (const [name, c] of Object.entries(cases)) {
    console.log(`  ${(c as { pass: boolean }).pass ? "✓" : "✗"} ${name}`);
  }
  console.log(`verdict: ${evidence.verdict}`);
  console.log(`wrote ${out}`);
  if (!pass) process.exitCode = 1;
};

await main();
