// R1-07 — production routing from authenticated command envelopes to the
// runtime deep-module seams. The router validates only wire identity/shape;
// Session, Task and Worktree semantics stay in their owning modules.

import type { DatabaseSync } from "node:sqlite";
import type {
  ChallengeDisplay,
  CommandEnvelope,
  CommandKind,
  ConfirmationReceipt,
  ControlLease,
  FilesystemIdentity,
  InputSource,
  IntegrationTarget,
  LaunchCommandKind,
  LaunchCommandPayload,
  ProfileId,
  SessionRuntime,
  StopCommandImpact,
  StopCommandResult,
  TaskOrchestrator,
  WorktreeId,
  WorktreeManager,
} from "@agents-fleet/contracts";
import { type ChallengePreview, hashPreviewFact } from "./confirmation/challenge-issuer.js";
import type { PersistentChallengeIssuer } from "./confirmation/persistent-challenge-issuer.js";
import type { CommandRouter } from "./control-dispatcher.js";
import { CommandError } from "./repository-trust/trust-command-router.js";
import { transact } from "./storage/database.js";
import { hashCommandPayload, type IdempotencyStore } from "./storage/idempotency.js";
import { StoreError } from "./storage/task-store.js";
import type { LaunchCommandCoordinator } from "./task-orchestrator/launch-command-coordinator.js";

const RUNTIME_COMMAND_KINDS = [
  "Attach",
  "AcquireControl",
  "WriteSessionInput",
  "ResizeSession",
  "DisposeWorktree",
  "TerminateSession",
  "IssueSideEffectConfirmationChallenge",
  "RequestAttemptStop",
  "CancelTask",
  "IssueLaunchConfirmationChallenge",
  "Start",
  "Retry",
  "Resume",
] as const satisfies readonly CommandKind[];

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("InvalidRequest", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError("InvalidRequest", `payload.${key} must be a non-empty string`);
  }
  return value;
};

const worktreeIdFromWire = (value: string): WorktreeId => value as WorktreeId;

const requiredEnvelopeString = (
  envelope: CommandEnvelope,
  key: "taskId" | "attemptId" | "sessionId" | "attachmentId",
): string => {
  const value = envelope[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError("InvalidRequest", `envelope.${key} must be a non-empty string`);
  }
  return value;
};

const requiredEnvelopeInteger = (
  envelope: CommandEnvelope,
  key: "expectedGeneration" | "fencingToken",
): number => {
  const value = envelope[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CommandError("InvalidRequest", `envelope.${key} must be a positive integer`);
  }
  return value as number;
};

const requiredPositiveInteger = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CommandError("InvalidRequest", `payload.${key} must be a positive integer`);
  }
  return value as number;
};

const requiredExpectedStateVersion = (envelope: CommandEnvelope): number => {
  const value = envelope.expectedStateVersion;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CommandError(
      "InvalidRequest",
      "envelope.expectedStateVersion must be a positive integer",
    );
  }
  return value as number;
};

const requiredFilesystemIdentity = (record: Record<string, unknown>): FilesystemIdentity => {
  const raw = asRecord(record.expectedFilesystemIdentity, "payload.expectedFilesystemIdentity");
  if (
    !Number.isSafeInteger(raw.dev) ||
    (raw.dev as number) < 0 ||
    !Number.isSafeInteger(raw.ino) ||
    (raw.ino as number) < 0
  ) {
    throw new CommandError(
      "InvalidRequest",
      "payload.expectedFilesystemIdentity must contain non-negative integer dev/ino",
    );
  }
  return { dev: raw.dev as number, ino: raw.ino as number };
};

const requiredIntegrationTarget = (record: Record<string, unknown>): IntegrationTarget => {
  const raw = asRecord(record.integrationTarget, "payload.integrationTarget");
  if (raw.ref !== null && typeof raw.ref !== "string") {
    throw new CommandError(
      "InvalidRequest",
      "payload.integrationTarget.ref must be string or null",
    );
  }
  if (typeof raw.sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.sha)) {
    throw new CommandError(
      "InvalidRequest",
      "payload.integrationTarget.sha must be a full commit SHA",
    );
  }
  return { ref: raw.ref as string | null, sha: raw.sha };
};

