// R1-02 — TrustService: the daemon side of RT-T-36 / RT-REPO-01..06.
//
// No Git before the first confirmation (SV1-TRUST-04); only an unexpired,
// identity-matching, Main-signed RT-REPO-06 receipt enters PendingValidation
// (forgery / replay / cross-kind / drift fail closed and create nothing);
// PendingValidation runs only the restricted validation; success atomically
// produces Active Trust + Workspace (RT-REPO-03); bare / unborn / corrupt /
// root-mismatch / identity-drift classify per RT-REPO-02/05; ordinary
// failures keep PendingValidation for an idempotent retry (SV1-TRUST-08);
// command replay never re-executes (RT-CMD-02/03).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmationChallenge, ConfirmationReceipt } from "@agents-fleet/contracts";
import { signConfirmation as sign } from "@agents-fleet/transport";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import {
  defaultGitExec,
  type GitExec,
  type GitExecRequest,
  RestrictedGitRunner,
} from "../git/restricted-git.js";
import { TrustService, type ValidationOutcome } from "../repository-trust/trust-service.js";
import { openDatabase } from "../storage/database.js";
import { IdempotencyStore } from "../storage/idempotency.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { RepositoryTrustStore, type WorkspaceRecord } from "../storage/repository-trust-store.js";

const GIT = "/usr/bin/git";
const TOKEN = new TextEncoder().encode("r1-02-trust-service-token");
const WRONG_TOKEN = new TextEncoder().encode("attacker-token");
const USER = "uid:501";

const NOW = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// --- fixtures -----------------------------------------------------------------

const IDENTITY = ["-c", "user.name=r1-02", "-c", "user.email=r1-02@example.invalid"];

const setupGit = (args: readonly string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();

const makeRepo = async (dir: string): Promise<{ root: string; head: string }> => {
  mkdirSync(dir, { recursive: true });
  setupGit(["init", "--initial-branch=main"], dir);
  writeFileSync(join(dir, "README.md"), "r1-02 fixture\n");
  setupGit([...IDENTITY, "add", "README.md"], dir);
  setupGit([...IDENTITY, "commit", "-m", "init"], dir);
  return { root: await realpath(dir), head: setupGit(["rev-parse", "HEAD"], dir) };
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const tempRoot = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "af-r102-svc-")));
  dirs.push(dir);
  return dir;
};

/** Records every Git invocation, then delegates to the real restricted exec. */
const recordingExec = (calls: GitExecRequest[]): GitExec => {
  return async (req) => {
    calls.push({ argv: [...req.argv], cwd: req.cwd, env: { ...req.env } });
    return await defaultGitExec(req);
  };
};

interface Wired {
  readonly service: TrustService;
  readonly challenges: PersistentChallengeIssuer;
  readonly store: RepositoryTrustStore;
  readonly gitCalls: GitExecRequest[];
  setNow: (ms: number) => void;
}

const wire = async (dbDir: string): Promise<Wired> => {
  let now = NOW;
  const result = openDatabase({
    path: join(dbDir, "fleet.db"),
    migrations: ALL_MIGRATIONS,
    now: () => now,
  });
  if (result.kind !== "ready") throw new Error("db not ready");
  const db = result.db;
  const gitCalls: GitExecRequest[] = [];
  const idem = new IdempotencyStore(db, () => now);
  const challenges = new PersistentChallengeIssuer({
    db,
    token: TOKEN,
    ttlMs: 60_000,
    now: () => now,
  });
  const runner = new RestrictedGitRunner({ exec: recordingExec(gitCalls) });
  const service = new TrustService({ db, challenges, idem, runner, now: () => now });
  return {
    service,
    challenges,
    store: new RepositoryTrustStore(db, () => now),
    gitCalls,
    setNow: (ms) => {
      now = ms;
    },
  };
};

const signFor = (challenge: ConfirmationChallenge, token = TOKEN): ConfirmationReceipt => ({
  challengeId: challenge.challengeId,
  proof: sign(challenge, iso(NOW + 1000), token),
  confirmedAt: iso(NOW + 1000),
});

const CHALLENGE_DISPLAY = {
  plannedAgent: "Claude Code",
  dataLocation: "~/Library/Application Support/Agents.Fleet",
  hostPermissionUpperBound: "the signed-in user's full Host session",
} as const;

let cmdSeq = 0;
const cmd = (label: string): string => `cmd_${label}_${++cmdSeq}`;

