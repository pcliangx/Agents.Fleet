// R1-02 — RepositoryTrustStore: the persisted RT-REPO-05 state machine
// (Untrusted never stored; PendingValidation -> Active -> Revoked, Revoked
// terminal), re-grant versioning, one live Trust per candidate root, and the
// atomic Active + Workspace write (RT-REPO-03).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ValidatedRepository } from "../git/restricted-git.js";
import { openDatabase } from "../storage/database.js";
import {
  REPOSITORY_TRUST_MIGRATIONS,
  RepositoryTrustStore,
} from "../storage/repository-trust-store.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const T0 = 1_800_000_000_000;

const CANDIDATE = {
  canonicalRoot: "/repo/a",
  filesystemIdentity: { dev: 16777233, ino: 42_001 },
} as const;

const VALIDATED: ValidatedRepository = {
  workingTreeRoot: "/repo/a",
  gitDir: "/repo/a/.git",
  commonGitDir: "/repo/a/.git",
  headCommitSha: "a".repeat(40),
  currentBranch: "main",
  defaultBaseRef: "refs/remotes/origin/main",
  defaultBaseRefSha: "b".repeat(40),
  gitVersion: "git version 2.50.1",
  observedAt: new Date(T0).toISOString(),
};

const makeStore = (): RepositoryTrustStore => {
  dir = mkdtempSync(join(tmpdir(), "af-r102-store-"));
  const result = openDatabase({
    path: join(dir, "fleet.db"),
    migrations: REPOSITORY_TRUST_MIGRATIONS,
    now: () => T0,
  });
  if (result.kind !== "ready") throw new Error("db not ready");
  return new RepositoryTrustStore(result.db, () => T0);
};

const createPending = (store: RepositoryTrustStore) =>
  store.createPendingTrust({
    candidate: CANDIDATE,
    userIdentity: "uid:501",
    challengeId: "ch_test",
  });

describe("RepositoryTrustStore state machine (RT-REPO-05)", () => {
  it("first confirmation creates PendingValidation with trust_version 1; Untrusted is never stored", () => {
    const store = makeStore();
    expect(store.liveTrustForRoot(CANDIDATE.canonicalRoot)).toBeNull(); // Untrusted = no row
    const trust = createPending(store);
    expect(trust.state).toBe("PendingValidation");
    expect(trust.trustVersion).toBe(1);
    expect(trust.validatedRepository).toBeNull();
    expect(trust.validationFailure).toBeNull();
  });

  it("rejects a second live Trust for the same candidate root", () => {
    const store = makeStore();
    createPending(store);
    expect(() => createPending(store)).toThrowError(expect.objectContaining({ code: "Conflict" }));
  });

  it("activateWithWorkspace flips Active and binds the Workspace in one transaction (RT-REPO-03)", () => {
    const store = makeStore();
    const trust = createPending(store);
    const { trust: active, workspace } = store.activateWithWorkspace(trust.trustId, VALIDATED);
    expect(active.state).toBe("Active");
    expect(active.validatedRepository).toEqual(VALIDATED);
    expect(workspace.trustId).toBe(trust.trustId);
    expect(workspace.canonicalRoot).toBe(VALIDATED.workingTreeRoot);
    expect(workspace.commonGitDir).toBe(VALIDATED.commonGitDir);
    expect(workspace.headCommitSha).toBe(VALIDATED.headCommitSha);
    expect(workspace.currentBranch).toBe("main");
    expect(workspace.defaultBaseRef).toBe("refs/remotes/origin/main");
    expect(workspace.defaultBaseRefSha).toBe(VALIDATED.defaultBaseRefSha);
    expect(workspace.gitVersion).toBe(VALIDATED.gitVersion);
    expect(store.getWorkspaceWithTrust(workspace.workspaceId).trust.state).toBe("Active");
  });

  it("illegal transitions are Conflict: Active cannot re-activate, Revoked is terminal", () => {
    const store = makeStore();
    const trust = createPending(store);
    store.activateWithWorkspace(trust.trustId, VALIDATED);
    expect(() => store.activateWithWorkspace(trust.trustId, VALIDATED)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    store.markRevoked(trust.trustId);
    expect(() => store.markRevoked(trust.trustId)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    expect(() => store.activateWithWorkspace(trust.trustId, VALIDATED)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    // recording a validation failure is only meaningful while PendingValidation
    expect(() =>
      store.recordValidationFailure(trust.trustId, {
        kind: "RepositoryInvalid",
        reason: "git-failed",
        detail: "x",
      }),
    ).toThrowError(expect.objectContaining({ code: "Conflict" }));
  });

  it("an ordinary validation failure keeps PendingValidation and records the failure (SV1-TRUST-08)", () => {
    const store = makeStore();
    const trust = createPending(store);
    const failure = {
      kind: "RepositoryInvalid",
      reason: "not-a-repository",
      detail: "no .git",
    } as const;
    const updated = store.recordValidationFailure(trust.trustId, failure);
    expect(updated.state).toBe("PendingValidation");
    expect(updated.validationFailure).toEqual(failure);
  });

  it("re-grant after revoke creates a new trust_version and keeps the revoked row (RT-REPO-05)", () => {
    const store = makeStore();
    const first = createPending(store);
    store.markRevoked(first.trustId);
    expect(store.liveTrustForRoot(CANDIDATE.canonicalRoot)).toBeNull();

    const second = createPending(store);
    expect(second.trustVersion).toBe(2);
    expect(second.trustId).not.toBe(first.trustId);
    expect(second.state).toBe("PendingValidation");

    const versions = store.listTrustVersions(CANDIDATE.canonicalRoot);
    expect(versions.map((v) => [v.trustVersion, v.state])).toEqual([
      [1, "Revoked"],
      [2, "PendingValidation"],
    ]);
  });

  it("revoke keeps the Workspace row; the joined Trust state shows it is not runnable (SV1-TRUST-05)", () => {
    const store = makeStore();
    const trust = createPending(store);
    const { workspace } = store.activateWithWorkspace(trust.trustId, VALIDATED);
    store.markRevoked(trust.trustId);
    const view = store.getWorkspaceWithTrust(workspace.workspaceId);
    expect(view.workspace.workspaceId).toBe(workspace.workspaceId); // row retained
    expect(view.trust.state).toBe("Revoked");
  });

  it("unknown ids are NotFound", () => {
    const store = makeStore();
    expect(() => store.getTrust("rt_missing")).toThrowError(
      expect.objectContaining({ code: "NotFound" }),
    );
    expect(() => store.getWorkspaceWithTrust("ws_missing")).toThrowError(
      expect.objectContaining({ code: "NotFound" }),
    );
  });
});