const INPUT_SOURCES: readonly InputSource[] = ["Keyboard", "IME", "Paste", "Mouse", "Automation"];

const requiredInputSource = (record: Record<string, unknown>): InputSource => {
  const value = record.source;
  if (typeof value !== "string" || !(INPUT_SOURCES as readonly string[]).includes(value)) {
    throw new CommandError("InvalidRequest", "payload.source is invalid");
  }
  return value as InputSource;
};

const requiredBytes = (record: Record<string, unknown>): Uint8Array => {
  const value = record.bytes;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(value);
  }
  throw new CommandError("InvalidRequest", "payload.bytes must be a byte array");
};

const requiredConfirmationReceipt = (value: unknown): ConfirmationReceipt => {
  if (value === undefined || value === null) {
    throw new CommandError(
      "ConfirmationRequired",
      "destructive command requires envelope.confirmationReceipt",
    );
  }
  const record = asRecord(value, "envelope.confirmationReceipt");
  return {
    challengeId: requiredString(record, "challengeId"),
    proof: requiredString(record, "proof"),
    confirmedAt: requiredString(record, "confirmedAt"),
  };
};

const LAUNCH_COMMANDS: readonly LaunchCommandKind[] = ["Start", "Retry", "Resume"];
const WORKTREE_MODES = [
  "CreateFromBase",
  "ContinueCurrentWorktree",
  "Rebaseline",
  "FromCommit",
] as const;

const requiredLaunchCommandKind = (
  record: Record<string, unknown>,
  key: string,
): LaunchCommandKind => {
  const value = record[key];
  if (typeof value !== "string" || !(LAUNCH_COMMANDS as readonly string[]).includes(value)) {
    throw new CommandError("InvalidRequest", `payload.${key} must be Start, Retry, or Resume`);
  }
  return value as LaunchCommandKind;
};

const requiredLaunchCommand = (value: unknown): LaunchCommandPayload => {
  const record = asRecord(value, "payload.command");
  const userIdentity = requiredString(record, "userIdentity");
  const profileId = requiredString(record, "profileId") as ProfileId;
  const baseCommitSha = requiredString(record, "baseCommitSha");
  const worktreeMode = record.worktreeMode;
  if (
    typeof worktreeMode !== "string" ||
    !(WORKTREE_MODES as readonly string[]).includes(worktreeMode)
  ) {
    throw new CommandError("InvalidRequest", "payload.command.worktreeMode is invalid");
  }
  return {
    userIdentity,
    profileId,
    baseCommitSha,
    worktreeMode: worktreeMode as LaunchCommandPayload["worktreeMode"],
    ...(record.plannedWorktree === undefined
      ? {}
      : {
          plannedWorktree: (() => {
            const planned = asRecord(record.plannedWorktree, "payload.command.plannedWorktree");
            return {
              worktreeId: worktreeIdFromWire(requiredString(planned, "worktreeId")),
              canonicalPath: requiredString(planned, "canonicalPath"),
              branchName: requiredString(planned, "branchName"),
            };
          })(),
        }),
  };
};

const leaseFrom = (envelope: CommandEnvelope): ControlLease => ({
  sessionId: requiredEnvelopeString(envelope, "sessionId") as ControlLease["sessionId"],
  generation: requiredEnvelopeInteger(envelope, "expectedGeneration") as ControlLease["generation"],
  attachmentId: requiredEnvelopeString(envelope, "attachmentId") as ControlLease["attachmentId"],
  fencingToken: requiredEnvelopeInteger(envelope, "fencingToken") as ControlLease["fencingToken"],
  // RT-CMD-04 does not carry the informational expiry; SessionRuntime
  // revalidates the authoritative persisted expiry before every operation.
  expiresAt: 0,
});