/** prepareCandidate -> issueTrustChallenge -> confirmTrust; returns the PendingValidation trust. */
const grantPendingTrust = async (w: Wired, root: string) => {
  const candidate = await w.service.prepareCandidate(cmd("prep"), root);
  const challenge = w.service.issueTrustChallenge(cmd("ch"), {
    candidate,
    userIdentity: USER,
    ...CHALLENGE_DISPLAY,
  });
  const receipt = signFor(challenge);
  const trust = await w.service.confirmTrust(cmd("confirm"), candidate, receipt, USER);
  return { candidate, challenge, receipt, trust };
};

// --- pre-confirmation boundary (RT-REPO-01/06, SV1-TRUST-04, RT-T-36) ---------

describe("pre-confirmation boundary (SV1-TRUST-04 / RT-T-36)", () => {
  it("prepare + issue + confirm never invoke Git; confirm creates exactly one PendingValidation row", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);

    const { trust } = await grantPendingTrust(w, repo.root);
    expect(w.gitCalls).toEqual([]); // no Git before validation (RT-ENV-01)
    expect(trust.state).toBe("PendingValidation");
    expect(trust.trustVersion).toBe(1);
    expect(trust.userIdentity).toBe(USER);
  });

  it.each([
    [
      "forged (wrong capability token)",
      (c: ConfirmationChallenge): ConfirmationReceipt => signFor(c, WRONG_TOKEN),
    ],
    [
      "tampered confirmedAt",
      (c: ConfirmationChallenge): ConfirmationReceipt => ({
        ...signFor(c),
        confirmedAt: iso(NOW + 2000), // MAC no longer matches the transcript
      }),
    ],
  ])(
    "a %s receipt is ConfirmationRequired; nothing is created and no Git runs",
    async (_label, makeReceipt) => {
      const root = await tempRoot();
      const repo = await makeRepo(join(root, "repo"));
      const w = await wire(root);
      const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
      const challenge = w.service.issueTrustChallenge(cmd("ch"), {
        candidate,
        userIdentity: USER,
        ...CHALLENGE_DISPLAY,
      });
      await expect(
        w.service.confirmTrust(cmd("confirm"), candidate, makeReceipt(challenge), USER),
      ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
      expect(w.store.liveTrustForRoot(repo.root)).toBeNull();
      expect(w.gitCalls).toEqual([]);
    },
  );

  it("a replayed receipt is already-consumed: rejected, no second row, no Git", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { candidate, receipt, trust } = await grantPendingTrust(w, repo.root);

    await expect(
      w.service.confirmTrust(cmd("confirm2"), candidate, receipt, USER),
    ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(w.store.listTrustVersions(repo.root)).toHaveLength(1);
    expect(w.store.getTrust(trust.trustId).state).toBe("PendingValidation");
    expect(w.gitCalls).toEqual([]);
  });

  it("an expired challenge is rejected and creates nothing", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const challenge = w.service.issueTrustChallenge(cmd("ch"), {
      candidate,
      userIdentity: USER,
      ...CHALLENGE_DISPLAY,
    });
    const receipt = signFor(challenge);
    w.setNow(NOW + 61_000); // past the 60 s TTL
    await expect(
      w.service.confirmTrust(cmd("confirm"), candidate, receipt, USER),
    ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(w.store.liveTrustForRoot(repo.root)).toBeNull();
    expect(w.gitCalls).toEqual([]);
  });

  it("a receipt minted for a different confirmation kind is rejected (cross-kind reuse)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const launchChallenge = w.challenges.issue({
      kind: "launch",
      display: { title: "Launch", fields: [] },
      payload: { argv: ["claude"] },
      bindingFacts: [{ executable: "/usr/local/bin/claude" }],
      impactSummary: { impactClass: "irreversible", summary: "launches" },
    });
    const receipt = signFor(launchChallenge);
    await expect(
      w.service.confirmTrust(cmd("confirm"), candidate, receipt, USER),
    ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(w.store.liveTrustForRoot(repo.root)).toBeNull();
    expect(w.gitCalls).toEqual([]);
  });

  it("a candidate that drifted since the challenge was issued is binding-drift, creating nothing", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const challenge = w.service.issueTrustChallenge(cmd("ch"), {
      candidate,
      userIdentity: USER,
      ...CHALLENGE_DISPLAY,
    });
    const receipt = signFor(challenge);
    const drifted = {
      canonicalRoot: candidate.canonicalRoot,
      filesystemIdentity: {
        dev: candidate.filesystemIdentity.dev,
        ino: candidate.filesystemIdentity.ino + 1,
      },
    };
    await expect(
      w.service.confirmTrust(cmd("confirm"), drifted, receipt, USER),
    ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(w.store.liveTrustForRoot(repo.root)).toBeNull();
    expect(w.gitCalls).toEqual([]);
  });

  it("replacing the directory between issue and confirm is rejected by the re-stat (RT-REPO-06 drift rule)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const challenge = w.service.issueTrustChallenge(cmd("ch"), {
      candidate,
      userIdentity: USER,
      ...CHALLENGE_DISPLAY,
    });
    const receipt = signFor(challenge);

    // attacker swaps the confirmed directory for a lookalike (new inode)
    await rm(repo.root, { recursive: true, force: true });
    await makeRepo(repo.root);

    await expect(
      w.service.confirmTrust(cmd("confirm"), candidate, receipt, USER),
    ).rejects.toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(w.store.liveTrustForRoot(repo.root)).toBeNull();
    expect(w.gitCalls).toEqual([]);
    // the consume mark rolled back with the transaction: the challenge is not burned
    expect(w.challenges.getChallenge(challenge.challengeId)).toBeDefined();
  });
});

