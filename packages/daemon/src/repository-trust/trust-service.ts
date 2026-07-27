// RT-REPO-01..06 + RT-CMD-02/03 — Repository Trust orchestration service.
//
// The full Trust chain (issue #46), daemon side:
//
//   prepareCandidate        RT-REPO-01 — canonicalize + stat only; this path
//                           cannot spawn (readRepositoryCandidateMetadata has
//                           no exec capability by construction, SV1-TRUST-04).
//   issueTrustChallenge     RT-REPO-06 — one-time challenge whose display and
//                           bound facts carry the candidate identity, the user
//                           identity and the frozen VALIDATION_PLAN. Creates
//                           NO trust row and calls NO Git.
//   confirmTrust            consume the Main-signed receipt (fail closed to
//                           ConfirmationRequired on forgery / replay / expiry /
//                           cross-kind / drift), re-canonicalize + stat inside
//                           the same transaction, then create the
//                           PendingValidation row. Still NO Git (SV1-TRUST-04).
//   validateAndActivate     the only Git entry point: the restricted
//                           RT-REPO-02 plan. Success flips Active + creates
//                           the Workspace + Repository binding in ONE
//                           transaction (RT-REPO-03); ordinary failures keep
//                           PendingValidation with the recorded failure
//                           (SV1-TRUST-08); root-mismatch / identity-drift
//                           revokes the trust version (RT-REPO-05).
//   revokeTrust             PendingValidation|Active -> Revoked; Revoked is
//                           terminal, repeat revoke is an idempotent no-op.
//                           The Workspace row is kept; its joined Trust state
//                           shows it is not runnable. Revocation never
//                           silently terminates non-terminal Attempts or
//                           their Alive Sessions: it blocks new Attempts (the
//                           runnable gate below) and requires the caller's
//                           explicit stop-or-keep choice, which is persisted
//                           on the trust row (SV1-TRUST-05). Executing a
//                           "stop" is the Session runtime's job (R1-05).
//   inspectRepository       RT-REPO-04 — Active-only, declared read-only
//                           queries (SV1-FILE-06). Root or commonGitDir
//                           identity drift revokes the Trust in one
//                           transaction (RT-REPO-05) and surfaces as a
//                           stable error; other failures change no state.
//
// Every mutating method is idempotent by commandId (RT-CMD-02): a replayed
// commandId with the same payload returns the original result without
// re-executing (in particular without re-running Git); the same commandId
// with a different payload is IdempotencyConflict (RT-CMD-03). The idempotency
// lookup runs BEFORE any side effect, and the state writes, the challenge
// consume mark and the idempotency record commit in one transaction
// (RT-STO-01). Methods that await between the lookup and the transaction
// (validateAndActivate's Git run) are additionally serialized per target by
// an in-process keyed mutex, and re-check the idempotency record and the
// state assertion after entering the critical section — a concurrent same
// -commandId request gets the first finisher's original result and never
// re-runs Git (SV1-TRUST-08: one bounded, idempotent validation).