export interface RuntimeCommandRouterOptions {
  readonly db: DatabaseSync;
  readonly idempotency: IdempotencyStore;
  readonly challenges: PersistentChallengeIssuer;
  readonly taskOrchestrator: TaskOrchestrator;
  readonly launches?: LaunchCommandCoordinator;
  readonly autoLaunch?: boolean;
  readonly fallback?: CommandRouter;
  readonly sessions: SessionRuntime;
  readonly worktrees: WorktreeManager;
}

export class RuntimeCommandRouter implements CommandRouter {
  readonly #db: DatabaseSync;
  readonly #idempotency: IdempotencyStore;
  readonly #challenges: PersistentChallengeIssuer;
  readonly #tasks: TaskOrchestrator;
  readonly #launches: LaunchCommandCoordinator | undefined;
  readonly #autoLaunch: boolean;
  readonly #fallback: CommandRouter | undefined;
  readonly #sessions: SessionRuntime;
  readonly #worktrees: WorktreeManager;

  constructor(options: RuntimeCommandRouterOptions) {
    this.#db = options.db;
    this.#idempotency = options.idempotency;
    this.#challenges = options.challenges;
    this.#tasks = options.taskOrchestrator;
    this.#launches = options.launches;
    this.#autoLaunch = options.autoLaunch ?? false;
    this.#fallback = options.fallback;
    this.#sessions = options.sessions;
    this.#worktrees = options.worktrees;
  }

  handles(kind: string): boolean {
    return (
      (RUNTIME_COMMAND_KINDS as readonly string[]).includes(kind) ||
      this.#fallback?.handles(kind) === true
    );
  }