// --- validation + activation (RT-REPO-02/03, SV1-TRUST-08) ---------------------

describe("validateAndActivate (RT-REPO-02/03)", () => {
  it("success flips Active and creates the Workspace in one transaction; binding mirrors ValidatedRepository", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);

    const outcome = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(outcome.failure).toBeNull();
    expect(outcome.trust.state).toBe("Active");
    expect(outcome.workspace).not.toBeNull();
    const workspace = outcome.workspace;
    const validated = outcome.trust.validatedRepository;
    if (workspace === null || validated === null) throw new Error("expected Active + Workspace");
    expect(workspace.canonicalRoot).toBe(repo.root);
    expect(workspace.commonGitDir).toBe(join(repo.root, ".git"));
    expect(workspace.headCommitSha).toBe(repo.head);
    expect(workspace.currentBranch).toBe("main");
    expect(workspace.gitVersion).toMatch(/^git version \d+\.\d+/);
    // Workspace binding mirrors the frozen ValidatedRepository (RT-REPO-03)
    expect(workspace.headCommitSha).toBe(validated.headCommitSha);
    expect(workspace.commonGitDir).toBe(validated.commonGitDir);
    expect(workspace.defaultBaseRef).toBe(validated.defaultBaseRef);
    expect(w.gitCalls.length).toBeGreaterThan(0); // Git runs only now
  });

  it("imports a detached HEAD with currentBranch null (RT-REPO-04)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    setupGit(["checkout", "--detach", repo.head], repo.root);
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);

    const outcome = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(outcome.trust.state).toBe("Active");
    expect(mustWorkspace(outcome).currentBranch).toBeNull();
    expect(mustWorkspace(outcome).headCommitSha).toBe(repo.head);
  });

  it("not-a-repository is an ordinary failure: PendingValidation kept, failure recorded, retry can succeed (SV1-TRUST-08)", async () => {
    const root = await tempRoot();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, plain);

    const failed = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(failureOf(failed)).toMatchObject({
      kind: "RepositoryInvalid",
      reason: "not-a-repository",
    });
    expect(failed.trust.state).toBe("PendingValidation");
    expect(failed.workspace).toBeNull();
    expect(failed.trust.validationFailure).toMatchObject({ reason: "not-a-repository" });

    // fix the candidate in place (same directory, same inode) and retry
    setupGit(["init", "--initial-branch=main"], plain);
    writeFileSync(join(plain, "README.md"), "fixed\n");
    setupGit([...IDENTITY, "add", "README.md"], plain);
    setupGit([...IDENTITY, "commit", "-m", "init"], plain);
    const retried = await w.service.validateAndActivate(cmd("validate2"), trust.trustId);
    expect(retried.trust.state).toBe("Active");
    expect(retried.workspace).not.toBeNull();
  });

  it("bare and unborn-head are ordinary failures that keep PendingValidation", async () => {
    const root = await tempRoot();
    const bareDir = join(root, "bare.git");
    mkdirSync(bareDir);
    setupGit(["init", "--bare"], bareDir);
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, bareDir);
    const bare = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(failureOf(bare)).toMatchObject({ kind: "UnsupportedRepository", reason: "bare" });
    expect(bare.trust.state).toBe("PendingValidation");

    const unbornDir = join(root, "unborn");
    mkdirSync(unbornDir);
    setupGit(["init", "--initial-branch=main"], unbornDir);
    const pending2 = await grantPendingTrust(w, unbornDir);
    const unborn = await w.service.validateAndActivate(cmd("validate2"), pending2.trust.trustId);
    expect(failureOf(unborn)).toMatchObject({
      kind: "UnsupportedRepository",
      reason: "unborn-head",
    });
    expect(unborn.trust.state).toBe("PendingValidation");
  });

  it("a corrupt repository keeps PendingValidation with the corrupt failure recorded", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    await appendFile(join(repo.root, ".git", "config"), "[core\nbroken\n");

    const outcome = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(failureOf(outcome)).toMatchObject({ kind: "RepositoryInvalid", reason: "corrupt" });
    expect(outcome.trust.state).toBe("PendingValidation");
    expect(outcome.workspace).toBeNull();
  });

  it("root-mismatch revokes the trust version and creates no Workspace (RT-REPO-05)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const sub = join(repo.root, "src");
    mkdirSync(sub);
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, sub);

    const outcome = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(failureOf(outcome)).toMatchObject({
      kind: "UnsupportedRepository",
      reason: "root-mismatch",
    });
    expect(outcome.trust.state).toBe("Revoked");
    expect(outcome.workspace).toBeNull();
    expect(w.store.liveTrustForRoot(await realpath(sub))).toBeNull();
  });

  it("identity drift before validation revokes without invoking Git (RT-REPO-05)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    const callsBefore = w.gitCalls.length;

    // the confirmed directory is replaced (new inode) before validation runs
    await rm(repo.root, { recursive: true, force: true });
    await makeRepo(repo.root);

    const outcome = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    expect(failureOf(outcome)).toMatchObject({
      kind: "RepositoryInvalid",
      reason: "identity-drift",
    });
    expect(outcome.trust.state).toBe("Revoked");
    expect(outcome.workspace).toBeNull();
    expect(w.gitCalls.length).toBe(callsBefore); // drift fails closed before Git
  });

  it("re-grant after a revocation creates a new trust_version that can activate (RT-REPO-05)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const first = await grantPendingTrust(w, repo.root);
    await rm(repo.root, { recursive: true, force: true });
    await makeRepo(repo.root);
    const revoked = await w.service.validateAndActivate(cmd("validate"), first.trust.trustId);
    expect(revoked.trust.state).toBe("Revoked");

    // re-grant the same candidate root: new challenge, new receipt, new version
    const second = await grantPendingTrust(w, repo.root);
    expect(second.trust.trustVersion).toBe(2);
    const outcome = await w.service.validateAndActivate(cmd("validate2"), second.trust.trustId);
    expect(outcome.trust.state).toBe("Active");
    expect(w.store.listTrustVersions(repo.root).map((t) => t.state)).toEqual(["Revoked", "Active"]);
  });
});