import { lstatSync, realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConfirmationChallenge,
  ConfirmationReceipt,
  PermissionMode,
} from "@agents-fleet/contracts";
import { hashPreviewFact } from "../confirmation/challenge-issuer.js";
import type { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import {
  type RepositoryCandidate,
  type RepositoryInspection,
  type RepositoryValidationFailure,
  type RestrictedGitRunner,
  readRepositoryCandidateMetadata,
  VALIDATION_PLAN,
} from "../git/restricted-git.js";
import {
  executeIdempotent,
  hashCommandPayload,
  type IdempotencyStore,
} from "../storage/idempotency.js";
import {
  type NonTerminalAttempt,
  type RepositoryTrustRecord,
  RepositoryTrustStore,
  type WorkspaceDefaults,
  type WorkspaceRecord,
} from "../storage/repository-trust-store.js";
import { StoreError } from "../storage/task-store.js";

export interface TrustServiceOptions {
  readonly db: DatabaseSync;
  readonly challenges: PersistentChallengeIssuer;
  readonly idem: IdempotencyStore;
  readonly runner: RestrictedGitRunner;
  readonly now?: () => number;
}

export interface TrustChallengeRequest {
  readonly candidate: RepositoryCandidate;
  readonly userIdentity: string;
  /** Display-only: which Agent the user plans to run (SV1-TRUST-02). */
  readonly plannedAgent: string;
  /** Display-only: where Fleet keeps this Workspace's data (SV1-TRUST-02). */
  readonly dataLocation: string;
  /** Display-only: the upper bound of Host permissions an Agent may get (SV1-TRUST-02). */
  readonly hostPermissionUpperBound: string;
}

export interface ValidationOutcome {
  readonly trust: RepositoryTrustRecord;
  /** Set exactly when the Trust went Active (RT-REPO-03). */
  readonly workspace: WorkspaceRecord | null;
  /** Set when validation failed or revoked the trust version. */
  readonly failure: RepositoryValidationFailure | null;
}

/** SV1-TRUST-05 — the user's choice for processes that may still be running at revocation. */
export type RunningProcessChoice = "stop" | "keep";

export interface RevocationOutcome {
  readonly trust: RepositoryTrustRecord;
  /** Non-terminal Attempts of the Trust's Workspaces at revocation time (SV1-TRUST-05). */
  readonly affectedAttempts: readonly NonTerminalAttempt[];
  /** The stop-or-keep choice the revocation carried; null when none was required. */
  readonly processChoice: RunningProcessChoice | null;
}

const IDEM_TARGET_TYPE = "repository-trust";

// SV1-TRUST-08 — in-process keyed async mutex. It serializes the whole
// "idempotency lookup -> await Git -> command transaction" flow per target,
// so two concurrent requests for the same target cannot both run the bounded
// Git plan: the later one enters the critical section after the first
// commits and short-circuits on the idempotency record. Cross-process
// serialization is the database's job (unique indexes + transactions).
class KeyedAsyncMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.#tails.get(key) ?? Promise.resolve();
    const result = tail.then(fn);
    // The chain must survive a rejected critical section, and the map entry
    // is dropped once it is the settled tail, keeping the map bounded.
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, next);
    void next.then(() => {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    });
    return await result;
  }
}

// The facts the RT-REPO-06 challenge binds. Everything here is recomputable
// from (candidate, userIdentity) alone, so confirmTrust can re-derive the
// current hashes at execution time and any drift is binding-drift
// (RT-CMD-08/16). The plannedAgent / dataLocation / hostPermissionUpperBound
// display fields are Daemon-produced dialog text (SV1-TRUST-02), not bound
// facts — the bound plan and identity are what the receipt authorizes.
const trustPreviewFacts = (candidate: RepositoryCandidate, userIdentity: string) => ({
  payload: {
    kind: "repository-trust",
    canonicalRoot: candidate.canonicalRoot,
    filesystemIdentity: candidate.filesystemIdentity,
    userIdentity,
    validationPlan: VALIDATION_PLAN,
  },
  bindingFacts: [
    {
      canonicalRoot: candidate.canonicalRoot,
      filesystemIdentity: candidate.filesystemIdentity,
    },
    { userIdentity },
    { validationPlan: VALIDATION_PLAN },
  ],
  impactSummary: {
    impactClass: "reversible",
    summary:
      "Grants a PendingValidation Repository Trust and runs the frozen restricted Git validation plan. No Agent starts and no Workspace is created before validation succeeds.",
  },
});

const currentTrustHashes = (candidate: RepositoryCandidate, userIdentity: string) => {
  const facts = trustPreviewFacts(candidate, userIdentity);
  return {
    payloadHash: hashPreviewFact(facts.payload),
    bindingHashes: facts.bindingFacts.map(hashPreviewFact),
    impactSummaryHash: hashPreviewFact(facts.impactSummary),
  };
};

// RT-REPO-06 drift rule — re-canonicalize + stat at execution time, inside
// the command transaction. Any replacement or identity change rejects with
// ConfirmationRequired and the whole transaction (including the challenge
// consume mark) rolls back: nothing is created and no Git runs.
const restatCandidate = (candidate: RepositoryCandidate): void => {
  let canonicalAgain: string;
  let st: ReturnType<typeof lstatSync>;
  try {
    canonicalAgain = realpathSync(candidate.canonicalRoot);
    st = lstatSync(candidate.canonicalRoot);
  } catch (e) {
    throw new StoreError(
      "ConfirmationRequired",
      `candidate root cannot be re-verified: ${(e as Error).message}`,
    );
  }
  if (canonicalAgain !== candidate.canonicalRoot) {
    throw new StoreError(
      "ConfirmationRequired",
      `candidate root moved: ${candidate.canonicalRoot} -> ${canonicalAgain}`,
    );
  }
  if (
    !st.isDirectory() ||
    st.dev !== candidate.filesystemIdentity.dev ||
    st.ino !== candidate.filesystemIdentity.ino
  ) {
    throw new StoreError(
      "ConfirmationRequired",
      "candidate filesystem identity changed since the challenge was issued",
    );
  }
};