  async execute(kind: CommandKind, envelope: CommandEnvelope): Promise<unknown> {
    if (
      !(RUNTIME_COMMAND_KINDS as readonly string[]).includes(kind) &&
      this.#fallback?.handles(kind) === true
    ) {
      return await this.#fallback.execute(kind, envelope);
    }
    switch (kind) {
      case "Attach": {
        const payload = asRecord(envelope.payload, "payload");
        return this.#sessions.attach(requiredString(payload, "sessionId"));
      }
      case "AcquireControl":
        return this.#sessions.acquireControl(requiredEnvelopeString(envelope, "attachmentId"));
      case "WriteSessionInput": {
        const payload = asRecord(envelope.payload, "payload");
        return await this.#sessions.writeSessionInput({
          commandId: envelope.commandId,
          lease: leaseFrom(envelope),
          source: requiredInputSource(payload),
          bytes: requiredBytes(payload),
        });
      }
      case "ResizeSession": {
        const payload = asRecord(envelope.payload, "payload");
        await this.#sessions.resizeSession({
          lease: leaseFrom(envelope),
          cols: requiredPositiveInteger(payload, "cols"),
          rows: requiredPositiveInteger(payload, "rows"),
        });
        return { resized: true };
      }
      case "DisposeWorktree": {
        const payload = asRecord(envelope.payload, "payload");
        if (payload.branchDisposition !== "preserve") {
          throw new CommandError("InvalidRequest", "payload.branchDisposition must be 'preserve'");
        }
        return await this.#worktrees.dispose({
          commandId: envelope.commandId,
          worktreeId: worktreeIdFromWire(requiredString(payload, "worktreeId")),
          expectedStateVersion: requiredExpectedStateVersion(envelope),
          expectedFilesystemIdentity: requiredFilesystemIdentity(payload),
          expectedStateFingerprint: requiredString(payload, "expectedStateFingerprint"),
          integrationTarget: requiredIntegrationTarget(payload),
          branchDisposition: "preserve",
        });
      }
      case "IssueSideEffectConfirmationChallenge": {
        const payload = asRecord(envelope.payload, "payload");
        const targetCommandId = requiredString(payload, "targetCommandId");
        if (payload.commandType === "TerminateSession") {
          return this.#sessions.issueTerminateSessionChallenge(
            leaseFrom(envelope),
            targetCommandId,
          );
        }
        if (payload.commandType === "RequestAttemptStop") {
          const impact = this.#stopDescriptor(envelope, "RequestAttemptStop").preview();
          return this.#challenges.issue(this.#stopPreview(impact, targetCommandId));
        }
        if (payload.commandType === "CancelTask") {
          const impact = this.#stopDescriptor(envelope, "CancelTask").preview();
          if (impact.sideEffectClass !== "destructive") {
            return { confirmationRequired: false, impact };
          }
          return this.#challenges.issue(this.#stopPreview(impact, targetCommandId));
        }
        throw new CommandError("InvalidRequest", "unsupported side-effect challenge command type");
      }
      case "TerminateSession": {
        const lease = leaseFrom(envelope);
        const logicalPayload = {
          kind: "TerminateSession",
          sessionId: lease.sessionId,
          generation: lease.generation,
          attachmentId: lease.attachmentId,
          fencingToken: lease.fencingToken,
        };
        const payloadHash = hashCommandPayload(logicalPayload);
        const replay = this.#idempotency.lookup(envelope.commandId, payloadHash);
        if (replay !== null) {
          await this.#terminateSessionAndReobserve(lease.sessionId);
          return replay;
        }
        const result = { terminationRequested: true, sessionId: lease.sessionId };
        transact(this.#db, () => {
          const concurrentReplay = this.#idempotency.lookup(envelope.commandId, payloadHash);
          if (concurrentReplay !== null) return concurrentReplay;
          this.#sessions.authorizeTerminateSession({
            commandId: envelope.commandId,
            lease,
            confirmationReceipt: requiredConfirmationReceipt(envelope.confirmationReceipt),
          });
          this.#idempotency.record(envelope.commandId, payloadHash, result, {
            type: "Session",
            id: lease.sessionId,
          });
        });
        await this.#terminateSessionAndReobserve(lease.sessionId);
        return result;
      }
      case "RequestAttemptStop":
      case "CancelTask":
        return await this.#executeStopCommand(envelope, kind);
      case "IssueLaunchConfirmationChallenge": {
        const payload = asRecord(envelope.payload, "payload");
        return await this.#requireLaunches().issueChallenge(
          envelope,
          requiredLaunchCommandKind(payload, "commandType"),
          requiredString(payload, "targetCommandId"),
          requiredLaunchCommand(payload.command),
        );
      }
      case "Start":
      case "Retry":
      case "Resume": {
        const payload = asRecord(envelope.payload, "payload");
        const launches = this.#requireLaunches();
        const accepted = await launches.execute(envelope, kind, requiredLaunchCommand(payload));
        if (this.#autoLaunch) {
          const scheduled = await this.#tasks.scheduleNext();
          if (scheduled.kind === "prepared" && scheduled.attemptId === accepted.attemptId) {
            await this.#sessions.launch(scheduled, {
              revalidate: async () => await launches.revalidateAcceptedAttempt(accepted.attemptId),
            });
          }
        }
        return accepted;
      }
      default:
        throw new CommandError("InvalidRequest", `unroutable command kind: ${kind}`);
    }
  }

  #requireLaunches(): LaunchCommandCoordinator {
    if (this.#launches === undefined) {
      throw new StoreError("CapabilityUnavailable", "launch command coordinator is unavailable");
    }
    return this.#launches;
  }

  async #executeStopCommand(
    envelope: CommandEnvelope,
    commandType: StopCommandImpact["commandType"],
  ): Promise<StopCommandResult> {
    const descriptor = this.#stopDescriptor(envelope, commandType);
    const expectedStateVersion = requiredExpectedStateVersion(envelope);
    const logicalPayload =
      commandType === "RequestAttemptStop"
        ? { kind: commandType, attemptId: descriptor.targetId, expectedStateVersion }
        : { kind: commandType, taskId: descriptor.targetId, expectedStateVersion };
    const payloadHash = hashCommandPayload(logicalPayload);
    const replay = this.#idempotency.lookup(envelope.commandId, payloadHash);
    if (replay !== null) {
      const result = replay as StopCommandResult;
      await this.#tasks.stopSessions(result.stopRequestedSessionIds);
      await this.#reobserveGitAfterStop(result.attemptId);
      return result;
    }

    const result = transact(this.#db, () => {
      const concurrentReplay = this.#idempotency.lookup(envelope.commandId, payloadHash);
      if (concurrentReplay !== null) return concurrentReplay as StopCommandResult;
      const impact = descriptor.preview();
      if (descriptor.stateVersion(impact) !== expectedStateVersion) {
        throw new StoreError(
          "ConfirmationRequired",
          `${descriptor.targetType} state changed after preview`,
        );
      }
      if (descriptor.requiresConfirmation(impact)) {
        this.#consumeStopReceipt(
          requiredConfirmationReceipt(envelope.confirmationReceipt),
          this.#stopPreview(impact, envelope.commandId),
        );
      }
      const applied = descriptor.apply();
      this.#idempotency.record(envelope.commandId, payloadHash, applied, {
        type: descriptor.targetType,
        id: descriptor.targetId,
      });
      return applied;
    });
    await this.#tasks.stopSessions(result.stopRequestedSessionIds);
    await this.#reobserveGitAfterStop(result.attemptId);
    return result;
  }

  async #terminateSessionAndReobserve(sessionId: string): Promise<void> {
    const row = this.#db
      .prepare("SELECT attempt_id FROM sessions WHERE session_id = ?")
      .get(sessionId) as { readonly attempt_id: string } | undefined;
    await this.#sessions.terminate(sessionId);
    await this.#reobserveGitAfterStop(row?.attempt_id ?? null);
  }

  async #reobserveGitAfterStop(attemptId: string | null): Promise<void> {
    if (attemptId === null) return;
    const binding = this.#db
      .prepare("SELECT worktree_id FROM attempt_worktree_bindings WHERE attempt_id = ?")
      .get(attemptId) as { readonly worktree_id: string } | undefined;
    if (binding === undefined) return;
    // RT-CMD-02/03 + ADR-0005 — the lifecycle transition and original
    // idempotent result are already authoritative. This post-commit,
    // best-effort RT-CMD-15 observation must not turn an applied stop into
    // a failure or make the stored result unreachable on replay. The stop
    // result makes no claim that Git state was saved, reverted, or lost.
    try {
      const observed = await this.#worktrees.inspect({
        worktreeId: worktreeIdFromWire(binding.worktree_id),
      });
      if (!observed.ok) return;
    } catch {
      return;
    }
  }

  #stopDescriptor(
    envelope: CommandEnvelope,
    commandType: StopCommandImpact["commandType"],
  ): {
    readonly targetType: "Attempt" | "Task";
    readonly targetId: string;
    readonly preview: () => StopCommandImpact;
    readonly stateVersion: (impact: StopCommandImpact) => number | null;
    readonly requiresConfirmation: (impact: StopCommandImpact) => boolean;
    readonly apply: () => StopCommandResult;
  } {
    if (commandType === "RequestAttemptStop") {
      const attemptId = requiredEnvelopeString(envelope, "attemptId");
      return {
        targetType: "Attempt",
        targetId: attemptId,
        preview: () => this.#tasks.previewRequestAttemptStop(attemptId),
        stateVersion: (impact) => impact.attemptStateVersion,
        requiresConfirmation: () => true,
        apply: () => this.#tasks.requestAttemptStop(attemptId),
      };
    }
    const taskId = requiredEnvelopeString(envelope, "taskId");
    return {
      targetType: "Task",
      targetId: taskId,
      preview: () => this.#tasks.previewCancelTask(taskId),
      stateVersion: (impact) => impact.taskStateVersion,
      requiresConfirmation: (impact) => impact.sideEffectClass === "destructive",
      apply: () => this.#tasks.cancelTask(taskId),
    };
  }

  #stopPreview(impact: StopCommandImpact, targetCommandId: string): ChallengePreview {
    const targetsAttempt = impact.commandType === "RequestAttemptStop";
    const targetType = targetsAttempt ? "Attempt" : "Task";
    if (targetsAttempt && impact.attemptId === null) {
      throw new StoreError("DataIntegrityFailure", "Attempt stop preview has no Attempt identity");
    }
    const targetId: string =
      targetsAttempt && impact.attemptId !== null ? impact.attemptId : impact.taskId;
    const target = targetsAttempt ? { attemptId: targetId } : { taskId: targetId };
    const title = targetsAttempt ? "Stop Attempt" : "Cancel Task";
    const display: ChallengeDisplay = {
      title,
      fields: [
        { label: "Command", value: impact.commandType },
        { label: "Side-effect Class", value: impact.sideEffectClass },
        {
          label: targetType,
          value: targetId,
        },
        {
          label: "Sessions",
          value:
            impact.aliveSessions.length === 0
              ? "No Alive Sessions"
              : impact.aliveSessions.map((session) => session.sessionId).join(", "),
        },
        {
          label: "Impact",
          value: "Stops processes only; staged, unstaged, and untracked files are not cleaned up",
        },
      ],
    };
    return {
      kind: "side-effect",
      commandType: impact.commandType,
      sideEffectClass: impact.sideEffectClass,
      targetIdentities: [
        {
          targetType,
          targetId,
        },
        ...impact.aliveSessions.map((session) => ({
          targetType: "Session",
          targetId: session.sessionId,
          generation: session.generation,
        })),
      ],
      expectedStateVersions: [
        {
          targetType: "Task",
          targetId: impact.taskId,
          stateVersion: impact.taskStateVersion,
        },
        ...(impact.attemptId === null || impact.attemptStateVersion === null
          ? []
          : [
              {
                targetType: "Attempt",
                targetId: impact.attemptId,
                stateVersion: impact.attemptStateVersion,
              },
            ]),
      ],
      display,
      payload: {
        commandType: impact.commandType,
        targetCommandId,
        ...target,
      },
      bindingFacts: [
        {
          taskId: impact.taskId,
          taskStateVersion: impact.taskStateVersion,
        },
        {
          attemptId: impact.attemptId,
          attemptStatus: impact.attemptStatus,
          attemptStateVersion: impact.attemptStateVersion,
        },
        {
          aliveSessions: impact.aliveSessions,
        },
      ],
      impactSummary: {
        sideEffectClass: impact.sideEffectClass,
        stoppedSessionIds: impact.aliveSessions.map((session) => session.sessionId),
        gitCleanup: impact.gitCleanup,
        worktreeChangesMayRemain: impact.worktreeChangesMayRemain,
      },
    };
  }

  #consumeStopReceipt(receipt: ConfirmationReceipt, preview: ChallengePreview): void {
    const consumed = this.#challenges.consume(receipt, "side-effect", {
      payloadHash: hashPreviewFact(preview.payload),
      bindingHashes: preview.bindingFacts.map(hashPreviewFact),
      impactSummaryHash: hashPreviewFact(preview.impactSummary),
    });
    if (!consumed.ok) {
      throw new StoreError(
        "ConfirmationRequired",
        `side-effect confirmation rejected: ${consumed.reason}`,
      );
    }
  }
}

/** RT-STATE-27 — fail every otherwise-known runtime command closed while
 * preserving the bounded read commands already supported by the Trust router. */
export class ReadOnlyRecoveryCommandRouter implements CommandRouter {
  readonly #fallback: CommandRouter;
  readonly #reason: string;

  constructor(fallback: CommandRouter, reason: string) {
    this.#fallback = fallback;
    this.#reason = reason;
  }

  // Recovery owns every otherwise-known route so writes fail with the stable
  // RecoveryRequired code instead of falling through to InternalFailure.
  handles(_kind: string): boolean {
    return true;
  }

  async execute(kind: CommandKind, envelope: CommandEnvelope): Promise<unknown> {
    if (
      (kind === "GetConfirmationChallenge" || kind === "InspectRepositoryTrust") &&
      this.#fallback.handles(kind)
    ) {
      return await this.#fallback.execute(kind, envelope);
    }
    throw new CommandError("RecoveryRequired", `daemon is in read-only recovery: ${this.#reason}`);
  }
}