// --- revoke + inspection --------------------------------------------------------

describe("revokeTrust / inspectRepository (RT-REPO-04/05, SV1-TRUST-05)", () => {
  it("revoke of an Active Trust keeps the Workspace but marks it not runnable; repeat revoke is a no-op", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    const activated = await w.service.validateAndActivate(cmd("validate"), trust.trustId);

    const revoked = w.service.revokeTrust(cmd("revoke"), trust.trustId);
    expect(revoked.state).toBe("Revoked");
    const view = w.service.getWorkspaceWithTrust(mustWorkspace(activated).workspaceId);
    expect(view.trust.state).toBe("Revoked"); // workspace row kept, trust revoked

    const again = w.service.revokeTrust(cmd("revoke2"), trust.trustId);
    expect(again.state).toBe("Revoked");
    expect(again.trustVersion).toBe(revoked.trustVersion);
  });

  it("revoke of a PendingValidation Trust is Revoked and terminal", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    const revoked = w.service.revokeTrust(cmd("revoke"), trust.trustId);
    expect(revoked.state).toBe("Revoked");
    await expect(
      w.service.validateAndActivate(cmd("validate"), trust.trustId),
    ).rejects.toThrowError(expect.objectContaining({ code: "Conflict" }));
    expect(w.gitCalls).toEqual([]); // no Git on a revoked trust
  });

  it("inspectRepository returns the declared read-only facts while Active (RT-REPO-04)", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    const activated = await w.service.validateAndActivate(cmd("validate"), trust.trustId);

    const inspection = await w.service.inspectRepository(mustWorkspace(activated).workspaceId);
    expect(inspection.currentCommitSha).toBe(repo.head);
    expect(inspection.currentBranch).toBe("main");
    expect(inspection.defaultBaseRef).toBeNull(); // never guessed
    expect(inspection.commonGitDir).toBe(join(repo.root, ".git"));
    expect(inspection.observedAt).toBeTypeOf("string");
  });

  it("inspectRepository refuses a revoked Trust and reports drift as a stable error without changing state", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);
    const activated = await w.service.validateAndActivate(cmd("validate"), trust.trustId);
    const workspaceId = mustWorkspace(activated).workspaceId;

    // identity drift: stable error, trust state untouched
    await rm(repo.root, { recursive: true, force: true });
    await makeRepo(repo.root);
    await expect(w.service.inspectRepository(workspaceId)).rejects.toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    expect(w.service.getTrust(trust.trustId).state).toBe("Active"); // no silent state change

    w.service.revokeTrust(cmd("revoke"), trust.trustId);
    await expect(w.service.inspectRepository(workspaceId)).rejects.toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
  });
});