export class TrustService {
  readonly #db: DatabaseSync;
  readonly #challenges: PersistentChallengeIssuer;
  readonly #idem: IdempotencyStore;
  readonly #runner: RestrictedGitRunner;
  readonly #store: RepositoryTrustStore;
  readonly #mutex = new KeyedAsyncMutex();

  constructor(options: TrustServiceOptions) {
    this.#db = options.db;
    this.#challenges = options.challenges;
    this.#idem = options.idem;
    this.#runner = options.runner;
    this.#store = new RepositoryTrustStore(options.db, options.now);
  }

  getTrust(trustId: string): RepositoryTrustRecord {
    return this.#store.getTrust(trustId);
  }

  getWorkspaceWithTrust(workspaceId: string): {
    workspace: WorkspaceRecord;
    trust: RepositoryTrustRecord;
  } {
    return this.#store.getWorkspaceWithTrust(workspaceId);
  }

  // RT-REPO-01 — pre-Trust the candidate is only canonical path + filesystem
  // identity. No Git, no shell, no Repository content (RT-ENV-01 /
  // SV1-TRUST-04): readRepositoryCandidateMetadata cannot spawn by
  // construction.
  async prepareCandidate(commandId: string, path: string): Promise<RepositoryCandidate> {
    const payload = { path };
    const hit = this.#idem.lookup(commandId, hashCommandPayload(payload));
    if (hit !== null) return hit as RepositoryCandidate;
    const candidate = await readRepositoryCandidateMetadata(path);
    return executeIdempotent(
      this.#db,
      this.#idem,
      {
        commandId,
        payload,
        target: { type: IDEM_TARGET_TYPE, id: candidate.canonicalRoot },
      },
      () => candidate,
    );
  }

