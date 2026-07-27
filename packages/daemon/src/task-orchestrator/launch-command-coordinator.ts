// R1-07 — start/retry/resume command coordinator (RT-CMD-13..17,
// RT-WORKTREE-01..06, RT-OWN-05/08/09).
//
// Launch Confirmation planning is durable and secret-free. The challenge
// binds the authoritative Task/Profile/Adapter/Environment/Repository and
// Worktree facts. Execution revalidates those facts, consumes the receipt,
// creates the immutable Attempt snapshots and records the idempotent command
// in one SQLite transaction. New Worktree materialization remains behind the
// WorktreeManager deep-module seam.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentAdapter,
  AgentProfileSnapshot,
  ChallengeDisplay,
  CommandEnvelope,
  CommandId,
  ConfirmationChallenge,
  EnvironmentSnapshotRecord,
  HostEnvironment,
  LaunchCommandKind,
  LaunchCommandPayload,
  LaunchSpec,
  PlannedWorktreeSelection,
  WorktreeId,
  WorktreeManager,
  WorktreeMode,
  WorktreeTargetBinding,
} from "@agents-fleet/contracts";
import { ProcessDisposition } from "@agents-fleet/contracts";
import { type ChallengePreview, hashPreviewFact } from "../confirmation/challenge-issuer.js";
import type { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import type { RestrictedGitRunner } from "../git/restricted-git.js";
import type { AdapterSnapshotFacts, AgentProfileStore } from "../storage/agent-profile-store.js";
import { transact } from "../storage/database.js";
import { appendDomainEvent } from "../storage/domain-event-store.js";
import type { EnvironmentSnapshotStore } from "../storage/environment-snapshot-store.js";
import { hashCommandPayload, type IdempotencyStore } from "../storage/idempotency.js";
import type {
  RepositoryTrustRecord,
  RepositoryTrustStore,
  WorkspaceRecord,
} from "../storage/repository-trust-store.js";
import { type AttemptStatus, StoreError } from "../storage/task-store.js";
import type { WorktreeRecord, WorktreeStore } from "../storage/worktree-store.js";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const provisionCommandId = (commandId: CommandId): CommandId =>
  `${commandId}:provision` as CommandId;

interface TaskFacts {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly lifecycle: "Draft" | "Runnable" | "Cancelled";
  readonly specJson: string;
  readonly taskSpecVersion: number;
  readonly stateVersion: number;
}

interface AttemptFacts {
  readonly attemptId: string;
  readonly taskId: string;
  readonly status: AttemptStatus;
  readonly stateVersion: number;
}

interface LaunchPlan {
  readonly attemptId: string;
  readonly commandType: LaunchCommandKind;
  readonly targetCommandId: string;
  readonly task: TaskFacts;
  readonly sourceAttempt: AttemptFacts | null;
  readonly userIdentity: string;
  readonly trustId: string;
  readonly trustVersion: number;
  readonly repositoryIdentity: string;
  readonly normalizedCommand: LaunchCommandPayload;
  readonly worktreeTarget: WorktreeTargetBinding;
  readonly worktreeObservedState: WorktreeObservedState;
  readonly expectedStateFingerprint: string | null;
  readonly expectedClean: boolean;
  readonly profileSnapshot: AgentProfileSnapshot;
  readonly adapterFacts: AdapterSnapshotFacts;
  readonly environmentSnapshot: EnvironmentSnapshotRecord;
  readonly launchSpec: LaunchSpec;
}

type WorktreeObservedState =
  | {
      readonly kind: "Planned";
      readonly pathState: "not-materialized";
      readonly expectedClean: true;
    }
  | {
      readonly kind: "Existing";
      readonly observedAt: string;
      readonly branchName: string;
      readonly detached: false;
      readonly headSha: string;
      readonly baseSha: string;
      readonly stagedCount: number;
      readonly unstagedCount: number;
      readonly untrackedCount: number;
      readonly externallyOccupied: false;
    };

interface PlanRow {
  readonly challenge_id: string;
  readonly target_command_id: string;
  readonly command_type: LaunchCommandKind;
  readonly task_id: string;
  readonly source_attempt_id: string | null;
  readonly normalized_command_json: string;
  readonly plan_json: string;
  readonly preview_json: string;
}

export interface LaunchChallengeResult {
  readonly challenge: ConfirmationChallenge;
  readonly command: LaunchCommandPayload;
}

export interface LaunchCommandResult {
  readonly accepted: true;
  readonly commandType: LaunchCommandKind;
  readonly taskId: string;
  readonly attemptId: string;
  readonly worktreeId: WorktreeId;
  readonly worktreeMode: WorktreeMode;
}

export interface LaunchCommandCoordinatorOptions {
  readonly db: DatabaseSync;
  readonly idempotency: IdempotencyStore;
  readonly challenges: PersistentChallengeIssuer;
  readonly profiles: AgentProfileStore;
  readonly environments: EnvironmentSnapshotStore;
  readonly trustStore: RepositoryTrustStore;
  readonly worktreeStore: WorktreeStore;
  readonly worktrees: WorktreeManager;
  readonly git: Pick<RestrictedGitRunner, "verifyCommitObject">;
  readonly hostEnvironment: HostEnvironment;
  readonly adapterFor: (agentId: string) => AgentAdapter;
  readonly managedWorktreeRoot: string;
  readonly now?: () => number;
}

export class LaunchCommandCoordinator {
  readonly #db: DatabaseSync;
  readonly #idempotency: IdempotencyStore;
  readonly #challenges: PersistentChallengeIssuer;
  readonly #profiles: AgentProfileStore;
  readonly #environments: EnvironmentSnapshotStore;
  readonly #trustStore: RepositoryTrustStore;
  readonly #worktreeStore: WorktreeStore;
  readonly #worktrees: WorktreeManager;
  readonly #git: Pick<RestrictedGitRunner, "verifyCommitObject">;
  readonly #hostEnvironment: HostEnvironment;
  readonly #adapterFor: (agentId: string) => AgentAdapter;
  readonly #managedWorktreeRoot: string;
  readonly #now: () => number;

  constructor(options: LaunchCommandCoordinatorOptions) {
    if (!isAbsolute(options.managedWorktreeRoot)) {
      throw new StoreError("InvalidRequest", "managed Worktree root must be absolute");
    }
    this.#db = options.db;
    this.#idempotency = options.idempotency;
    this.#challenges = options.challenges;
    this.#profiles = options.profiles;
    this.#environments = options.environments;
    this.#trustStore = options.trustStore;
    this.#worktreeStore = options.worktreeStore;
    this.#worktrees = options.worktrees;
    this.#git = options.git;
    this.#hostEnvironment = options.hostEnvironment;
    this.#adapterFor = options.adapterFor;
    this.#managedWorktreeRoot = options.managedWorktreeRoot;
    this.#now = options.now ?? Date.now;
    mkdirSync(this.#managedWorktreeRoot, { recursive: true, mode: 0o700 });
  }

  async issueChallenge(
    envelope: CommandEnvelope,
    commandType: LaunchCommandKind,
    targetCommandId: string,
    requested: LaunchCommandPayload,
  ): Promise<LaunchChallengeResult> {
    const context = await this.#buildPlan(envelope, commandType, targetCommandId, requested);
    const preview = this.#preview(context);
    return transact(
      this.#db,
      () => {
        const challenge = this.#challenges.issue(preview);
        this.#db
          .prepare(
            `INSERT INTO launch_confirmation_plans
           (challenge_id, target_command_id, command_type, task_id, source_attempt_id,
            normalized_command_json, plan_json, preview_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            challenge.challengeId,
            targetCommandId,
            commandType,
            context.task.taskId,
            context.sourceAttempt?.attemptId ?? null,
            JSON.stringify(context.normalizedCommand),
            JSON.stringify(context),
            JSON.stringify(preview),
            new Date(this.#now()).toISOString(),
          );
        return { challenge, command: context.normalizedCommand };
      },
      this.#now,
    );
  }

  async execute(
    envelope: CommandEnvelope,
    commandType: LaunchCommandKind,
    requested: LaunchCommandPayload,
  ): Promise<LaunchCommandResult> {
    const target = this.#targetIdentities(envelope, commandType);
    const logicalPayload = {
      kind: commandType,
      ...target,
      command: requested,
    };
    const payloadHash = hashCommandPayload(logicalPayload);
    const replay = this.#idempotency.lookup(envelope.commandId, payloadHash);
    if (replay !== null) return replay as LaunchCommandResult;
    const receipt = envelope.launchConfirmationReceipt;
    if (receipt === undefined) {
      throw new StoreError(
        "ConfirmationRequired",
        `${commandType} requires envelope.launchConfirmationReceipt`,
      );
    }
    const row = this.#planRow(receipt.challengeId);
    if (
      row.target_command_id !== envelope.commandId ||
      row.command_type !== commandType ||
      row.task_id !== target.taskId ||
      row.source_attempt_id !== target.sourceAttemptId ||
      canonicalSha256(JSON.parse(row.normalized_command_json)) !== canonicalSha256(requested)
    ) {
      throw new StoreError(
        "ConfirmationRequired",
        "Launch Confirmation does not match this command or target",
      );
    }
    const plan = JSON.parse(row.plan_json) as LaunchPlan;
    const storedPreview = JSON.parse(row.preview_json) as ChallengePreview;
    await this.#revalidate(plan);

    const result = transact(
      this.#db,
      () => {
        const concurrentReplay = this.#idempotency.lookup(envelope.commandId, payloadHash);
        if (concurrentReplay !== null) return concurrentReplay as LaunchCommandResult;
        this.#revalidateDatabaseFacts(plan);
        const consumed = this.#challenges.consume(receipt, "launch", {
          payloadHash: hashPreviewFact(storedPreview.payload),
          bindingHashes: storedPreview.bindingFacts.map(hashPreviewFact),
          impactSummaryHash: hashPreviewFact(storedPreview.impactSummary),
        });
        if (!consumed.ok) {
          throw new StoreError(
            "ConfirmationRequired",
            `Launch Confirmation rejected: ${consumed.reason}`,
          );
        }
        this.#createAttempt(plan, envelope.commandId, receipt.challengeId);
        const persistedProfile = this.#profiles.createAttemptSnapshot({
          attemptId: plan.attemptId,
          profileId: plan.profileSnapshot.profileId,
          adapter: plan.adapterFacts,
        });
        if (canonicalSha256(persistedProfile) !== canonicalSha256(plan.profileSnapshot)) {
          throw new StoreError(
            "ConfirmationRequired",
            "Agent Profile snapshot changed after confirmation",
          );
        }
        this.#environments.createForAttempt(plan.attemptId, plan.environmentSnapshot);
        const worktreeId = plan.worktreeTarget.worktreeId;
        if (plan.worktreeTarget.kind === "Planned") {
          this.#worktreeStore.createPlanned({
            worktreeId,
            taskId: plan.task.taskId,
            attemptId: plan.attemptId,
            workspaceId: plan.task.workspaceId,
            canonicalPath: plan.worktreeTarget.canonicalPath,
            branchName: plan.worktreeTarget.branchStrategy.branchName,
            baseCommitSha: plan.normalizedCommand.baseCommitSha,
          });
        } else {
          this.#worktreeStore.bindReadyToAttempt({
            attemptId: plan.attemptId,
            taskId: plan.task.taskId,
            worktreeId,
            baseCommitSha: plan.normalizedCommand.baseCommitSha,
          });
        }
        const accepted: LaunchCommandResult = {
          accepted: true,
          commandType,
          taskId: plan.task.taskId,
          attemptId: plan.attemptId,
          worktreeId,
          worktreeMode: plan.normalizedCommand.worktreeMode,
        };
        this.#idempotency.record(envelope.commandId, payloadHash, accepted, {
          type: "Attempt",
          id: plan.attemptId,
        });
        return accepted;
      },
      this.#now,
    );

    if (plan.worktreeTarget.kind === "Planned") {
      await this.#worktrees.provision({
        commandId: provisionCommandId(envelope.commandId),
        worktreeId: plan.worktreeTarget.worktreeId,
      });
    }
    return result;
  }

  prepareScheduledLaunch(attempt: { readonly attemptId: string; readonly worktreePath: string }): {
    readonly commandId: string;
    readonly agentId: string;
    readonly launchSpec: LaunchSpec;
  } {
    const row = this.#db
      .prepare(
        `SELECT attempts.launch_command_id, launch_confirmation_plans.plan_json
         FROM attempts
         JOIN launch_confirmation_plans
           ON launch_confirmation_plans.challenge_id =
              attempts.launch_confirmation_challenge_id
         WHERE attempts.attempt_id = ?`,
      )
      .get(attempt.attemptId) as
      | { readonly launch_command_id: string | null; readonly plan_json: string }
      | undefined;
    if (row === undefined || row.launch_command_id === null) {
      throw new StoreError("DataIntegrityFailure", "Queued Attempt has no launch plan");
    }
    const plan = JSON.parse(row.plan_json) as LaunchPlan;
    if (plan.attemptId !== attempt.attemptId || plan.launchSpec.cwd !== attempt.worktreePath) {
      throw new StoreError("ConfirmationRequired", "scheduled launch facts changed");
    }
    return {
      commandId: row.launch_command_id,
      agentId: plan.profileSnapshot.agentId,
      launchSpec: plan.launchSpec,
    };
  }

  async revalidateAcceptedAttempt(attemptId: string): Promise<boolean> {
    try {
      const row = this.#db
        .prepare(
          `SELECT attempts.status, attempts.task_id,
                  launch_confirmation_plans.plan_json
           FROM attempts
           JOIN launch_confirmation_plans
             ON launch_confirmation_plans.challenge_id =
                attempts.launch_confirmation_challenge_id
           WHERE attempts.attempt_id = ?`,
        )
        .get(attemptId) as
        | {
            readonly status: AttemptStatus;
            readonly task_id: string;
            readonly plan_json: string;
          }
        | undefined;
      if (row === undefined || (row.status !== "Queued" && row.status !== "Starting")) {
        return false;
      }
      const plan = JSON.parse(row.plan_json) as LaunchPlan;
      const task = this.#task(row.task_id);
      if (task.lifecycle !== "Runnable") return false;
      const { workspace, trust } = this.#workspace(task.workspaceId);
      if (
        trust.trustId !== plan.trustId ||
        trust.trustVersion !== plan.trustVersion ||
        this.#repositoryIdentity(workspace) !== plan.repositoryIdentity
      ) {
        return false;
      }
      const profile = this.#profiles.getAttemptSnapshot(attemptId);
      const environment = this.#environments.getForAttempt(attemptId);
      if (
        profile === null ||
        environment === null ||
        canonicalSha256(profile) !== canonicalSha256(plan.profileSnapshot) ||
        canonicalSha256(environment) !== canonicalSha256(plan.environmentSnapshot)
      ) {
        return false;
      }
      const verifiedEnvironment = await this.#hostEnvironment.verifySnapshot(environment);
      if (!verifiedEnvironment.ok) return false;
      const worktree = this.#worktreeStore.worktreeForAttempt(attemptId);
      if (
        worktree === null ||
        worktree.state !== "Ready" ||
        worktree.filesystemIdentity === null ||
        worktree.baseCommitSha !== plan.normalizedCommand.baseCommitSha
      ) {
        return false;
      }
      const inspected = await this.#worktrees.inspect({ worktreeId: worktree.worktreeId });
      if (!inspected.ok || inspected.inspection.gitObservation === null) return false;
      if (
        plan.worktreeTarget.kind === "Existing" &&
        (inspected.inspection.gitObservation.stateFingerprint !== plan.expectedStateFingerprint ||
          inspected.inspection.filesystemIdentity.dev !==
            plan.worktreeTarget.filesystemIdentity.dev ||
          inspected.inspection.filesystemIdentity.ino !==
            plan.worktreeTarget.filesystemIdentity.ino)
      ) {
        return false;
      }
      if (
        plan.worktreeTarget.kind === "Planned" &&
        (inspected.inspection.headSha !== plan.normalizedCommand.baseCommitSha ||
          inspected.inspection.detached ||
          inspected.inspection.branchName !== plan.worktreeTarget.branchStrategy.branchName ||
          inspected.inspection.gitObservation.staged.length !== 0 ||
          inspected.inspection.gitObservation.unstaged.length !== 0 ||
          inspected.inspection.gitObservation.untracked.length !== 0)
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async #buildPlan(
    envelope: CommandEnvelope,
    commandType: LaunchCommandKind,
    targetCommandId: string,
    requested: LaunchCommandPayload,
  ): Promise<LaunchPlan> {
    this.#validateRequested(requested);
    const target = this.#targetIdentities(envelope, commandType);
    const task = this.#task(target.taskId);
    const sourceAttempt =
      target.sourceAttemptId === null ? null : this.#attempt(target.sourceAttemptId);
    this.#assertCommandAllowed(commandType, task, sourceAttempt);
    const { workspace, trust } = this.#workspace(task.workspaceId);
    if (requested.userIdentity !== trust.userIdentity) {
      throw new StoreError("Forbidden", "current user does not match Repository Trust");
    }
    await this.#verifyBaseCommit(workspace, trust, requested.baseCommitSha);
    const normalizedCommand = this.#normalizeWorktreeCommand(
      commandType,
      requested,
      task,
      workspace,
    );
    const worktree = await this.#targetBinding(task, workspace, normalizedCommand);
    const profile = this.#profiles.getProfile(normalizedCommand.profileId);
    const adapter = this.#adapterFor(profile.agentId);
    if (adapter.agentId !== profile.agentId) {
      throw new StoreError("CapabilityUnavailable", "Agent Adapter identity mismatch");
    }
    const candidate = await adapter.discoverCandidate();
    const discovery = await adapter.discover({
      authorization: {
        trustId: trust.trustId,
        trustVersion: trust.trustVersion,
        state: trust.state,
        repositoryRoot: workspace.canonicalRoot,
        repositoryIdentity: this.#repositoryIdentity(workspace),
      },
      candidate,
    });
    if (commandType === "Resume" && !discovery.capabilities.includes("Resume")) {
      throw new StoreError("CapabilityUnavailable", "Agent Adapter does not support resume");
    }
    const adapterFacts: AdapterSnapshotFacts = {
      agentId: discovery.agentId,
      capabilities: discovery.capabilities,
      permissionMappings: discovery.permissionMappings,
    };
    const profileSnapshot = this.#profiles.previewAttemptSnapshot(
      normalizedCommand.profileId,
      adapterFacts,
    );
    const launchSpec = await adapter.prepare({
      taskSpecHash: canonicalSha256(JSON.parse(task.specJson)),
      discovery,
      profileSnapshot,
      worktreeTarget: worktree.binding,
    });
    const environmentSnapshot = this.#hostEnvironment.createSnapshot({
      probe: {
        executableIdentity: discovery.executableIdentity,
        stdout: "",
        environment: discovery.probeEnvironment,
      },
      cliVersion: discovery.cliVersion,
      launchArguments: launchSpec.argv,
      worktreeTarget: worktree.binding,
      secretReferenceIdentities: profileSnapshot.secretReferenceIdentities,
    });
    return {
      attemptId: `at_${randomUUID()}`,
      commandType,
      targetCommandId,
      task,
      sourceAttempt,
      userIdentity: requested.userIdentity,
      trustId: trust.trustId,
      trustVersion: trust.trustVersion,
      repositoryIdentity: this.#repositoryIdentity(workspace),
      normalizedCommand,
      worktreeTarget: worktree.binding,
      worktreeObservedState: worktree.observedState,
      expectedStateFingerprint: worktree.stateFingerprint,
      expectedClean: worktree.expectedClean,
      profileSnapshot,
      adapterFacts,
      environmentSnapshot,
      launchSpec,
    };
  }

  #targetIdentities(
    envelope: CommandEnvelope,
    commandType: LaunchCommandKind,
  ): { readonly taskId: string; readonly sourceAttemptId: string | null } {
    if (commandType === "Start") {
      if (typeof envelope.taskId !== "string" || envelope.taskId.length === 0) {
        throw new StoreError("InvalidRequest", "Start requires envelope.taskId");
      }
      return { taskId: envelope.taskId, sourceAttemptId: null };
    }
    if (typeof envelope.attemptId !== "string" || envelope.attemptId.length === 0) {
      throw new StoreError("InvalidRequest", `${commandType} requires envelope.attemptId`);
    }
    const source = this.#attempt(envelope.attemptId);
    if (envelope.taskId !== undefined && envelope.taskId !== source.taskId) {
      throw new StoreError("Conflict", "Task and source Attempt identities differ");
    }
    return { taskId: source.taskId, sourceAttemptId: source.attemptId };
  }

  #validateRequested(requested: LaunchCommandPayload): void {
    if (
      typeof requested.userIdentity !== "string" ||
      requested.userIdentity.length === 0 ||
      typeof requested.profileId !== "string" ||
      requested.profileId.length === 0 ||
      !SHA_RE.test(requested.baseCommitSha)
    ) {
      throw new StoreError("InvalidRequest", "Launch command identity or base SHA is invalid");
    }
    if (
      !["CreateFromBase", "ContinueCurrentWorktree", "Rebaseline", "FromCommit"].includes(
        requested.worktreeMode,
      )
    ) {
      throw new StoreError("InvalidRequest", "unknown Worktree mode");
    }
  }

  async #verifyBaseCommit(
    workspace: WorkspaceRecord,
    trust: RepositoryTrustRecord,
    baseCommitSha: string,
  ): Promise<void> {
    const verified = await this.#git.verifyCommitObject(
      {
        canonicalRoot: workspace.canonicalRoot,
        filesystemIdentity: trust.filesystemIdentity,
      },
      {
        commonGitDir: workspace.commonGitDir,
        commonGitDirIdentity: workspace.commonGitDirIdentity,
      },
      baseCommitSha,
    );
    if (verified.ok) return;
    if (verified.reason === "invalid-sha" || verified.reason === "not-a-commit") {
      throw new StoreError(
        "InvalidRequest",
        "baseCommitSha must name a commit object in the Active Repository",
      );
    }
    if (verified.reason === "git-unavailable") {
      throw new StoreError(
        "CapabilityUnavailable",
        "Restricted Git is unavailable while verifying baseCommitSha",
      );
    }
    throw new StoreError(
      "Conflict",
      verified.reason === "repository-identity-drift"
        ? "Repository identity changed while verifying baseCommitSha"
        : "Active Repository could not be validated while verifying baseCommitSha",
    );
  }

  #assertCommandAllowed(
    commandType: LaunchCommandKind,
    task: TaskFacts,
    source: AttemptFacts | null,
  ): void {
    const active = this.#nonterminalAttempts(task.taskId);
    if (commandType === "Start") {
      if (task.lifecycle !== "Draft" || source !== null || active.length !== 0) {
        throw new StoreError("Conflict", "Start requires a Draft Task with no Attempt");
      }
      return;
    }
    if (task.lifecycle !== "Runnable" || source === null || active.length !== 0) {
      throw new StoreError(
        "Conflict",
        `${commandType} requires a Runnable Task whose prior Attempt is terminal`,
      );
    }
    if (commandType === "Resume") {
      if (source.status !== "Interrupted" && source.status !== "Uncertain") {
        throw new StoreError(
          "Conflict",
          "resume requires an Interrupted or Uncertain source Attempt",
        );
      }
      const disposition = this.#db
        .prepare("SELECT disposition FROM process_dispositions WHERE attempt_id = ?")
        .get(source.attemptId) as
        | { readonly disposition: ProcessDisposition.ProcessDisposition }
        | undefined;
      if (
        disposition === undefined ||
        ProcessDisposition.dispositionHoldsSlot(disposition.disposition)
      ) {
        throw new StoreError(
          "Conflict",
          "Process Disposition does not allow a replacement Attempt",
        );
      }
    } else if (source.status === "Interrupted" || source.status === "Uncertain") {
      throw new StoreError("Conflict", "Interrupted or Uncertain Attempts require explicit resume");
    }
  }

  #normalizeWorktreeCommand(
    commandType: LaunchCommandKind,
    requested: LaunchCommandPayload,
    task: TaskFacts,
    workspace: WorkspaceRecord,
  ): LaunchCommandPayload {
    if (commandType === "Start" && requested.worktreeMode !== "CreateFromBase") {
      throw new StoreError("InvalidRequest", "Start requires CreateFromBase");
    }
    if (commandType !== "Start" && requested.worktreeMode === "CreateFromBase") {
      throw new StoreError("InvalidRequest", `${commandType} cannot use CreateFromBase`);
    }
    if (
      requested.worktreeMode === "CreateFromBase" &&
      requested.baseCommitSha !== workspace.headCommitSha
    ) {
      throw new StoreError("Conflict", "CreateFromBase SHA differs from Repository HEAD");
    }
    if (requested.worktreeMode === "Rebaseline") {
      const expected = workspace.defaultBaseRefSha ?? workspace.headCommitSha;
      if (requested.baseCommitSha !== expected) {
        throw new StoreError("Conflict", "Rebaseline SHA differs from the resolved base ref");
      }
    }
    if (requested.worktreeMode === "ContinueCurrentWorktree") {
      const active = this.#activeWorktree(task.taskId);
      if (requested.baseCommitSha !== active.baseCommitSha) {
        throw new StoreError("Conflict", "ContinueCurrentWorktree base SHA changed");
      }
      const { plannedWorktree: _ignoredPlannedWorktree, ...withoutPlannedWorktree } = requested;
      return withoutPlannedWorktree;
    }
    const worktreeId = `wt_${randomUUID()}` as WorktreeId;
    const planned: PlannedWorktreeSelection = {
      worktreeId,
      canonicalPath: join(this.#managedWorktreeRoot, worktreeId),
      branchName: `fleet/${task.taskId}/${worktreeId.slice(3, 11)}`,
    };
    return { ...requested, plannedWorktree: planned };
  }

  async #targetBinding(
    task: TaskFacts,
    workspace: WorkspaceRecord,
    command: LaunchCommandPayload,
  ): Promise<{
    readonly binding: WorktreeTargetBinding;
    readonly observedState: WorktreeObservedState;
    readonly stateFingerprint: string | null;
    readonly expectedClean: boolean;
  }> {
    if (command.worktreeMode !== "ContinueCurrentWorktree") {
      const planned = command.plannedWorktree;
      if (planned === undefined) {
        throw new StoreError("DataIntegrityFailure", "planned Worktree selection is missing");
      }
      return {
        binding: {
          kind: "Planned",
          worktreeId: planned.worktreeId,
          canonicalPath: planned.canonicalPath,
          repositoryIdentity: this.#repositoryIdentity(workspace),
          branchStrategy: {
            kind: "create",
            branchName: planned.branchName,
            onCollision: "fail",
          },
        },
        observedState: {
          kind: "Planned",
          pathState: "not-materialized",
          expectedClean: true,
        },
        stateFingerprint: null,
        expectedClean: true,
      };
    }
    const active = this.#activeWorktree(task.taskId);
    const inspected = await this.#worktrees.inspect({ worktreeId: active.worktreeId });
    if (!inspected.ok) {
      throw new StoreError(
        inspected.failure.kind === "CapabilityUnavailable" ? "CapabilityUnavailable" : "Conflict",
        inspected.failure.detail,
      );
    }
    if (
      inspected.inspection.gitObservation === null ||
      inspected.inspection.aliveSessions.length > 0 ||
      inspected.inspection.detached ||
      inspected.inspection.branchName !== active.branchName ||
      inspected.inspection.disposeBlockers.some(
        (blocker) => blocker.kind === "externally-occupied",
      ) ||
      inspected.inspection.processDispositions.some((fact) =>
        ProcessDisposition.dispositionHoldsSlot(fact.disposition),
      )
    ) {
      throw new StoreError("Conflict", "ContinueCurrentWorktree is blocked by runtime facts");
    }
    return {
      binding: {
        kind: "Existing",
        worktreeId: active.worktreeId,
        canonicalPath: active.canonicalPath,
        repositoryIdentity: active.repositoryIdentity,
        filesystemIdentity: inspected.inspection.filesystemIdentity,
      },
      observedState: {
        kind: "Existing",
        observedAt: inspected.inspection.observedAt,
        branchName: active.branchName,
        detached: false,
        headSha: inspected.inspection.headSha,
        baseSha: inspected.inspection.baseSha,
        stagedCount: inspected.inspection.gitObservation.staged.length,
        unstagedCount: inspected.inspection.gitObservation.unstaged.length,
        untrackedCount: inspected.inspection.gitObservation.untracked.length,
        externallyOccupied: false,
      },
      stateFingerprint: inspected.inspection.gitObservation.stateFingerprint,
      expectedClean: false,
    };
  }

  #preview(plan: LaunchPlan): ChallengePreview {
    const display: ChallengeDisplay = {
      title: `${plan.commandType} Agent`,
      fields: [
        { label: "Command", value: plan.commandType },
        { label: "Task", value: plan.task.taskId },
        {
          label: "Executable",
          value: plan.environmentSnapshot.snapshot.executableIdentity.canonicalEntryPath,
        },
        { label: "CLI version", value: plan.environmentSnapshot.snapshot.cliVersion },
        {
          label: "Permission Mapping",
          value: plan.profileSnapshot.permissionMapping.effectiveMode,
        },
        { label: "Arguments (redacted)", value: this.#redactedArguments(plan) },
        {
          label: "Environment Snapshot",
          value: JSON.stringify({
            hash: plan.environmentSnapshot.hash,
            capturedAt: plan.environmentSnapshot.snapshot.capturedAt,
            explicitPath: plan.environmentSnapshot.snapshot.explicitPath,
            inheritedVariables: plan.environmentSnapshot.snapshot.inheritedVariableAllowlist,
            secretReferenceCount:
              plan.environmentSnapshot.snapshot.secretReferenceIdentities.length,
          }),
        },
        {
          label: "Executable coverage",
          value: plan.environmentSnapshot.snapshot.executableIdentity.identityCoverage.join(", "),
        },
        {
          label: "Package closure",
          value:
            plan.environmentSnapshot.snapshot.executableIdentity.packageRuntimeClosureManifest
              .manifestHash,
        },
        {
          label: "Executable observed at",
          value: plan.environmentSnapshot.snapshot.executableIdentity.observedAt,
        },
        { label: "Repository", value: plan.repositoryIdentity },
        { label: "Worktree mode", value: plan.normalizedCommand.worktreeMode },
        { label: "Worktree", value: plan.worktreeTarget.canonicalPath },
        { label: "Worktree target", value: JSON.stringify(plan.worktreeTarget) },
        {
          label: "Worktree observed state",
          value: JSON.stringify(plan.worktreeObservedState),
        },
        {
          label: "Dirty/untracked handling",
          value:
            plan.worktreeObservedState.kind === "Existing"
              ? "Current staged, unstaged, and untracked changes are preserved in place"
              : "A clean Worktree is created; staged, unstaged, and untracked changes are not copied",
        },
        { label: "Base commit", value: plan.normalizedCommand.baseCommitSha },
        { label: "Task spec version", value: String(plan.task.taskSpecVersion) },
        { label: "Profile version", value: String(plan.profileSnapshot.profileVersion) },
        { label: "Impact", value: JSON.stringify(this.#impactSummary(plan)) },
      ],
    };
    return {
      kind: "launch",
      commandType: plan.commandType,
      display,
      payload: {
        commandType: plan.commandType,
        targetCommandId: plan.targetCommandId,
        taskId: plan.task.taskId,
        sourceAttemptId: plan.sourceAttempt?.attemptId ?? null,
        command: plan.normalizedCommand,
      },
      bindingFacts: [
        { userIdentity: plan.userIdentity },
        {
          trustId: plan.trustId,
          trustVersion: plan.trustVersion,
          repositoryIdentity: plan.repositoryIdentity,
        },
        {
          taskId: plan.task.taskId,
          taskSpecVersion: plan.task.taskSpecVersion,
          taskStateVersion: plan.task.stateVersion,
        },
        {
          sourceAttemptId: plan.sourceAttempt?.attemptId ?? null,
          sourceAttemptStatus: plan.sourceAttempt?.status ?? null,
          sourceAttemptStateVersion: plan.sourceAttempt?.stateVersion ?? null,
        },
        {
          worktreeTarget: plan.worktreeTarget,
          worktreeObservedState: plan.worktreeObservedState,
          stateFingerprint: plan.expectedStateFingerprint,
          expectedClean: plan.expectedClean,
          baseCommitSha: plan.normalizedCommand.baseCommitSha,
        },
        {
          profileId: plan.profileSnapshot.profileId,
          profileVersion: plan.profileSnapshot.profileVersion,
          adapterCapabilitiesHash: plan.profileSnapshot.adapterCapabilitiesHash,
          permissionMappingHash: plan.profileSnapshot.permissionMappingHash,
        },
        {
          environmentSnapshotHash: plan.environmentSnapshot.hash,
          argvHash: plan.environmentSnapshot.snapshot.argvHash,
        },
      ],
      impactSummary: this.#impactSummary(plan),
    };
  }

  #redactedArguments(plan: LaunchPlan): string {
    const adapterPreview = [...plan.launchSpec.permissionMapping.launchArgumentsPreview];
    const additionalCount = Math.max(0, plan.launchSpec.argv.length - adapterPreview.length);
    if (additionalCount > 0) {
      adapterPreview.push(`<${additionalCount} additional arguments redacted>`);
    }
    return JSON.stringify(adapterPreview);
  }

  #impactSummary(plan: LaunchPlan): {
    readonly sideEffectClass: "reversible";
    readonly worktreeMode: WorktreeMode;
    readonly createsAttempt: true;
    readonly createsWorktree: boolean;
    readonly copiesUncommittedChanges: false;
    readonly mayRepeatPriorSideEffects: boolean;
  } {
    return {
      sideEffectClass: "reversible",
      worktreeMode: plan.normalizedCommand.worktreeMode,
      createsAttempt: true,
      createsWorktree: plan.worktreeTarget.kind === "Planned",
      copiesUncommittedChanges: false,
      mayRepeatPriorSideEffects: plan.commandType !== "Start",
    };
  }

  async #revalidate(plan: LaunchPlan): Promise<void> {
    this.#revalidateDatabaseFacts(plan);
    const { workspace, trust } = this.#workspace(plan.task.workspaceId);
    await this.#verifyBaseCommit(workspace, trust, plan.normalizedCommand.baseCommitSha);
    const verified = await this.#hostEnvironment.verifySnapshot(plan.environmentSnapshot);
    if (!verified.ok) {
      throw new StoreError(
        "ConfirmationRequired",
        `Environment Snapshot changed: ${verified.reason}`,
      );
    }
    if (plan.worktreeTarget.kind === "Planned") {
      if (existsSync(plan.worktreeTarget.canonicalPath)) {
        throw new StoreError("ConfirmationRequired", "planned Worktree path now exists");
      }
      return;
    }
    if (plan.worktreeObservedState.kind !== "Existing") {
      throw new StoreError(
        "DataIntegrityFailure",
        "existing Worktree target has no observed state",
      );
    }
    const inspected = await this.#worktrees.inspect({
      worktreeId: plan.worktreeTarget.worktreeId,
    });
    if (
      !inspected.ok ||
      inspected.inspection.gitObservation === null ||
      inspected.inspection.gitObservation.stateFingerprint !== plan.expectedStateFingerprint ||
      inspected.inspection.detached ||
      inspected.inspection.branchName !== plan.worktreeObservedState.branchName ||
      inspected.inspection.disposeBlockers.some(
        (blocker) => blocker.kind === "externally-occupied",
      ) ||
      inspected.inspection.filesystemIdentity.dev !== plan.worktreeTarget.filesystemIdentity.dev ||
      inspected.inspection.filesystemIdentity.ino !== plan.worktreeTarget.filesystemIdentity.ino
    ) {
      throw new StoreError(
        "ConfirmationRequired",
        "existing Worktree identity or state fingerprint changed",
      );
    }
  }

  #revalidateDatabaseFacts(plan: LaunchPlan): void {
    const task = this.#task(plan.task.taskId);
    const source = plan.sourceAttempt === null ? null : this.#attempt(plan.sourceAttempt.attemptId);
    this.#assertCommandAllowed(plan.commandType, task, source);
    if (
      task.stateVersion !== plan.task.stateVersion ||
      task.taskSpecVersion !== plan.task.taskSpecVersion ||
      source?.stateVersion !== plan.sourceAttempt?.stateVersion ||
      source?.status !== plan.sourceAttempt?.status
    ) {
      throw new StoreError("ConfirmationRequired", "Task or source Attempt changed");
    }
    const { workspace, trust } = this.#workspace(task.workspaceId);
    if (
      trust.trustId !== plan.trustId ||
      trust.trustVersion !== plan.trustVersion ||
      this.#repositoryIdentity(workspace) !== plan.repositoryIdentity
    ) {
      throw new StoreError("ConfirmationRequired", "Repository Trust facts changed");
    }
    const profile = this.#profiles.getProfile(plan.profileSnapshot.profileId);
    if (
      profile.deletedAt !== null ||
      profile.profileVersion !== plan.profileSnapshot.profileVersion
    ) {
      throw new StoreError("ConfirmationRequired", "Agent Profile changed");
    }
  }

  #createAttempt(
    plan: LaunchPlan,
    launchCommandId: string,
    launchConfirmationChallengeId: string,
  ): void {
    const task = this.#task(plan.task.taskId);
    if (plan.commandType === "Start") {
      const changed = this.#db
        .prepare(
          `UPDATE tasks
           SET lifecycle = 'Runnable', state_version = state_version + 1, updated_at = ?
           WHERE task_id = ? AND lifecycle = 'Draft' AND state_version = ?`,
        )
        .run(new Date(this.#now()).toISOString(), task.taskId, task.stateVersion);
      if (changed.changes !== 1) {
        throw new StoreError("ConfirmationRequired", "Task changed before Start");
      }
    }
    const seq = (
      this.#db.prepare("SELECT COALESCE(MAX(created_seq), 0) + 1 AS seq FROM attempts").get() as {
        readonly seq: number;
      }
    ).seq;
    this.#db
      .prepare(
        `INSERT INTO attempts
         (attempt_id, task_id, status, spec_snapshot_json, task_spec_version,
          created_seq, state_version, command_kind, source_attempt_id,
          launch_confirmation_challenge_id, launch_command_id, created_at)
         VALUES (?, ?, 'Queued', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.attemptId,
        task.taskId,
        task.specJson,
        task.taskSpecVersion,
        seq,
        plan.commandType,
        plan.sourceAttempt?.attemptId ?? null,
        launchConfirmationChallengeId,
        launchCommandId,
        new Date(this.#now()).toISOString(),
      );
    appendDomainEvent(
      this.#db,
      {
        taskId: task.taskId,
        attemptId: plan.attemptId,
        type: "attempt-queued",
        payload: {
          commandType: plan.commandType,
          sourceAttemptId: plan.sourceAttempt?.attemptId ?? null,
          worktreeMode: plan.normalizedCommand.worktreeMode,
        },
      },
      this.#now,
    );
  }

  #planRow(challengeId: string): PlanRow {
    const row = this.#db
      .prepare("SELECT * FROM launch_confirmation_plans WHERE challenge_id = ?")
      .get(challengeId) as PlanRow | undefined;
    if (row === undefined) {
      throw new StoreError("ConfirmationRequired", "unknown Launch Confirmation plan");
    }
    return row;
  }

  #task(taskId: string): TaskFacts {
    const row = this.#db
      .prepare(
        `SELECT task_id, workspace_id, lifecycle, spec_json, task_spec_version, state_version
         FROM tasks WHERE task_id = ?`,
      )
      .get(taskId) as
      | {
          readonly task_id: string;
          readonly workspace_id: string;
          readonly lifecycle: TaskFacts["lifecycle"];
          readonly spec_json: string;
          readonly task_spec_version: number;
          readonly state_version: number;
        }
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Task: ${taskId}`);
    return {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      lifecycle: row.lifecycle,
      specJson: row.spec_json,
      taskSpecVersion: row.task_spec_version,
      stateVersion: row.state_version,
    };
  }

  #attempt(attemptId: string): AttemptFacts {
    const row = this.#db
      .prepare(
        "SELECT attempt_id, task_id, status, state_version FROM attempts WHERE attempt_id = ?",
      )
      .get(attemptId) as
      | {
          readonly attempt_id: string;
          readonly task_id: string;
          readonly status: AttemptStatus;
          readonly state_version: number;
        }
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", `no such Attempt: ${attemptId}`);
    return {
      attemptId: row.attempt_id,
      taskId: row.task_id,
      status: row.status,
      stateVersion: row.state_version,
    };
  }

  #nonterminalAttempts(taskId: string): readonly AttemptFacts[] {
    return this.#db
      .prepare(
        `SELECT attempt_id, task_id, status, state_version FROM attempts
         WHERE task_id = ? AND status IN ('Queued','Starting','Running','Waiting','Stopping')`,
      )
      .all(taskId)
      .map((raw) => {
        const row = raw as {
          readonly attempt_id: string;
          readonly task_id: string;
          readonly status: AttemptStatus;
          readonly state_version: number;
        };
        return {
          attemptId: row.attempt_id,
          taskId: row.task_id,
          status: row.status,
          stateVersion: row.state_version,
        };
      });
  }

  #workspace(workspaceId: string): {
    readonly workspace: WorkspaceRecord;
    readonly trust: RepositoryTrustRecord;
  } {
    const result = this.#trustStore.getWorkspaceWithTrust(workspaceId);
    if (result.trust.state !== "Active") {
      throw new StoreError("Conflict", "Launch requires Active Repository Trust");
    }
    return result;
  }

  #repositoryIdentity(workspace: WorkspaceRecord): string {
    return `${workspace.commonGitDirIdentity.dev}:${workspace.commonGitDirIdentity.ino}`;
  }

  #activeWorktree(taskId: string): WorktreeRecord {
    const active = this.#worktreeStore
      .listForTask(taskId)
      .filter((worktree) => worktree.role === "Active");
    if (active.length !== 1 || active[0]?.state !== "Ready") {
      throw new StoreError("Conflict", "Task does not have exactly one active Ready Worktree");
    }
    return active[0];
  }
}