// --- command idempotency (RT-CMD-02/03) -----------------------------------------

describe("command idempotency (RT-CMD-02/03)", () => {
  it("a replayed validateAndActivate commandId returns the original outcome without re-running Git", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const { trust } = await grantPendingTrust(w, repo.root);

    const validateCmd = cmd("validate");
    const first = await w.service.validateAndActivate(validateCmd, trust.trustId);
    const callsAfterFirst = w.gitCalls.length;
    const replayed = await w.service.validateAndActivate(validateCmd, trust.trustId);
    expect(replayed).toEqual(first);
    expect(w.gitCalls.length).toBe(callsAfterFirst); // replay never re-executes
  });

  it("a replayed confirmTrust commandId returns the original record without re-consuming", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const challenge = w.service.issueTrustChallenge(cmd("ch"), {
      candidate,
      userIdentity: USER,
      ...CHALLENGE_DISPLAY,
    });
    const receipt = signFor(challenge);
    const confirmCmd = cmd("confirm");
    const first = await w.service.confirmTrust(confirmCmd, candidate, receipt, USER);
    const replayed = await w.service.confirmTrust(confirmCmd, candidate, receipt, USER);
    expect(replayed).toEqual(first); // not already-consumed: the replay short-circuits
    expect(w.store.listTrustVersions(repo.root)).toHaveLength(1);
  });

  it("the same commandId with a different payload is IdempotencyConflict before any side effect", async () => {
    const root = await tempRoot();
    const repo = await makeRepo(join(root, "repo"));
    const w = await wire(root);
    const candidate = await w.service.prepareCandidate(cmd("prep"), repo.root);
    const challenge = w.service.issueTrustChallenge(cmd("ch"), {
      candidate,
      userIdentity: USER,
      ...CHALLENGE_DISPLAY,
    });
    const confirmCmd = cmd("confirm");
    await w.service.confirmTrust(confirmCmd, candidate, signFor(challenge), "uid:501");
    // same commandId, different userIdentity payload -> conflict, no Git, no new row
    await expect(
      w.service.confirmTrust(confirmCmd, candidate, signFor(challenge), "uid:999"),
    ).rejects.toThrowError(expect.objectContaining({ code: "IdempotencyConflict" }));
    expect(w.gitCalls).toEqual([]);
    expect(w.store.listTrustVersions(repo.root)).toHaveLength(1);
  });

  it("validateAndActivate on an unknown trust is NotFound and runs no Git", async () => {
    const root = await tempRoot();
    const w = await wire(root);
    await expect(w.service.validateAndActivate(cmd("validate"), "rt_missing")).rejects.toThrowError(
      expect.objectContaining({ code: "NotFound" }),
    );
    expect(w.gitCalls).toEqual([]);
  });
});

const failureOf = (outcome: { failure: unknown }) => {
  if (outcome.failure === null) expect.unreachable("expected a validation failure");
  return outcome.failure as Record<string, unknown>;
};

const mustWorkspace = (outcome: ValidationOutcome): WorkspaceRecord => {
  if (outcome.workspace === null) throw new Error("expected a Workspace");
  return outcome.workspace;
};