  // RT-REPO-06 — issue the one-time Trust challenge. The dialog renders only
  // these Daemon-produced display fields (SV1-TRUST-02/09/10); the receipt
  // binds candidate identity + user identity + the frozen validation plan.
  // Creates no trust row and calls no Git.
  issueTrustChallenge(commandId: string, request: TrustChallengeRequest): ConfirmationChallenge {
    const { candidate, userIdentity } = request;
    const facts = trustPreviewFacts(candidate, userIdentity);
    const validationPlanHash = hashPreviewFact(VALIDATION_PLAN);
    return executeIdempotent(
      this.#db,
      this.#idem,
      {
        commandId,
        payload: request,
        target: { type: IDEM_TARGET_TYPE, id: candidate.canonicalRoot },
      },
      () =>
        this.#challenges.issue({
          kind: "repository-trust",
          display: {
            title: "Grant Repository Trust",
            fields: [
              { label: "Repository", value: candidate.canonicalRoot },
              {
                label: "Filesystem identity",
                value: `dev=${candidate.filesystemIdentity.dev} ino=${candidate.filesystemIdentity.ino}`,
              },
              { label: "User identity", value: userIdentity },
              { label: "Planned Agent", value: request.plannedAgent },
              { label: "Data location", value: request.dataLocation },
              {
                label: "Host permission upper bound",
                value: request.hostPermissionUpperBound,
              },
              ...VALIDATION_PLAN.map((step, i) => ({
                label: `Validation plan ${i + 1}/${VALIDATION_PLAN.length}`,
                value: `git ${step.argv.join(" ")}`,
              })),
              { label: "Validation plan hash", value: validationPlanHash },
              {
                label: "Not verified yet",
                value:
                  "Agent version, permission mapping, baseCommitSha and Repository scripts are not verified at this step (SV1-TRUST-02).",
              },
            ],
          },
          payload: facts.payload,
          bindingFacts: facts.bindingFacts,
          impactSummary: facts.impactSummary,
        }),
    );
  }

  // RT-REPO-06 — consume the Main-signed receipt and enter PendingValidation.
  // Forged / replayed / expired / cross-kind / drifted receipts fail closed to
  // ConfirmationRequired; nothing is created and no Git runs on any failure
  // (SV1-TRUST-04, SV1-T-29). The consume mark, the drift re-check and the
  // PendingValidation row commit in one transaction (RT-STO-01).
  async confirmTrust(
    commandId: string,
    candidate: RepositoryCandidate,
    receipt: ConfirmationReceipt,
    userIdentity: string,
  ): Promise<RepositoryTrustRecord> {
    const payload = { candidate, receipt, userIdentity };
    const hit = this.#idem.lookup(commandId, hashCommandPayload(payload));
    if (hit !== null) return hit as RepositoryTrustRecord;
    return executeIdempotent(
      this.#db,
      this.#idem,
      {
        commandId,
        payload,
        target: { type: IDEM_TARGET_TYPE, id: candidate.canonicalRoot },
      },
      () => {
        const consumed = this.#challenges.consume(
          receipt,
          "repository-trust",
          currentTrustHashes(candidate, userIdentity),
        );
        if (!consumed.ok) {
          throw new StoreError(
            "ConfirmationRequired",
            `repository trust receipt rejected: ${consumed.reason}`,
          );
        }
        restatCandidate(candidate);
        return this.#store.createPendingTrust({
          candidate,
          userIdentity,
          challengeId: receipt.challengeId,
        });
      },
    );
  }

  // RT-REPO-02/03/05 — run the restricted validation plan and settle the
  // outcome in one transaction. A replayed commandId returns the original
  // outcome WITHOUT re-running Git (RT-CMD-02). The whole flow is serialized
  // per trustId (SV1-TRUST-08): after entering the critical section the
  // idempotency record and the PendingValidation assertion are re-checked, so
  // a concurrent same-commandId request gets the first finisher's original
  // result and never runs a second Git plan.
  async validateAndActivate(commandId: string, trustId: string): Promise<ValidationOutcome> {
    return await this.#mutex.run(`validate:${trustId}`, async () => {
      const payload = { trustId };
      const hit = this.#idem.lookup(commandId, hashCommandPayload(payload));
      if (hit !== null) return hit as ValidationOutcome;
      const trust = this.#store.getTrust(trustId);
      if (trust.state !== "PendingValidation") {
        throw new StoreError("Conflict", `cannot validate a ${trust.state} Repository Trust`);
      }
      const result = await this.#runner.validateRepository({
        canonicalRoot: trust.candidateCanonicalRoot,
        filesystemIdentity: trust.filesystemIdentity,
      });
      return executeIdempotent(
        this.#db,
        this.#idem,
        { commandId, payload, target: { type: IDEM_TARGET_TYPE, id: trustId } },
        () => {
          // Re-assert inside the command transaction: nothing between the Git
          // run and the commit may have moved the Trust off PendingValidation.
          const current = this.#store.getTrust(trustId);
          if (current.state !== "PendingValidation") {
            throw new StoreError("Conflict", `cannot validate a ${current.state} Repository Trust`);
          }
          if (result.ok) {
            const { trust: active, workspace } = this.#store.activateWithWorkspace(
              trustId,
              result.repository,
            );
            return { trust: active, workspace, failure: null };
          }
          const failure = result.failure;
          // RT-REPO-05 / SV1-TRUST-08 — root-mismatch or confirmed-identity
          // drift revokes this trust version (no Workspace is created);
          // anything else keeps PendingValidation for an idempotent retry.
          if (failure.reason === "root-mismatch" || failure.reason === "identity-drift") {
            return { trust: this.#store.markRevoked(trustId, failure), workspace: null, failure };
          }
          return {
            trust: this.#store.recordValidationFailure(trustId, failure),
            workspace: null,
            failure,
          };
        },
      );
    });
  }

  // RT-REPO-05 / SV1-TRUST-05 — user revoke. Revoked is terminal; repeating
  // the revoke is an idempotent no-op that returns the revoked record. The
  // Workspace row is deliberately kept, and revocation never silently
  // terminates non-terminal Attempts or their Alive Sessions: when any exist,
  // the caller MUST pass the user's explicit stop-or-keep choice (missing
  // choice -> ConfirmationRequired, nothing is written). The choice and the
  // affected Attempt list are the revocation outcome; the choice is also
  // persisted on the trust row. This slice performs no actual process
  // termination — the Session runtime (R1-05) executes a persisted "stop";
  // Alive Sessions are likewise not queryable until R1-05.
  revokeTrust(
    commandId: string,
    trustId: string,
    runningProcessChoice?: RunningProcessChoice,
  ): RevocationOutcome {
    return executeIdempotent(
      this.#db,
      this.#idem,
      {
        commandId,
        payload: { trustId, runningProcessChoice: runningProcessChoice ?? null },
        target: { type: IDEM_TARGET_TYPE, id: trustId },
      },
      () => {
        const trust = this.#store.getTrust(trustId);
        if (trust.state === "Revoked") {
          return {
            trust,
            affectedAttempts: [],
            processChoice: trust.revocationProcessChoice,
          };
        }
        const affected = this.#store.listNonTerminalAttemptsForTrust(trustId);
        if (affected.length > 0 && runningProcessChoice === undefined) {
          throw new StoreError(
            "ConfirmationRequired",
            `revoking this Repository Trust leaves ${affected.length} non-terminal Attempt(s) that may still be running; an explicit stop-or-keep choice is required (SV1-TRUST-05)`,
          );
        }
        const revoked = this.#store.markRevoked(trustId, undefined, runningProcessChoice);
        return {
          trust: revoked,
          affectedAttempts: affected,
          processChoice: revoked.revocationProcessChoice,
        };
      },
    );
  }

  // SV1-TRUST-05 — the new-Attempt gate: a Workspace is runnable exactly when
  // its bound Repository Trust is Active. The R1-07 start-command path must
  // call this before creating any Attempt for the Workspace; TaskStore stays
  // deliberately trust-agnostic, so the gate lives here at the trust layer.
  assertWorkspaceRunnable(workspaceId: string): void {
    const { trust } = this.#store.getWorkspaceWithTrust(workspaceId);
    if (trust.state !== "Active") {
      throw new StoreError(
        "Conflict",
        `workspace ${workspaceId} is not runnable: Repository Trust is ${trust.state}`,
      );
    }
  }

  // RT-OWN-01 — update a Workspace's default selections (default Agent, base
  // branch, permission mode). Idempotent by commandId, merge-patched over the
  // stored defaults, permission mode restricted to the contracts enum, and
  // allowed only while the bound Trust is Active.
  updateWorkspaceDefaults(
    commandId: string,
    workspaceId: string,
    patch: Partial<WorkspaceDefaults>,
  ): WorkspaceRecord {
    const PERMISSION_MODES: readonly PermissionMode[] = ["Manual", "Balanced", "YOLO"];
    for (const key of Object.keys(patch)) {
      if (!["agentId", "baseBranch", "permissionMode"].includes(key)) {
        throw new StoreError("InvalidRequest", `unknown workspace defaults field: ${key}`);
      }
    }
    if (patch.permissionMode !== undefined && !PERMISSION_MODES.includes(patch.permissionMode)) {
      throw new StoreError(
        "InvalidRequest",
        `unknown permission mode: ${patch.permissionMode as string}`,
      );
    }
    return executeIdempotent(
      this.#db,
      this.#idem,
      {
        commandId,
        payload: { workspaceId, patch },
        target: { type: "workspace", id: workspaceId },
      },
      () => {
        const { workspace, trust } = this.#store.getWorkspaceWithTrust(workspaceId);
        if (trust.state !== "Active") {
          throw new StoreError(
            "Conflict",
            `cannot update defaults of a workspace whose Repository Trust is ${trust.state}`,
          );
        }
        return this.#store.updateWorkspaceDefaults(workspaceId, {
          agentId: patch.agentId === undefined ? workspace.defaults.agentId : patch.agentId,
          baseBranch:
            patch.baseBranch === undefined ? workspace.defaults.baseBranch : patch.baseBranch,
          permissionMode: patch.permissionMode ?? workspace.defaults.permissionMode,
        });
      },
    );
  }

  // RT-REPO-04 — inspection is allowed only while the bound Trust is Active
  // and runs only the declared read-only queries (SV1-FILE-06). Root or
  // commonGitDir identity drift revokes the Trust in one transaction
  // (RT-REPO-05: bound-identity drift turns Active into Revoked) and
  // surfaces as a stable error; the Workspace row is kept and, joined with
  // the now-Revoked Trust, is not runnable. Ordinary inspection failures
  // change no state.
  async inspectRepository(workspaceId: string): Promise<RepositoryInspection> {
    const { workspace, trust } = this.#store.getWorkspaceWithTrust(workspaceId);
    if (trust.state !== "Active") {
      throw new StoreError(
        "Conflict",
        `repository inspection requires an Active Repository Trust, got ${trust.state}`,
      );
    }
    const result = await this.#runner.inspectValidatedRepository(
      {
        canonicalRoot: trust.candidateCanonicalRoot,
        filesystemIdentity: trust.filesystemIdentity,
      },
      {
        commonGitDir: workspace.commonGitDir,
        commonGitDirIdentity: workspace.commonGitDirIdentity,
      },
    );
    if (!result.ok) {
      const failure = result.failure;
      // RT-REPO-05 — bound-identity drift revokes; anything else is a stable
      // error with no state change.
      if (failure.reason === "identity-drift" || failure.reason === "root-mismatch") {
        this.#store.markRevoked(trust.trustId, failure);
      }
      throw new StoreError(
        "Conflict",
        `repository inspection failed: ${failure.kind}/${failure.reason}: ${failure.detail}`,
      );
    }
    return result.inspection;
  }
}
