// RT-MOD-03 / RT-LAUNCH-02..08 — Session Runtime public seam.
//
// ProcessSupervisor and the file handshake remain private implementation
// details. Callers pass a scheduler-produced PreparedLaunch and receive only
// domain results. The durable LaunchIntent result makes a replay return the
// original Session without spawning a second bootstrap or Agent.

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  Attachment,
  type AttachmentId,
  type AttachmentRuntimeRecord,
  type AttachResult,
  Attempt,
  type CommandId,
  type ConfirmationChallenge,
  type ConfirmationReceipt,
  type ControlLease,
  checkLimit,
  type DurableFrameRef,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type Generation,
  type InputIntent,
  type LaunchFailedReason,
  LaunchIntent,
  type LaunchSessionResult,
  type LaunchUncertainReason,
  type LaunchValidation,
  type PreparedLaunch,
  ProcessDisposition,
  type ResizeSessionRequest,
  type RestartReconciliationReport,
  type RestartSnapshotRebuildReport,
  type ResumableAttemptStatus,
  type Seq,
  type SessionDeltaBatch,
  type SessionId,
  type SessionRuntime as SessionRuntimeContract,
  type SessionRuntimeRecord,
  type Snapshot,
  type StoragePressureWait,
  type TakeoverControlRequest,
  type TerminateSessionRequest,
  type WriteSessionInputRequest,
} from "@agents-fleet/contracts";
import { type ChallengePreview, hashPreviewFact } from "../confirmation/challenge-issuer.js";
import type { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { transact } from "../storage/database.js";
import { appendDomainEvent } from "../storage/domain-event-store.js";
import { StoreError } from "../storage/task-store.js";
import { ByteJournal, DataIntegrityFailure } from "./byte-journal.js";
import { durableWriteContentObject } from "./content-object-io.js";
import {
  type InputIntentStep,
  InputIntentStore,
  reconcileInputIntents,
} from "./input-intent-store.js";
import type {
  ProcessSupervisor,
  PtyExitEvent,
  SupervisedPtyProcess,
} from "./process-supervisor.js";
import { SnapshotCoordinator } from "./snapshot-coordinator.js";
import { reconcileStore, type StoreDataGap } from "./store-reconciliation.js";

const DEFAULT_BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), "bootstrap.mjs");
const CONTROL_LEASE_TTL_MS = 15_000;

type LaunchStep =
  | "afterBootstrapReceipt"
  | "afterAuthorize"
  | "afterCommitSent"
  | "afterAgentObserved";

interface SessionRuntimeOptions {
  readonly db: DatabaseSync;
  readonly storeDir: string;
  readonly processSupervisor: ProcessSupervisor;
  readonly bootstrapPath?: string;
  readonly bootstrapProcessProbePath?: string;
  readonly bootstrapTimeoutMs?: number;
  readonly receiptTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly processProbe?: (pid: number) => ProcessProbe;
  readonly waitForExecBarrier?: (barrier: ExecBarrier, timeoutMs: number) => Promise<boolean>;
  readonly now?: () => number;
  readonly confirmations?: PersistentChallengeIssuer;
  /** RT-T-11 crash injection at protocol boundaries. */
  readonly onLaunchStep?: (step: LaunchStep) => void;
  /** RT-T-24 failure injection at Input Intent durability boundaries. */
  readonly onInputStep?: (step: InputIntentStep, commandId: string) => void;
}

interface LaunchIntentRow {
  readonly launch_nonce: string;
  readonly attempt_id: string;
  readonly command_id: string;
  readonly slot_lease_id: string;
  readonly planned_session_id: string;
  readonly agent_id: string;
  readonly argv_hash: string;
  readonly launch_spec_json: string;
  readonly launch_spec_hash: string;
  readonly status: LaunchIntent.LaunchIntentStatus;
  readonly bootstrap_pid: number | null;
  readonly bootstrap_pgid: number | null;
  readonly bootstrap_started_at: string | null;
  readonly commit_sent_at: string | null;
  readonly result_json: string | null;
}

interface ProcessReceipt {
  readonly nonce: string;
  readonly argvHash: string;
  readonly pid: number;
  readonly pgid: number;
  readonly lstart: string;
  readonly command?: string;
  readonly identityCoverage?: "full" | "pid-pgid";
}

interface ExecBarrier {
  readonly config: {
    readonly host: string;
    readonly port: number;
    readonly token: string;
  };
  waitForAuthentication(timeoutMs: number): Promise<boolean>;
  waitForClose(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

interface OutputCaptureState {
  nextSeq: number;
  active: boolean;
  pendingBytes: number;
  readonly pending: Uint8Array[];
}

interface OwnedProcess {
  readonly process: SupervisedPtyProcess;
  readonly processGroupId: number;
}

type ProcessProbe =
  | {
      readonly kind: "observed";
      readonly identity: {
        readonly pgid: number;
        readonly lstart: string;
        readonly command: string;
      };
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" };

type PrimaryOutcome = "Succeeded" | "Failed" | "Interrupted" | "Uncertain";

interface AttemptSettlement {
  readonly status: PrimaryOutcome | "Cancelled";
  readonly reason: string | null;
  readonly eventType:
    | "attempt-succeeded"
    | "attempt-failed"
    | "attempt-cancelled"
    | "attempt-interrupted"
    | "attempt-uncertain";
}

const PRIMARY_OUTCOME_SETTLEMENTS = {
  Succeeded: {
    status: "Succeeded",
    reason: null,
    eventType: "attempt-succeeded",
  },
  Failed: {
    status: "Failed",
    reason: "AgentExited",
    eventType: "attempt-failed",
  },
  Interrupted: {
    status: "Interrupted",
    reason: "AgentInterrupted",
    eventType: "attempt-interrupted",
  },
  Uncertain: {
    status: "Uncertain",
    reason: "AgentOutcomeUncertain",
    eventType: "attempt-uncertain",
  },
} as const satisfies Record<PrimaryOutcome, AttemptSettlement>;

const STOPPING_SETTLEMENT = {
  status: "Cancelled",
  reason: "StopRequested",
  eventType: "attempt-cancelled",
} as const satisfies AttemptSettlement;

interface RestartAliveSessionRow {
  readonly session_id: string;
  readonly attempt_id: string;
  readonly task_id: string;
  readonly status: Attempt.AttemptStatus;
  readonly generation: number;
  readonly process_pid: number | null;
  readonly process_pgid: number | null;
  readonly process_started_at: string | null;
  readonly process_command: string | null;
}

interface RestartSessionObservation {
  readonly row: RestartAliveSessionRow;
  readonly disposition: "OrphanFound" | "Probing" | "ConfirmedAbsent";
  readonly reason: string;
}

interface RestartAttemptResolution {
  readonly status: "Interrupted" | "Uncertain";
  readonly disposition: "OrphanFound" | "Probing" | "ConfirmedAbsent";
  readonly reason: string;
}

const classifyRestartSession = (
  row: RestartAliveSessionRow,
  probe: ProcessProbe,
): RestartSessionObservation => {
  const recordedIdentityIsFull =
    row.process_pgid !== null && row.process_started_at !== null && row.process_command !== null;
  const identityMatches =
    probe.kind === "observed" &&
    recordedIdentityIsFull &&
    probe.identity.pgid === row.process_pgid &&
    probe.identity.lstart === row.process_started_at &&
    probe.identity.command === row.process_command;
  if (identityMatches) {
    return {
      row,
      disposition: "OrphanFound",
      reason: "orphan-process-identity-matched",
    };
  }
  if (probe.kind === "unavailable") {
    return { row, disposition: "Probing", reason: "process-identity-unavailable" };
  }
  if (probe.kind === "observed" && !recordedIdentityIsFull) {
    return {
      row,
      disposition: "Probing",
      reason: "recorded-process-identity-incomplete",
    };
  }
  return {
    row,
    disposition: "ConfirmedAbsent",
    reason: probe.kind === "absent" ? "process-confirmed-absent" : "process-identity-mismatch",
  };
};

const resolveRestartAttempt = (
  observations: readonly RestartSessionObservation[],
  hasDataGap: boolean,
): RestartAttemptResolution => {
  const orphan = observations.find(({ disposition }) => disposition === "OrphanFound");
  if (orphan !== undefined) {
    return { status: "Uncertain", disposition: "OrphanFound", reason: orphan.reason };
  }
  const probing = observations.find(({ disposition }) => disposition === "Probing");
  if (probing !== undefined) {
    return { status: "Uncertain", disposition: "Probing", reason: probing.reason };
  }
  if (hasDataGap) {
    return {
      status: "Uncertain",
      disposition: "ConfirmedAbsent",
      reason: "evidence-gap-with-confirmed-absent",
    };
  }
  return {
    status: "Interrupted",
    disposition: "ConfirmedAbsent",
    reason: observations.some(({ reason }) => reason === "process-identity-mismatch")
      ? "process-identity-mismatch"
      : "process-confirmed-absent",
  };
};

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const readReceipt = (path: string): ProcessReceipt | null => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProcessReceipt>;
    if (
      typeof value.nonce !== "string" ||
      typeof value.argvHash !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.pgid !== "number" ||
      typeof value.lstart !== "string"
    ) {
      return null;
    }
    const identityCoverage =
      value.identityCoverage === "full" || value.identityCoverage === "pid-pgid"
        ? value.identityCoverage
        : value.pgid === value.pid && value.lstart.length > 0
          ? "full"
          : "pid-pgid";
    return { ...(value as ProcessReceipt), identityCoverage };
  } catch {
    return null;
  }
};

export class SessionRuntime implements SessionRuntimeContract {
  readonly #db: DatabaseSync;
  readonly #storeDir: string;
  readonly #processSupervisor: ProcessSupervisor;
  readonly #bootstrapPath: string;
  readonly #bootstrapProcessProbePath: string;
  readonly #bootstrapTimeoutMs: number;
  readonly #receiptTimeoutMs: number;
  readonly #agentTimeoutMs: number;
  readonly #processProbe: (pid: number) => ProcessProbe;
  readonly #waitForExecBarrier: (barrier: ExecBarrier, timeoutMs: number) => Promise<boolean>;
  readonly #now: () => number;
  readonly #confirmations: PersistentChallengeIssuer | undefined;
  readonly #onLaunchStep: ((step: LaunchStep) => void) | undefined;
  readonly #onInputStep: ((step: InputIntentStep, commandId: string) => void) | undefined;
  readonly #journal: ByteJournal;
  readonly #snapshotCoordinator: SnapshotCoordinator;
  readonly #launches = new Map<string, Promise<LaunchSessionResult>>();
  readonly #processes = new Map<string, SupervisedPtyProcess>();
  readonly #outputSubscriptions = new Map<string, () => void>();
  readonly #outputCaptures = new Map<string, OutputCaptureState>();
  readonly #exitSubscriptions = new Map<string, () => void>();
  readonly #exitPromises = new Map<string, Promise<void>>();
  readonly #pendingExits = new Map<string, PtyExitEvent>();
  readonly #streamFailures = new Map<string, unknown>();
  readonly #snapshotTasks = new Map<string, Promise<void>>();

  constructor(options: SessionRuntimeOptions) {
    this.#db = options.db;
    this.#storeDir = options.storeDir;
    this.#processSupervisor = options.processSupervisor;
    this.#bootstrapPath = options.bootstrapPath ?? DEFAULT_BOOTSTRAP;
    this.#bootstrapProcessProbePath = options.bootstrapProcessProbePath ?? "/bin/ps";
    this.#bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 10_000;
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 3_000;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 3_000;
    this.#processProbe = options.processProbe ?? probeProcess;
    this.#waitForExecBarrier =
      options.waitForExecBarrier ??
      (async (barrier, timeoutMs) => await barrier.waitForClose(timeoutMs));
    this.#now = options.now ?? Date.now;
    this.#confirmations = options.confirmations;
    this.#onLaunchStep = options.onLaunchStep;
    this.#onInputStep = options.onInputStep;
    this.#journal = new ByteJournal({ storeDir: options.storeDir, db: options.db });
    this.#snapshotCoordinator = new SnapshotCoordinator({
      db: options.db,
      storeDir: options.storeDir,
      journal: this.#journal,
      now: this.#now,
    });
  }

  async launch(
    prepared: PreparedLaunch,
    validation: LaunchValidation,
  ): Promise<LaunchSessionResult> {
    const persisted = this.#intent(prepared.launchNonce);
    this.#assertPreparedMatches(prepared, persisted);
    if (persisted.result_json !== null) {
      return JSON.parse(persisted.result_json) as LaunchSessionResult;
    }

    const inFlight = this.#launches.get(prepared.launchNonce);
    if (inFlight !== undefined) return await inFlight;
    const launch = this.#launchOnce(prepared, validation);
    this.#launches.set(prepared.launchNonce, launch);
    try {
      return await launch;
    } finally {
      this.#launches.delete(prepared.launchNonce);
    }
  }

  attach(sessionId: string): AttachResult {
    const session = this.inspectSession(sessionId);
    if (session === null) {
      throw new StoreError("NotFound", `Session ${sessionId} does not exist`);
    }
    const attachmentId = `attachment-${randomUUID()}`;
    const now = new Date(this.#now()).toISOString();
    transact(
      this.#db,
      () => {
        this.#db
          .prepare(
            `INSERT INTO attachments
               (attachment_id, session_id, generation, status, created_at, updated_at)
             VALUES (?, ?, ?, 'Active', ?, ?)`,
          )
          .run(attachmentId, session.sessionId, session.generation, now, now);
      },
      this.#now,
    );

    const snapshot = this.readSessionSnapshot(session.sessionId);
    return {
      attachmentId: attachmentId as AttachmentId,
      mode: Attachment.attachmentModeFor(session.availability),
      sessionId: session.sessionId as SessionId,
      generation: session.generation as Generation,
      snapshot,
    };
  }

  acquireControl(attachmentId: string): ControlLease {
    const attachment = this.#db
      .prepare(
        `SELECT attachments.session_id, attachments.generation, attachments.status,
                sessions.availability, sessions.generation AS session_generation
         FROM attachments
         JOIN sessions ON sessions.session_id = attachments.session_id
         WHERE attachments.attachment_id = ?`,
      )
      .get(attachmentId) as
      | {
          readonly session_id: string;
          readonly generation: number;
          readonly status: Attachment.AttachmentStatus;
          readonly availability: SessionRuntimeRecord["availability"];
          readonly session_generation: number;
        }
      | undefined;
    if (attachment === undefined) {
      throw new StoreError("NotFound", `Attachment ${attachmentId} does not exist`);
    }
    if (
      attachment.status !== "Active" ||
      attachment.availability !== "Alive" ||
      attachment.generation !== attachment.session_generation
    ) {
      throw new StoreError(
        "CapabilityUnavailable",
        "Control is available only to an Active Live Attachment",
      );
    }

    const now = this.#now();
    const lease = transact(
      this.#db,
      () => {
        this.#db
          .prepare("DELETE FROM control_leases WHERE session_id = ? AND expires_at <= ?")
          .run(attachment.session_id, now);
        const current = this.#db
          .prepare(
            "SELECT attachment_id FROM control_leases WHERE session_id = ? AND expires_at > ?",
          )
          .get(attachment.session_id, now) as { readonly attachment_id: string } | undefined;
        if (current !== undefined) {
          throw new StoreError(
            "Conflict",
            `Session already has a Control Lease holder (${current.attachment_id})`,
          );
        }

        this.#db
          .prepare("UPDATE sessions SET fencing_counter = fencing_counter + 1 WHERE session_id = ?")
          .run(attachment.session_id);
        const counter = this.#db
          .prepare("SELECT fencing_counter FROM sessions WHERE session_id = ?")
          .get(attachment.session_id) as { readonly fencing_counter: number };
        const expiresAt = now + CONTROL_LEASE_TTL_MS;
        const timestamp = new Date(now).toISOString();
        this.#db
          .prepare(
            `INSERT INTO control_leases
               (session_id, generation, attachment_id, fencing_token, expires_at,
                granted_at, renewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attachment.session_id,
            attachment.generation,
            attachmentId,
            counter.fencing_counter,
            expiresAt,
            timestamp,
            timestamp,
          );
        return { fencingToken: counter.fencing_counter, expiresAt };
      },
      this.#now,
    );

    return {
      sessionId: attachment.session_id as SessionId,
      generation: attachment.generation as Generation,
      attachmentId: attachmentId as AttachmentId,
      fencingToken: lease.fencingToken as ControlLease["fencingToken"],
      expiresAt: lease.expiresAt,
    };
  }

  renewControl(lease: ControlLease): ControlLease {
    const now = this.#now();
    const expiresAt = now + CONTROL_LEASE_TTL_MS;
    const renewed = transact(
      this.#db,
      () =>
        this.#db
          .prepare(
            `UPDATE control_leases
             SET expires_at = ?, renewed_at = ?
             WHERE session_id = ?
               AND generation = ?
               AND attachment_id = ?
               AND fencing_token = ?
               AND expires_at > ?
               AND EXISTS (
                 SELECT 1
                 FROM attachments
                 JOIN sessions ON sessions.session_id = attachments.session_id
                 WHERE attachments.attachment_id = control_leases.attachment_id
                   AND attachments.status = 'Active'
                   AND attachments.generation = control_leases.generation
                   AND sessions.availability = 'Alive'
                   AND sessions.generation = control_leases.generation
               )`,
          )
          .run(
            expiresAt,
            new Date(now).toISOString(),
            lease.sessionId,
            lease.generation,
            lease.attachmentId,
            lease.fencingToken,
            now,
          ).changes,
      this.#now,
    );
    if (renewed !== 1) {
      throw new StoreError("StaleControlLease", "Control Lease is stale or expired");
    }
    return { ...lease, expiresAt };
  }

  issueTakeoverControlChallenge(
    attachmentId: string,
    confirmedHolder: ControlLease,
  ): ConfirmationChallenge {
    const { target, holder } = this.#takeoverControlFacts(attachmentId, confirmedHolder);
    return this.#requireConfirmations().issue(
      this.#takeoverControlPreview(attachmentId, confirmedHolder, target, holder),
    );
  }

  takeoverControl(request: TakeoverControlRequest): ControlLease {
    const now = this.#now();
    const replacement = transact(
      this.#db,
      () => {
        const { target, holder } = this.#takeoverControlFacts(
          request.attachmentId,
          request.confirmedHolder,
        );
        this.#consumeSideEffectConfirmation(
          request.confirmationReceipt,
          this.#takeoverControlPreview(
            request.attachmentId,
            request.confirmedHolder,
            target,
            holder,
          ),
        );

        this.#db
          .prepare("UPDATE sessions SET fencing_counter = fencing_counter + 1 WHERE session_id = ?")
          .run(target.session_id);
        const counter = this.#db
          .prepare("SELECT fencing_counter FROM sessions WHERE session_id = ?")
          .get(target.session_id) as { readonly fencing_counter: number };
        const expiresAt = now + CONTROL_LEASE_TTL_MS;
        const timestamp = new Date(now).toISOString();
        this.#db
          .prepare(
            `UPDATE control_leases
             SET attachment_id = ?, fencing_token = ?, expires_at = ?, granted_at = ?, renewed_at = ?
             WHERE session_id = ?`,
          )
          .run(
            request.attachmentId,
            counter.fencing_counter,
            expiresAt,
            timestamp,
            timestamp,
            target.session_id,
          );
        this.#appendLifecycleEvent({
          taskId: target.task_id,
          attemptId: target.attempt_id,
          sessionId: target.session_id,
          type: "control-lease-taken-over",
          payload: {
            previousAttachmentId: holder.attachment_id,
            attachmentId: request.attachmentId,
            fencingToken: counter.fencing_counter,
          },
        });
        return { target, fencingToken: counter.fencing_counter, expiresAt };
      },
      this.#now,
    );

    return {
      sessionId: replacement.target.session_id as SessionId,
      generation: replacement.target.generation as Generation,
      attachmentId: request.attachmentId as AttachmentId,
      fencingToken: replacement.fencingToken as ControlLease["fencingToken"],
      expiresAt: replacement.expiresAt,
    };
  }

  #takeoverControlFacts(
    attachmentId: string,
    confirmedHolder: ControlLease,
  ): {
    readonly target: {
      readonly session_id: string;
      readonly generation: number;
      readonly status: Attachment.AttachmentStatus;
      readonly availability: SessionRuntimeRecord["availability"];
      readonly session_generation: number;
      readonly attempt_id: string;
      readonly task_id: string;
    };
    readonly holder: {
      readonly attachment_id: string;
      readonly fencing_token: number;
    };
  } {
    const target = this.#db
      .prepare(
        `SELECT attachments.session_id, attachments.generation, attachments.status,
                sessions.availability, sessions.generation AS session_generation,
                sessions.attempt_id, attempts.task_id
         FROM attachments
         JOIN sessions ON sessions.session_id = attachments.session_id
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE attachments.attachment_id = ?`,
      )
      .get(attachmentId) as
      | {
          readonly session_id: string;
          readonly generation: number;
          readonly status: Attachment.AttachmentStatus;
          readonly availability: SessionRuntimeRecord["availability"];
          readonly session_generation: number;
          readonly attempt_id: string;
          readonly task_id: string;
        }
      | undefined;
    if (target === undefined) {
      throw new StoreError("NotFound", `Attachment ${attachmentId} does not exist`);
    }
    if (
      target.status !== "Active" ||
      target.availability !== "Alive" ||
      target.generation !== target.session_generation
    ) {
      throw new StoreError(
        "CapabilityUnavailable",
        "Control is available only to an Active Live Attachment",
      );
    }
    if (
      confirmedHolder.sessionId !== target.session_id ||
      confirmedHolder.generation !== target.generation
    ) {
      throw new StoreError("ConfirmationRequired", "Confirmed Control Lease target has drifted");
    }

    const holder = this.#db
      .prepare(
        `SELECT attachment_id, fencing_token
         FROM control_leases
         WHERE session_id = ? AND generation = ? AND expires_at > ?`,
      )
      .get(target.session_id, target.generation, this.#now()) as
      | { readonly attachment_id: string; readonly fencing_token: number }
      | undefined;
    if (
      holder === undefined ||
      holder.attachment_id !== confirmedHolder.attachmentId ||
      holder.fencing_token !== confirmedHolder.fencingToken
    ) {
      throw new StoreError("ConfirmationRequired", "Confirmed Control Lease holder has drifted");
    }
    return { target, holder };
  }

  closeAttachment(attachmentId: string): void {
    const attachment = this.#db
      .prepare(
        `SELECT attachments.session_id, attachments.status,
                sessions.attempt_id, attempts.task_id
         FROM attachments
         JOIN sessions ON sessions.session_id = attachments.session_id
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE attachments.attachment_id = ?`,
      )
      .get(attachmentId) as
      | {
          readonly session_id: string;
          readonly status: Attachment.AttachmentStatus;
          readonly attempt_id: string;
          readonly task_id: string;
        }
      | undefined;
    if (attachment === undefined) {
      throw new StoreError("NotFound", `Attachment ${attachmentId} does not exist`);
    }
    if (attachment.status !== "Active") return;

    transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE attachments
             SET status = 'Closed', updated_at = ?
             WHERE attachment_id = ? AND status = 'Active'`,
          )
          .run(now, attachmentId);
        this.#db.prepare("DELETE FROM control_leases WHERE attachment_id = ?").run(attachmentId);
        this.#appendLifecycleEvent({
          taskId: attachment.task_id,
          attemptId: attachment.attempt_id,
          sessionId: attachment.session_id,
          type: "attachment-closed",
          payload: { attachmentId },
        });
      },
      this.#now,
    );
  }

  invalidateAttachment(attachmentId: string): void {
    const attachment = this.#db
      .prepare(
        `SELECT attachments.session_id, attachments.status,
                sessions.attempt_id, attempts.task_id
         FROM attachments
         JOIN sessions ON sessions.session_id = attachments.session_id
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE attachments.attachment_id = ?`,
      )
      .get(attachmentId) as
      | {
          readonly session_id: string;
          readonly status: Attachment.AttachmentStatus;
          readonly attempt_id: string;
          readonly task_id: string;
        }
      | undefined;
    if (attachment === undefined) {
      throw new StoreError("NotFound", `Attachment ${attachmentId} does not exist`);
    }
    if (attachment.status !== "Active") return;

    transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE attachments
             SET status = 'Invalidated', updated_at = ?
             WHERE attachment_id = ? AND status = 'Active'`,
          )
          .run(now, attachmentId);
        this.#db.prepare("DELETE FROM control_leases WHERE attachment_id = ?").run(attachmentId);
        this.#appendLifecycleEvent({
          taskId: attachment.task_id,
          attemptId: attachment.attempt_id,
          sessionId: attachment.session_id,
          type: "attachment-invalidated",
          payload: { attachmentId },
        });
      },
      this.#now,
    );
  }

  inspectAttachment(attachmentId: string): AttachmentRuntimeRecord | null {
    const row = this.#db
      .prepare(
        `SELECT attachments.attachment_id, attachments.session_id,
                attachments.generation, attachments.status, sessions.availability
         FROM attachments
         JOIN sessions ON sessions.session_id = attachments.session_id
         WHERE attachments.attachment_id = ?`,
      )
      .get(attachmentId) as
      | {
          readonly attachment_id: string;
          readonly session_id: string;
          readonly generation: number;
          readonly status: Attachment.AttachmentStatus;
          readonly availability: SessionRuntimeRecord["availability"];
        }
      | undefined;
    return row === undefined
      ? null
      : {
          attachmentId: row.attachment_id,
          sessionId: row.session_id,
          generation: row.generation,
          status: row.status,
          mode: Attachment.attachmentModeFor(row.availability),
        };
  }

  async writeSessionInput(request: WriteSessionInputRequest): Promise<InputIntent> {
    const limit = checkLimit(
      FROZEN_RUNTIME_LIMIT_PROFILE,
      "inputIntentBytes",
      request.bytes.byteLength,
    );
    if (!limit.ok) {
      throw new StoreError(
        "InvalidRequest",
        `Input Intent exceeds ${limit.allowed} byte runtime limit`,
      );
    }
    if (this.inspectInputIntent(request.commandId) === null) {
      this.#assertControlLease(request.lease);
    }

    const sink: Pick<SupervisedPtyProcess, "write"> = {
      write: async (bytes: Uint8Array) => {
        const process = this.#assertControlLease(request.lease);
        await process.write(bytes);
      },
    };
    const store = new InputIntentStore({
      storeDir: this.#storeDir,
      db: this.#db,
      ptySink: sink,
      now: this.#now,
      ...(this.#onInputStep === undefined ? {} : { onStep: this.#onInputStep }),
    });
    const dispatched = await store.dispatch({
      commandId: request.commandId,
      sessionId: request.lease.sessionId,
      generation: request.lease.generation,
      attachmentId: request.lease.attachmentId,
      fencingToken: request.lease.fencingToken,
      source: request.source,
      bytes: request.bytes,
    });
    switch (dispatched.status) {
      case "Dispatched":
      case "Uncertain":
        return this.#inputIntent(request.commandId);
      case "DataGap":
        throw new StoreError("DataIntegrityFailure", dispatched.reason);
      case "IdempotencyConflict":
        throw new StoreError(
          "IdempotencyConflict",
          `commandId ${request.commandId} was already used with different input`,
        );
    }
  }

  inspectInputIntent(commandId: string): InputIntent | null {
    const exists = this.#db
      .prepare("SELECT 1 AS present FROM input_intents WHERE command_id = ?")
      .get(commandId);
    return exists === undefined ? null : this.#inputIntent(commandId);
  }

  async resizeSession(request: ResizeSessionRequest): Promise<void> {
    const process = this.#assertControlLease(request.lease);
    if (
      !Number.isSafeInteger(request.cols) ||
      request.cols <= 0 ||
      !Number.isSafeInteger(request.rows) ||
      request.rows <= 0
    ) {
      throw new StoreError("InvalidRequest", "Terminal dimensions must be positive integers");
    }
    await process.resize(request.cols, request.rows);
    transact(
      this.#db,
      () => {
        this.#assertControlLease(request.lease);
        this.#db
          .prepare(
            "UPDATE sessions SET terminal_cols = ?, terminal_rows = ?, updated_at = ? WHERE session_id = ?",
          )
          .run(
            request.cols,
            request.rows,
            new Date(this.#now()).toISOString(),
            request.lease.sessionId,
          );
      },
      this.#now,
    );
  }

  issueTerminateSessionChallenge(
    lease: ControlLease,
    targetCommandId?: string,
  ): ConfirmationChallenge {
    this.#assertControlLease(lease);
    return this.#requireConfirmations().issue(
      this.#terminateSessionPreview(lease, targetCommandId),
    );
  }

  authorizeTerminateSession(request: TerminateSessionRequest): void {
    this.#consumeSideEffectConfirmation(
      request.confirmationReceipt,
      this.#terminateSessionPreview(request.lease, request.commandId),
    );
    this.#assertControlLease(request.lease);
  }

  async terminateSession(request: TerminateSessionRequest): Promise<void> {
    this.authorizeTerminateSession(request);
    await this.terminate(request.lease.sessionId);
  }

  readSessionDelta(attachmentId: string, fromSeq: number): SessionDeltaBatch {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new StoreError("InvalidRequest", "delta fromSeq must be a positive integer");
    }
    const attachment = this.inspectAttachment(attachmentId);
    if (attachment === null) {
      throw new StoreError("NotFound", `Attachment ${attachmentId} does not exist`);
    }
    if (attachment.status !== "Active") {
      throw new StoreError("Conflict", "Attachment is no longer Active");
    }
    const session = this.inspectSession(attachment.sessionId);
    if (session === null) {
      throw new StoreError("NotFound", `Session ${attachment.sessionId} does not exist`);
    }
    if (session.generation !== attachment.generation) {
      throw new StoreError("StaleGeneration", "Attachment generation is stale");
    }

    const durableThroughSeq = this.#journal.durableCursor({
      sessionId: attachment.sessionId,
      generation: attachment.generation,
    });
    const frames: SessionDeltaBatch["frames"][number][] = [];
    let queueBytes = 0;
    let seq = fromSeq;
    while (
      seq <= durableThroughSeq &&
      frames.length < FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueFrames
    ) {
      const bytes = this.#journal.readFrame({
        sessionId: attachment.sessionId,
        generation: attachment.generation,
        seq,
      });
      if (bytes === null) {
        throw new StoreError("DataIntegrityFailure", `durable stream is missing seq ${seq}`);
      }
      const payload = new Uint8Array(bytes);
      const header = {
        frameType: "PtyOutput",
        sessionId: attachment.sessionId as SessionId,
        generation: attachment.generation as Generation,
        seq: seq as Seq,
        payloadLength: payload.byteLength,
      };
      const wireBytes = 4 + Buffer.byteLength(JSON.stringify(header), "utf8") + payload.byteLength;
      if (
        frames.length > 0 &&
        queueBytes + wireBytes > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes
      ) {
        break;
      }
      if (wireBytes > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes) {
        throw new StoreError("StoragePressure", "one durable frame exceeds Attachment queue limit");
      }
      frames.push({ header, bytes: payload });
      queueBytes += wireBytes;
      seq += 1;
    }

    return {
      attachmentId: attachmentId as AttachmentId,
      sessionId: attachment.sessionId as SessionId,
      generation: attachment.generation as Generation,
      durableThroughSeq: durableThroughSeq as Seq,
      nextSeq: seq as Seq,
      frames,
    };
  }

  async createSessionSnapshot(sessionId: string): Promise<Snapshot> {
    const row = this.#db
      .prepare(
        `SELECT generation, terminal_cols, terminal_rows
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          readonly generation: number;
          readonly terminal_cols: number;
          readonly terminal_rows: number;
        }
      | undefined;
    if (row === undefined) {
      throw new StoreError("NotFound", `Session ${sessionId} does not exist`);
    }
    return await this.#snapshotCoordinator.create({
      sessionId,
      generation: row.generation,
      cols: row.terminal_cols,
      rows: row.terminal_rows,
    });
  }

  readSessionSnapshot(sessionId: string): Snapshot {
    const session = this.#db
      .prepare(
        `SELECT generation, terminal_cols, terminal_rows
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          readonly generation: number;
          readonly terminal_cols: number;
          readonly terminal_rows: number;
        }
      | undefined;
    if (session === undefined) {
      throw new StoreError("NotFound", `Session ${sessionId} does not exist`);
    }
    return (
      this.#snapshotCoordinator.read(sessionId, session.generation) ??
      this.#snapshotCoordinator.initial({
        sessionId,
        generation: session.generation,
        cols: session.terminal_cols,
        rows: session.terminal_rows,
      })
    );
  }

  async pauseForStoragePressure(attemptId: string): Promise<StoragePressureWait> {
    const attempt = this.#attempt(attemptId);
    if (attempt.status === "Waiting") {
      if (
        attempt.waiting_reason !== "StoragePressure" ||
        !isResumableAttemptStatus(attempt.resume_status)
      ) {
        throw new StoreError("DataIntegrityFailure", "Waiting Attempt has invalid resume facts");
      }
      return {
        attemptId,
        waitingReason: "StoragePressure",
        resumeStatus: attempt.resume_status,
      };
    }
    if (!isResumableAttemptStatus(attempt.status)) {
      throw new StoreError("Conflict", `Attempt is ${attempt.status}, cannot enter Waiting`);
    }

    const processes = this.#ownedProcessesForAttempt(attemptId);
    if (processes.length === 0) {
      throw new StoreError("Conflict", "Attempt has no owned process to pause");
    }
    const paused: OwnedProcess[] = [];
    try {
      for (const owned of processes) {
        await owned.process.pause(owned.processGroupId);
        paused.push(owned);
      }
      transact(
        this.#db,
        () => {
          const current = this.#attempt(attemptId);
          if (current.status !== attempt.status) {
            throw new StoreError("Conflict", "Attempt changed while entering Waiting");
          }
          this.#transitionAttempt(attemptId, "Waiting");
          this.#db
            .prepare(
              `UPDATE attempts
               SET waiting_reason = 'StoragePressure', resume_status = ?
               WHERE attempt_id = ? AND status = 'Waiting'`,
            )
            .run(attempt.status, attemptId);
          this.#appendLifecycleEvent({
            taskId: attempt.task_id,
            attemptId,
            sessionId: this.#primarySessionIdForAttempt(attemptId),
            type: "attempt-waiting",
            payload: { waitingReason: "StoragePressure", resumeStatus: attempt.status },
          });
        },
        this.#now,
      );
    } catch (error) {
      await Promise.allSettled(
        paused.map(async (owned) => await owned.process.resume(owned.processGroupId)),
      );
      throw error;
    }
    return {
      attemptId,
      waitingReason: "StoragePressure",
      resumeStatus: attempt.status,
    };
  }

  async resumeFromStoragePressure(
    attemptId: string,
    validation: LaunchValidation,
  ): Promise<ResumableAttemptStatus> {
    const attempt = this.#attempt(attemptId);
    if (
      attempt.status !== "Waiting" ||
      attempt.waiting_reason !== "StoragePressure" ||
      !isResumableAttemptStatus(attempt.resume_status)
    ) {
      throw new StoreError("Conflict", "Attempt is not waiting for StoragePressure");
    }
    const resumeStatus = attempt.resume_status;
    let verified = false;
    try {
      verified = await validation.revalidate();
    } catch {
      throw new StoreError("Conflict", "resume facts could not be verified");
    }
    if (!verified) throw new StoreError("Conflict", "resume facts drifted");

    const processes = this.#ownedProcessesForAttempt(attemptId);
    if (processes.length === 0) {
      throw new StoreError("Conflict", "Attempt has no owned process to resume");
    }
    const resumed: OwnedProcess[] = [];
    try {
      for (const owned of processes) {
        await owned.process.resume(owned.processGroupId);
        resumed.push(owned);
      }
      transact(
        this.#db,
        () => {
          const current = this.#attempt(attemptId);
          if (
            current.status !== "Waiting" ||
            current.waiting_reason !== "StoragePressure" ||
            current.resume_status !== resumeStatus
          ) {
            throw new StoreError("Conflict", "Waiting facts changed before resume");
          }
          this.#transitionAttempt(attemptId, resumeStatus);
          this.#appendLifecycleEvent({
            taskId: attempt.task_id,
            attemptId,
            sessionId: this.#primarySessionIdForAttempt(attemptId),
            type: "attempt-resumed",
            payload: { resumedStatus: resumeStatus },
          });
        },
        this.#now,
      );
    } catch (error) {
      await Promise.allSettled(
        resumed.map(async (owned) => await owned.process.pause(owned.processGroupId)),
      );
      throw error;
    }
    return resumeStatus;
  }

  async terminate(sessionId: string): Promise<void> {
    const process = this.#processes.get(sessionId);
    if (process === undefined) return;
    this.#outputSubscriptions.get(sessionId)?.();
    this.#outputSubscriptions.delete(sessionId);
    const exited = this.#exitPromises.get(sessionId);
    await process.terminate().catch(() => {});
    if (exited !== undefined) {
      await Promise.race([exited, sleep(1_000)]);
    }
    const snapshotTask = this.#snapshotTasks.get(sessionId);
    if (snapshotTask !== undefined) await snapshotTask;
    this.#processes.delete(sessionId);
  }

  inspectSession(sessionId: string): SessionRuntimeRecord | null {
    const row = this.#db
      .prepare(
        "SELECT session_id, attempt_id, generation, availability FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          readonly session_id: string;
          readonly attempt_id: string;
          readonly generation: number;
          readonly availability: SessionRuntimeRecord["availability"];
        }
      | undefined;
    return row === undefined
      ? null
      : {
          sessionId: row.session_id,
          attemptId: row.attempt_id,
          generation: row.generation,
          availability: row.availability,
        };
  }

  reconcileAfterRestart(): RestartReconciliationReport {
    const storage = reconcileStore(this.#storeDir, this.#db);
    const inputs = reconcileInputIntents(this.#storeDir, this.#db);
    const attemptsWithDataGaps = this.#recordStorageDataGaps(storage.dataGaps);
    const alive = this.#db
      .prepare(
        `SELECT sessions.session_id, sessions.attempt_id, sessions.process_pid,
                sessions.process_pgid, sessions.process_started_at, sessions.process_command,
                sessions.generation, attempts.task_id, attempts.status
         FROM sessions
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE sessions.availability = 'Alive'
         ORDER BY sessions.created_at, sessions.session_id`,
      )
      .all() as unknown as RestartAliveSessionRow[];
    const actions: RestartReconciliationReport["actions"][number][] = [];
    const observationsByAttempt = new Map<string, RestartSessionObservation[]>();

    for (const row of alive) {
      transact(
        this.#db,
        () => {
          const now = new Date(this.#now()).toISOString();
          this.#db
            .prepare(
              `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
               VALUES (?, 'Probing', ?)
               ON CONFLICT (attempt_id) DO UPDATE
               SET disposition = 'Probing', updated_at = excluded.updated_at`,
            )
            .run(row.attempt_id, now);
          this.#appendLifecycleEvent({
            taskId: row.task_id,
            attemptId: row.attempt_id,
            sessionId: row.session_id,
            type: "process-probe-started",
            payload: {},
          });
        },
        this.#now,
      );

      const probe =
        row.process_pid === null
          ? ({ kind: "unavailable" } as const)
          : this.#processProbe(row.process_pid);
      const observation = classifyRestartSession(row, probe);
      const attemptObservations = observationsByAttempt.get(row.attempt_id) ?? [];
      attemptObservations.push(observation);
      observationsByAttempt.set(row.attempt_id, attemptObservations);
    }

    for (const [attemptId, observations] of observationsByAttempt) {
      const first = observations[0];
      if (first === undefined) continue;
      const resolution = resolveRestartAttempt(observations, attemptsWithDataGaps.has(attemptId));
      transact(
        this.#db,
        () => {
          const now = new Date(this.#now()).toISOString();
          for (const observation of observations) {
            this.#db
              .prepare(
                "UPDATE sessions SET availability = 'Lost', updated_at = ? WHERE session_id = ? AND availability = 'Alive'",
              )
              .run(now, observation.row.session_id);
            this.#db
              .prepare("DELETE FROM control_leases WHERE session_id = ?")
              .run(observation.row.session_id);
            this.#appendLifecycleEvent({
              taskId: observation.row.task_id,
              attemptId,
              sessionId: observation.row.session_id,
              type: "session-lost",
              payload: {
                reason: observation.reason,
                processDisposition: observation.disposition,
              },
            });
          }
          if (!Attempt.isTerminalAttempt(first.row.status)) {
            this.#transitionAttempt(attemptId, resolution.status);
            this.#setAttemptTerminalReason(attemptId, resolution.reason);
            this.#db
              .prepare(
                `UPDATE attempts
                 SET primary_outcome = COALESCE(primary_outcome, ?)
                 WHERE attempt_id = ?`,
              )
              .run(resolution.status, attemptId);
          }
          this.#db
            .prepare(
              `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT (attempt_id) DO UPDATE
               SET disposition = excluded.disposition, updated_at = excluded.updated_at`,
            )
            .run(attemptId, resolution.disposition, now);
          if (!ProcessDisposition.dispositionHoldsSlot(resolution.disposition)) {
            this.#releaseSlot(attemptId, now);
          }
        },
        this.#now,
      );
      for (const observation of observations) {
        actions.push({
          action: "marked-lost",
          attemptId,
          sessionId: observation.row.session_id,
        });
      }
    }

    const prepared = this.#db
      .prepare(
        `SELECT launch_intents.*, attempts.task_id
         FROM launch_intents
         JOIN attempts ON attempts.attempt_id = launch_intents.attempt_id
         WHERE attempts.status = 'Starting'
           AND launch_intents.status = 'Prepared'
           AND launch_intents.result_json IS NULL
         ORDER BY launch_intents.created_at, launch_intents.launch_nonce`,
      )
      .all() as unknown as (LaunchIntentRow & { readonly task_id: string })[];
    for (const row of prepared) {
      const launch = preparedLaunchFromRow(row);
      const receiptPath = join(
        this.#storeDir,
        "launch",
        row.launch_nonce,
        "bootstrap-receipt.json",
      );
      if (!existsSync(receiptPath)) {
        actions.push({
          action: "resume-prepared",
          attemptId: row.attempt_id,
          launchNonce: row.launch_nonce,
          preparedLaunch: launch,
        });
        continue;
      }
      this.#abort(launch, "bootstrap-lost-before-authorize");
      this.#writeSignal(join("launch", row.launch_nonce), "abort-launch.json", {
        launchNonce: row.launch_nonce,
      });
      actions.push({
        action: "aborted-bootstrap-lost",
        attemptId: row.attempt_id,
        launchNonce: row.launch_nonce,
      });
    }

    const authorized = this.#db
      .prepare(
        `SELECT launch_intents.*, attempts.task_id
         FROM launch_intents
         JOIN attempts ON attempts.attempt_id = launch_intents.attempt_id
         WHERE attempts.status = 'Starting'
           AND launch_intents.status = 'Authorized'
           AND launch_intents.result_json IS NULL
         ORDER BY launch_intents.created_at, launch_intents.launch_nonce`,
      )
      .all() as unknown as (LaunchIntentRow & { readonly task_id: string })[];
    for (const row of authorized) {
      const commitPath = join(this.#storeDir, "launch", row.launch_nonce, "commit-launch.json");
      const launch = preparedLaunchFromRow(row);
      if (row.commit_sent_at !== null || existsSync(commitPath)) {
        const receipt = readReceipt(
          join(this.#storeDir, "launch", row.launch_nonce, "exec-receipt.json"),
        );
        const probe =
          receipt === null ? ({ kind: "unavailable" } as const) : this.#processProbe(receipt.pid);
        const identityMatches =
          receipt !== null &&
          receipt.identityCoverage === "full" &&
          probe.kind === "observed" &&
          probe.identity.pgid === receipt.pgid &&
          probe.identity.lstart === receipt.lstart &&
          commandMatchesExecutable(probe.identity.command, launch.launchSpec.executablePath);
        const disposition = identityMatches
          ? "OrphanFound"
          : probe.kind === "unavailable" ||
              (probe.kind === "observed" && receipt?.identityCoverage !== "full")
            ? "Probing"
            : "ConfirmedAbsent";
        this.#markUncertain(launch, "commit-delivery-unknown-after-restart", disposition);
        actions.push({
          action: "marked-uncertain",
          attemptId: row.attempt_id,
          launchNonce: row.launch_nonce,
        });
        continue;
      }
      this.#abort(launch, "commit-never-sent-after-restart");
      this.#writeSignal(join("launch", row.launch_nonce), "abort-launch.json", {
        launchNonce: row.launch_nonce,
      });
      actions.push({
        action: "aborted-before-commit",
        attemptId: row.attempt_id,
        launchNonce: row.launch_nonce,
      });
    }
    this.#reconcileSlotLeases();
    return {
      actions,
      dataIntegrity: {
        adoptedOrphanCount: storage.adoptedOrphans.length,
        isolatedOrphanCount: storage.isolatedOrphans.length,
        dataGapCount: storage.dataGaps.length,
        verifiedChunks: storage.verifiedChunks,
        uncertainInputIntentCount: inputs.markedUncertain.length,
        inputDataGapCount: inputs.dataGaps.length,
        isolatedInputOrphanCount: inputs.isolatedOrphans.length,
      },
    };
  }

  async rebuildInvalidSnapshotsAfterRestart(): Promise<RestartSnapshotRebuildReport> {
    const rows = this.#db
      .prepare(
        `SELECT sessions.session_id, sessions.attempt_id, sessions.generation,
                attempts.task_id
         FROM sessions
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         ORDER BY sessions.created_at, sessions.session_id`,
      )
      .all() as unknown as {
      readonly session_id: string;
      readonly attempt_id: string;
      readonly generation: number;
      readonly task_id: string;
    }[];
    const rebuilt: RestartSnapshotRebuildReport["rebuilt"][number][] = [];
    const skippedForDataGap: RestartSnapshotRebuildReport["skippedForDataGap"][number][] = [];

    for (const row of rows) {
      if (this.#snapshotCoordinator.read(row.session_id, row.generation) !== null) continue;
      try {
        const snapshot = await this.createSessionSnapshot(row.session_id);
        const item = {
          attemptId: row.attempt_id,
          sessionId: row.session_id,
          generation: row.generation,
          coversThroughSeq: snapshot.coversThroughSeq,
        };
        rebuilt.push(item);
        transact(
          this.#db,
          () => {
            this.#appendLifecycleEvent({
              taskId: row.task_id,
              attemptId: row.attempt_id,
              sessionId: row.session_id,
              type: "snapshot-rebuilt-after-reconciliation",
              payload: {
                sessionId: row.session_id,
                generation: row.generation,
                coversThroughSeq: snapshot.coversThroughSeq,
              },
            });
          },
          this.#now,
        );
      } catch (error) {
        if (!(error instanceof DataIntegrityFailure)) throw error;
        const item = {
          attemptId: row.attempt_id,
          sessionId: row.session_id,
          generation: row.generation,
        };
        skippedForDataGap.push(item);
        transact(
          this.#db,
          () => {
            this.#appendLifecycleEvent({
              taskId: row.task_id,
              attemptId: row.attempt_id,
              sessionId: row.session_id,
              type: "snapshot-rebuild-skipped-data-gap",
              payload: {
                sessionId: row.session_id,
                generation: row.generation,
              },
            });
          },
          this.#now,
        );
      }
    }
    return { rebuilt, skippedForDataGap };
  }

  readDurableFrame(frame: DurableFrameRef): Uint8Array | null {
    const failure = this.#streamFailures.get(`${frame.sessionId}:${frame.generation}`);
    if (failure !== undefined) throw failure;
    return this.#journal.readFrame(frame);
  }

  async #launchOnce(
    prepared: PreparedLaunch,
    validation: LaunchValidation,
  ): Promise<LaunchSessionResult> {
    const execBarrier = await createExecBarrier();
    try {
      return await this.#launchWithExecBarrier(prepared, validation, execBarrier);
    } finally {
      await execBarrier.close();
    }
  }

  async #launchWithExecBarrier(
    prepared: PreparedLaunch,
    validation: LaunchValidation,
    execBarrier: ExecBarrier,
  ): Promise<LaunchSessionResult> {
    const launchDir = join("launch", prepared.launchNonce);
    const config = {
      launchNonce: prepared.launchNonce,
      argvHash: this.#intent(prepared.launchNonce).argv_hash,
      timeoutMs: this.#bootstrapTimeoutMs,
      launchSpec: prepared.launchSpec,
      execBarrier: execBarrier.config,
      processProbePath: this.#bootstrapProcessProbePath,
    };
    const written = durableWriteContentObject({
      storeDir: this.#storeDir,
      relativeDir: launchDir,
      finalName: "bootstrap-config.json",
      bytes: Buffer.from(JSON.stringify(config)),
    });
    const configPath = join(this.#storeDir, written.relativePath);
    const bootstrapProcess = this.#processSupervisor.spawn({
      executablePath: processExecPath(),
      args: [this.#bootstrapPath, "--config", configPath],
      cwd: this.#storeDir,
      // Pin LC_ALL so ps lstart output is locale-stable and comparable with probeProcess.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      cols: 80,
      rows: 24,
    });
    this.#processes.set(prepared.plannedSessionId, bootstrapProcess);
    this.#captureOutput(prepared, bootstrapProcess);
    this.#captureExit(prepared, bootstrapProcess);

    const receipt = await this.#waitForReceipt(
      join(this.#storeDir, launchDir, "bootstrap-receipt.json"),
      this.#receiptTimeoutMs,
    );
    const barrierAuthenticated = await execBarrier.waitForAuthentication(this.#receiptTimeoutMs);
    if (
      receipt === null ||
      !barrierAuthenticated ||
      receipt.nonce !== prepared.launchNonce ||
      receipt.argvHash !== config.argvHash ||
      receipt.pid !== bootstrapProcess.pid
    ) {
      await bootstrapProcess.terminate();
      this.#forgetProcess(prepared.plannedSessionId);
      return this.#abort(prepared, "bootstrap-receipt-lost");
    }

    this.#onLaunchStep?.("afterBootstrapReceipt");
    this.#authorize(prepared, receipt);
    this.#onLaunchStep?.("afterAuthorize");
    let validationFailure: "launch-facts-drifted" | "launch-facts-unverifiable" | null = null;
    try {
      if (!(await validation.revalidate())) validationFailure = "launch-facts-drifted";
    } catch {
      validationFailure = "launch-facts-unverifiable";
    }
    if (validationFailure !== null) {
      const result = this.#abort(prepared, validationFailure);
      this.#writeSignal(launchDir, "abort-launch.json", {
        launchNonce: prepared.launchNonce,
      });
      await bootstrapProcess.terminate();
      this.#forgetProcess(prepared.plannedSessionId);
      return result;
    }

    this.#writeSignal(launchDir, "commit-launch.json", {
      launchNonce: prepared.launchNonce,
      argvHash: config.argvHash,
    });
    this.#recordCommitSent(prepared.launchNonce);
    this.#onLaunchStep?.("afterCommitSent");

    const agent = await this.#waitForAgent({
      receiptPath: join(this.#storeDir, launchDir, "exec-receipt.json"),
      failurePath: join(this.#storeDir, launchDir, "exec-failure.json"),
      timeoutMs: this.#agentTimeoutMs,
      prepared,
      execBarrier,
    });
    if (
      agent === null ||
      agent.nonce !== prepared.launchNonce ||
      agent.argvHash !== config.argvHash
    ) {
      return this.#markUncertain(prepared, "agent-not-observed-after-commit");
    }

    this.#onLaunchStep?.("afterAgentObserved");
    const result = this.#finalizeRunning(prepared, agent);
    this.#activateOutputCapture(prepared.plannedSessionId);
    this.#flushPendingExit(prepared);
    return result;
  }

  #captureOutput(prepared: PreparedLaunch, process: SupervisedPtyProcess): void {
    const capture: OutputCaptureState = {
      nextSeq:
        this.#journal.durableCursor({
          sessionId: prepared.plannedSessionId,
          generation: 1,
        }) + 1,
      active: false,
      pendingBytes: 0,
      pending: [],
    };
    this.#outputCaptures.set(prepared.plannedSessionId, capture);
    const streamKey = `${prepared.plannedSessionId}:1`;
    const unsubscribe = process.onOutput((bytes) => {
      if (this.#streamFailures.has(streamKey)) return;
      const copy = Uint8Array.from(bytes);
      if (!capture.active) {
        capture.pendingBytes += copy.byteLength;
        if (capture.pendingBytes > FROZEN_RUNTIME_LIMIT_PROFILE.terminal.pendingWriteBytes) {
          this.#streamFailures.set(
            streamKey,
            new StoreError("DataIntegrityFailure", "pre-Session output buffer exceeded limit"),
          );
          void process.terminate().catch(() => {});
          return;
        }
        capture.pending.push(copy);
        return;
      }
      this.#appendOutputFrame(prepared.plannedSessionId, capture, copy);
    });
    this.#outputSubscriptions.set(prepared.plannedSessionId, unsubscribe);
  }

  #activateOutputCapture(sessionId: string): void {
    const capture = this.#outputCaptures.get(sessionId);
    if (capture === undefined) return;
    capture.active = true;
    for (const bytes of capture.pending.splice(0)) {
      this.#appendOutputFrame(sessionId, capture, bytes);
    }
    capture.pendingBytes = 0;
  }

  #appendOutputFrame(sessionId: string, capture: OutputCaptureState, bytes: Uint8Array): void {
    const streamKey = `${sessionId}:1`;
    if (this.#streamFailures.has(streamKey)) return;
    try {
      this.#journal.appendFrame({
        sessionId,
        generation: 1,
        seq: capture.nextSeq,
        bytes,
      });
      capture.nextSeq += 1;
    } catch (error) {
      this.#streamFailures.set(streamKey, error);
      void this.#processes
        .get(sessionId)
        ?.terminate()
        .catch(() => {});
    }
  }

  #discardOutputCapture(sessionId: string): void {
    this.#outputSubscriptions.get(sessionId)?.();
    this.#outputSubscriptions.delete(sessionId);
    this.#outputCaptures.delete(sessionId);
  }

  #captureExit(prepared: PreparedLaunch, process: SupervisedPtyProcess): void {
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.#exitPromises.set(prepared.plannedSessionId, exited);
    const unsubscribe = process.onExit((event) => {
      this.#recordExit(prepared, event);
      resolveExit?.();
    });
    this.#exitSubscriptions.set(prepared.plannedSessionId, unsubscribe);
  }

  #recordExit(prepared: PreparedLaunch, event: PtyExitEvent): void {
    if (this.inspectSession(prepared.plannedSessionId) === null) {
      this.#pendingExits.set(prepared.plannedSessionId, event);
      return;
    }
    transact(
      this.#db,
      () => {
        const session = this.inspectSession(prepared.plannedSessionId);
        if (session?.availability !== "Alive") return;
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE sessions
             SET availability = 'Exited', exit_code = ?, updated_at = ?
             WHERE session_id = ? AND availability = 'Alive'`,
          )
          .run(event.exitCode, now, prepared.plannedSessionId);
        this.#db
          .prepare("DELETE FROM control_leases WHERE session_id = ?")
          .run(prepared.plannedSessionId);
        this.#appendEvent(prepared, "session-exited", {
          sessionId: prepared.plannedSessionId,
          exitCode: event.exitCode,
          signal: event.signal,
        });
        const exited = this.#db
          .prepare("SELECT role FROM sessions WHERE session_id = ?")
          .get(prepared.plannedSessionId) as { readonly role: string } | undefined;
        if (exited?.role === "PrimaryAgent") {
          const primaryOutcome =
            event.exitCode === 0 && event.signal === 0 ? "Succeeded" : "Failed";
          this.#db
            .prepare(
              `UPDATE attempts
               SET primary_outcome = ?, primary_exit_code = ?, primary_exit_signal = ?
               WHERE attempt_id = ? AND primary_outcome IS NULL`,
            )
            .run(primaryOutcome, event.exitCode, event.signal, prepared.attemptId);
        }
        this.#settleAttemptIfComplete(prepared);
      },
      this.#now,
    );
    const generation = this.inspectSession(prepared.plannedSessionId)?.generation ?? 1;
    const snapshotTask = this.createSessionSnapshot(prepared.plannedSessionId)
      .then(() => {})
      .catch((error: unknown) => {
        this.#streamFailures.set(`${prepared.plannedSessionId}:${generation}`, error);
      })
      .finally(() => {
        this.#snapshotTasks.delete(prepared.plannedSessionId);
      });
    this.#snapshotTasks.set(prepared.plannedSessionId, snapshotTask);
    this.#forgetProcess(prepared.plannedSessionId);
  }

  #flushPendingExit(prepared: PreparedLaunch): void {
    const event = this.#pendingExits.get(prepared.plannedSessionId);
    if (event === undefined) return;
    this.#pendingExits.delete(prepared.plannedSessionId);
    this.#recordExit(prepared, event);
  }

  #forgetProcess(sessionId: string): void {
    this.#discardOutputCapture(sessionId);
    this.#exitSubscriptions.get(sessionId)?.();
    this.#exitSubscriptions.delete(sessionId);
    this.#exitPromises.delete(sessionId);
    this.#processes.delete(sessionId);
    this.#pendingExits.delete(sessionId);
  }

  #assertControlLease(lease: ControlLease): SupervisedPtyProcess {
    const session = this.inspectSession(lease.sessionId);
    if (session === null) {
      throw new StoreError("NotFound", `Session ${lease.sessionId} does not exist`);
    }
    if (session.generation !== lease.generation) {
      throw new StoreError("StaleGeneration", "Session generation has changed");
    }
    const current = this.#db
      .prepare(
        `SELECT 1 AS present
         FROM control_leases
         JOIN attachments ON attachments.attachment_id = control_leases.attachment_id
         WHERE control_leases.session_id = ?
           AND control_leases.generation = ?
           AND control_leases.attachment_id = ?
           AND control_leases.fencing_token = ?
           AND control_leases.expires_at > ?
           AND attachments.status = 'Active'`,
      )
      .get(lease.sessionId, lease.generation, lease.attachmentId, lease.fencingToken, this.#now());
    if (session.availability !== "Alive" || current === undefined) {
      throw new StoreError("StaleControlLease", "Control Lease is stale or expired");
    }
    const process = this.#processes.get(lease.sessionId);
    if (process === undefined) {
      throw new StoreError("StaleControlLease", "Session has no current PTY owner");
    }
    return process;
  }

  #requireConfirmations(): PersistentChallengeIssuer {
    if (this.#confirmations === undefined) {
      throw new StoreError("ConfirmationRequired", "Side-effect confirmation is unavailable");
    }
    return this.#confirmations;
  }

  #terminateSessionPreview(lease: ControlLease, targetCommandId?: string): ChallengePreview {
    const facts = this.#db
      .prepare(
        `SELECT sessions.generation AS session_generation, sessions.availability,
                attachments.status AS attachment_status,
                control_leases.attachment_id AS lease_attachment_id,
                control_leases.fencing_token AS lease_fencing_token,
                control_leases.expires_at AS lease_expires_at
         FROM sessions
         LEFT JOIN attachments
           ON attachments.attachment_id = ?
          AND attachments.session_id = sessions.session_id
         LEFT JOIN control_leases
           ON control_leases.session_id = sessions.session_id
         WHERE sessions.session_id = ?`,
      )
      .get(lease.attachmentId, lease.sessionId) as
      | {
          readonly session_generation: number;
          readonly availability: SessionRuntimeRecord["availability"];
          readonly attachment_status: Attachment.AttachmentStatus | null;
          readonly lease_attachment_id: string | null;
          readonly lease_fencing_token: number | null;
          readonly lease_expires_at: number | null;
        }
      | undefined;
    if (facts === undefined) {
      throw new StoreError("NotFound", `Session ${lease.sessionId} does not exist`);
    }
    return {
      kind: "side-effect",
      commandType: "TerminateSession",
      sideEffectClass: "destructive",
      targetIdentities: [
        {
          targetType: "Session",
          targetId: lease.sessionId,
          generation: lease.generation,
        },
        {
          targetType: "Attachment",
          targetId: lease.attachmentId,
          generation: lease.generation,
          fencingToken: lease.fencingToken,
        },
      ],
      expectedStateVersions: [],
      display: {
        title: "Terminate Session",
        fields: [
          { label: "Command", value: "TerminateSession" },
          { label: "Side-effect Class", value: "destructive" },
          { label: "Session", value: lease.sessionId },
          { label: "Generation", value: String(lease.generation) },
          { label: "Attachment", value: lease.attachmentId },
          {
            label: "Impact",
            value: "Stops this Session; staged, unstaged, and untracked files are not cleaned up",
          },
        ],
      },
      payload: {
        commandType: "TerminateSession",
        targetCommandId: targetCommandId ?? null,
        sessionId: lease.sessionId,
        generation: lease.generation,
      },
      bindingFacts: [
        {
          sessionId: lease.sessionId,
          generation: facts.session_generation,
          availability: facts.availability,
        },
        {
          attachmentId: lease.attachmentId,
          attachmentStatus: facts.attachment_status,
        },
        {
          attachmentId: facts.lease_attachment_id,
          fencingToken: facts.lease_fencing_token,
          validAtExecution: facts.lease_expires_at !== null && facts.lease_expires_at > this.#now(),
        },
      ],
      impactSummary: {
        sideEffectClass: "destructive",
        stoppedSessionIds: [lease.sessionId],
        gitCleanup: false,
      },
    };
  }

  #takeoverControlPreview(
    attachmentId: string,
    confirmedHolder: ControlLease,
    target: {
      readonly session_id: string;
      readonly generation: number;
      readonly availability: SessionRuntimeRecord["availability"];
    },
    holder: {
      readonly attachment_id: string;
      readonly fencing_token: number;
    },
  ): ChallengePreview {
    return {
      kind: "side-effect",
      commandType: "TakeoverControl",
      sideEffectClass: "destructive",
      targetIdentities: [
        {
          targetType: "Session",
          targetId: target.session_id,
          generation: target.generation,
        },
        {
          targetType: "Attachment",
          targetId: confirmedHolder.attachmentId,
          generation: confirmedHolder.generation,
          fencingToken: confirmedHolder.fencingToken,
        },
        {
          targetType: "Attachment",
          targetId: attachmentId,
          generation: target.generation,
        },
      ],
      expectedStateVersions: [],
      display: {
        title: "Take Over Session Control",
        fields: [
          { label: "Command", value: "TakeoverControl" },
          { label: "Side-effect Class", value: "destructive" },
          { label: "Session", value: target.session_id },
          { label: "Generation", value: String(target.generation) },
          { label: "Current holder", value: holder.attachment_id },
          { label: "New holder", value: attachmentId },
          {
            label: "Impact",
            value: "Immediately revokes the current writer and fences its Control Lease",
          },
        ],
      },
      payload: {
        commandType: "TakeoverControl",
        sessionId: target.session_id,
        generation: target.generation,
        attachmentId,
      },
      bindingFacts: [
        {
          sessionId: target.session_id,
          generation: target.generation,
          availability: target.availability,
        },
        {
          attachmentId: confirmedHolder.attachmentId,
          fencingToken: confirmedHolder.fencingToken,
        },
        { replacementAttachmentId: attachmentId },
      ],
      impactSummary: {
        sideEffectClass: "destructive",
        revokedAttachmentId: holder.attachment_id,
        replacementAttachmentId: attachmentId,
      },
    };
  }

  #consumeSideEffectConfirmation(receipt: ConfirmationReceipt, preview: ChallengePreview): void {
    const consumed = this.#requireConfirmations().consume(
      receipt,
      "side-effect",
      {
        payloadHash: hashPreviewFact(preview.payload),
        bindingHashes: preview.bindingFacts.map(hashPreviewFact),
        impactSummaryHash: hashPreviewFact(preview.impactSummary),
      },
      this.#now(),
    );
    if (!consumed.ok) {
      throw new StoreError(
        "ConfirmationRequired",
        `Side-effect confirmation rejected: ${consumed.reason}`,
      );
    }
  }

  #inputIntent(commandId: string): InputIntent {
    const row = this.#db
      .prepare(
        `SELECT input_intent_id, command_id, session_id, generation, attachment_id,
                fencing_token, source, byte_length, content_ref, created_at, status
         FROM input_intents
         WHERE command_id = ?`,
      )
      .get(commandId) as
      | {
          readonly input_intent_id: string;
          readonly command_id: string;
          readonly session_id: string;
          readonly generation: number;
          readonly attachment_id: string;
          readonly fencing_token: number;
          readonly source: InputIntent["source"];
          readonly byte_length: number;
          readonly content_ref: string;
          readonly created_at: string;
          readonly status: InputIntent["status"];
        }
      | undefined;
    if (row === undefined) {
      throw new StoreError("NotFound", `Input Intent ${commandId} does not exist`);
    }
    return {
      inputIntentId: row.input_intent_id,
      commandId: row.command_id as CommandId,
      sessionId: row.session_id as SessionId,
      generation: row.generation as Generation,
      attachmentId: row.attachment_id as AttachmentId,
      fencingToken: row.fencing_token as InputIntent["fencingToken"],
      source: row.source,
      byteLength: row.byte_length,
      contentRef: row.content_ref,
      createdAt: Date.parse(row.created_at),
      status: row.status,
    };
  }

  #intent(launchNonce: string): LaunchIntentRow {
    const row = this.#db
      .prepare("SELECT * FROM launch_intents WHERE launch_nonce = ?")
      .get(launchNonce) as LaunchIntentRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", "no such LaunchIntent");
    return row;
  }

  #assertPreparedMatches(prepared: PreparedLaunch, row: LaunchIntentRow): void {
    if (
      row.attempt_id !== prepared.attemptId ||
      row.command_id !== prepared.commandId ||
      row.slot_lease_id !== prepared.slotLeaseId ||
      row.planned_session_id !== prepared.plannedSessionId ||
      row.agent_id !== prepared.agentId ||
      row.launch_spec_json !== JSON.stringify(prepared.launchSpec) ||
      row.launch_spec_hash !== canonicalSha256(prepared.launchSpec)
    ) {
      throw new StoreError("IdempotencyConflict", "prepared launch does not match LaunchIntent");
    }
  }

  async #waitForReceipt(path: string, timeoutMs: number): Promise<ProcessReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = readReceipt(path);
      if (receipt !== null) return receipt;
      await sleep(20);
    }
    return null;
  }

  async #waitForAgent(options: {
    readonly receiptPath: string;
    readonly failurePath: string;
    readonly timeoutMs: number;
    readonly prepared: PreparedLaunch;
    readonly execBarrier: ExecBarrier;
  }): Promise<ProcessReceipt | null> {
    const deadline = Date.now() + options.timeoutMs;
    let receipt: ProcessReceipt | null = null;
    while (Date.now() < deadline) {
      receipt = readReceipt(options.receiptPath);
      if (
        receipt !== null &&
        receipt.nonce === options.prepared.launchNonce &&
        receipt.pid === this.#processes.get(options.prepared.plannedSessionId)?.pid
      ) {
        break;
      }
      await sleep(50);
    }
    if (receipt === null) return null;

    const remainingMs = Math.max(0, deadline - Date.now());
    await this.#waitForExecBarrier(options.execBarrier, Math.min(remainingMs, 100));
    const failureDeadline = Math.min(deadline, Date.now() + 100);
    while (Date.now() < failureDeadline) {
      if (existsSync(options.failurePath)) return null;
      const observed = this.#processProbe(receipt.pid);
      if (observed.kind === "observed") {
        if (
          observed.identity.pgid !== receipt.pgid ||
          (receipt.identityCoverage === "full" && observed.identity.lstart !== receipt.lstart)
        ) {
          return null;
        }
        if (
          commandMatchesExecutable(
            observed.identity.command,
            options.prepared.launchSpec.executablePath,
          )
        ) {
          return {
            ...receipt,
            lstart: observed.identity.lstart,
            command: observed.identity.command,
            identityCoverage: "full",
          };
        }
      }
      await sleep(10);
    }
    if (existsSync(options.failurePath)) return null;
    if (this.#pendingExits.has(options.prepared.plannedSessionId)) return null;
    if (!processIsAlive(receipt.pid)) return null;

    // The durable receipt means the trusted bootstrap reached the authorized
    // exec boundary. When close-on-exec EOF or Host process enumeration is not
    // observable, the still-live PTY owner plus the absence of a durable exec
    // failure/exit is enough for the current Daemon to create the Session with
    // partial identity. Restart Reconciliation will remain Probing rather than
    // claim a full match.
    return {
      ...receipt,
      pgid: receipt.pid,
      lstart: "",
      identityCoverage: "pid-pgid",
    };
  }

  #authorize(prepared: PreparedLaunch, receipt: ProcessReceipt): void {
    transact(
      this.#db,
      () => {
        const row = this.#intent(prepared.launchNonce);
        if (!LaunchIntent.canTransition(row.status, "Authorized")) {
          throw new StoreError("Conflict", `LaunchIntent is ${row.status}, cannot authorize`);
        }
        this.#db
          .prepare(
            `UPDATE launch_intents
             SET status = 'Authorized', bootstrap_pid = ?, bootstrap_pgid = ?,
                 bootstrap_started_at = ?, updated_at = ?
             WHERE launch_nonce = ?`,
          )
          .run(
            receipt.pid,
            receipt.pgid,
            receipt.identityCoverage === "full" ? receipt.lstart : null,
            new Date(this.#now()).toISOString(),
            prepared.launchNonce,
          );
        this.#appendEvent(prepared, "launch-intent-authorized", {
          launchNonce: prepared.launchNonce,
        });
      },
      this.#now,
    );
  }

  #recordCommitSent(launchNonce: string): void {
    transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            "UPDATE launch_intents SET commit_sent_at = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(now, now, launchNonce);
      },
      this.#now,
    );
  }

  #finalizeRunning(prepared: PreparedLaunch, agent: ProcessReceipt): LaunchSessionResult {
    const hasFullIdentity = agent.identityCoverage === "full" && agent.command !== undefined;
    const result: LaunchSessionResult = {
      kind: "running",
      attemptId: prepared.attemptId,
      sessionId: prepared.plannedSessionId,
      generation: 1,
    };
    return transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `INSERT INTO sessions
             (session_id, attempt_id, availability, role, completion_policy, generation,
              process_pid, process_pgid, process_started_at, process_command, created_at, updated_at)
             VALUES (?, ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1,
                     ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            prepared.plannedSessionId,
            prepared.attemptId,
            agent.pid,
            agent.pgid,
            hasFullIdentity ? agent.lstart : null,
            hasFullIdentity ? agent.command : null,
            now,
            now,
          );
        this.#transitionAttempt(prepared.attemptId, "Running");
        this.#db
          .prepare(
            "UPDATE launch_intents SET result_json = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(JSON.stringify(result), now, prepared.launchNonce);
        this.#appendEvent(prepared, "session-alive", {
          sessionId: prepared.plannedSessionId,
          generation: 1,
        });
        this.#appendEvent(prepared, "attempt-running", {});
        return result;
      },
      this.#now,
    );
  }

  #abort(prepared: PreparedLaunch, reason: LaunchFailedReason): LaunchSessionResult {
    const result: LaunchSessionResult = {
      kind: "failed",
      attemptId: prepared.attemptId,
      reason,
    };
    return transact(
      this.#db,
      () => {
        const intent = this.#intent(prepared.launchNonce);
        if (!LaunchIntent.canTransition(intent.status, "Aborted")) {
          throw new StoreError("Conflict", `LaunchIntent is ${intent.status}, cannot abort`);
        }
        if (intent.commit_sent_at !== null) {
          throw new StoreError("Conflict", "CommitLaunch may have been delivered");
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE launch_intents
             SET status = 'Aborted', abort_reason = ?, result_json = ?, updated_at = ?
             WHERE launch_nonce = ?`,
          )
          .run(reason, JSON.stringify(result), now, prepared.launchNonce);
        this.#transitionAttempt(prepared.attemptId, "Failed");
        this.#setAttemptTerminalReason(prepared.attemptId, reason);
        this.#db
          .prepare("UPDATE slot_leases SET released_at = ? WHERE slot_lease_id = ?")
          .run(now, prepared.slotLeaseId);
        this.#appendEvent(prepared, "launch-aborted", { reason });
        return result;
      },
      this.#now,
    );
  }

  #markUncertain(
    prepared: PreparedLaunch,
    reason: LaunchUncertainReason,
    disposition: ProcessDisposition.ProcessDisposition = "Probing",
  ): LaunchSessionResult {
    const result: LaunchSessionResult = {
      kind: "uncertain",
      attemptId: prepared.attemptId,
      reason,
    };
    return transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        this.#transitionAttempt(prepared.attemptId, "Uncertain");
        this.#setAttemptTerminalReason(prepared.attemptId, reason);
        this.#db
          .prepare(
            "UPDATE launch_intents SET result_json = ?, updated_at = ? WHERE launch_nonce = ?",
          )
          .run(JSON.stringify(result), now, prepared.launchNonce);
        this.#db
          .prepare(
            `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT (attempt_id) DO UPDATE
             SET disposition = excluded.disposition, updated_at = excluded.updated_at`,
          )
          .run(prepared.attemptId, disposition, now);
        if (!ProcessDisposition.dispositionHoldsSlot(disposition)) {
          this.#releaseSlot(prepared.attemptId, now);
        }
        this.#appendEvent(prepared, "attempt-uncertain", {
          reason,
          processDisposition: disposition,
        });
        return result;
      },
      this.#now,
    );
  }

  #writeSignal(relativeDir: string, name: string, value: unknown): void {
    const finalPath = join(this.#storeDir, relativeDir, name);
    if (existsSync(finalPath)) return;
    durableWriteContentObject({
      storeDir: this.#storeDir,
      relativeDir,
      finalName: name,
      bytes: Buffer.from(JSON.stringify(value)),
    });
  }

  #attempt(attemptId: string): {
    readonly task_id: string;
    readonly status: Attempt.AttemptStatus;
    readonly waiting_reason: string | null;
    readonly resume_status: string | null;
  } {
    const row = this.#db
      .prepare(
        "SELECT task_id, status, waiting_reason, resume_status FROM attempts WHERE attempt_id = ?",
      )
      .get(attemptId) as
      | {
          readonly task_id: string;
          readonly status: Attempt.AttemptStatus;
          readonly waiting_reason: string | null;
          readonly resume_status: string | null;
        }
      | undefined;
    if (row === undefined) throw new StoreError("NotFound", "no such Attempt");
    return row;
  }

  #transitionAttempt(attemptId: string, to: Attempt.AttemptStatus): void {
    const from = this.#attempt(attemptId).status;
    if (!Attempt.canTransition(from, to)) {
      throw new StoreError("Conflict", `Attempt is ${from}, cannot become ${to}`);
    }
    if (to === "Waiting") {
      this.#db
        .prepare(
          "UPDATE attempts SET status = ?, state_version = state_version + 1 WHERE attempt_id = ?",
        )
        .run(to, attemptId);
      return;
    }
    this.#db
      .prepare(
        `UPDATE attempts
         SET status = ?, waiting_reason = NULL, resume_status = NULL,
             state_version = state_version + 1
         WHERE attempt_id = ?`,
      )
      .run(to, attemptId);
  }

  #setAttemptTerminalReason(attemptId: string, reason: string | null): void {
    this.#db
      .prepare("UPDATE attempts SET failure_reason = ? WHERE attempt_id = ?")
      .run(reason, attemptId);
  }

  #settleAttemptIfComplete(prepared: PreparedLaunch): void {
    const attempt = this.#db
      .prepare(
        `SELECT status, primary_outcome
         FROM attempts
         WHERE attempt_id = ?`,
      )
      .get(prepared.attemptId) as
      | {
          readonly status: Attempt.AttemptStatus;
          readonly primary_outcome: PrimaryOutcome | null;
        }
      | undefined;
    if (attempt === undefined || attempt.primary_outcome === null) return;
    if (Attempt.isTerminalAttempt(attempt.status)) return;

    const blocking = this.#db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE attempt_id = ?
           AND completion_policy = 'BlocksAttemptCompletion'
           AND availability = 'Alive'`,
      )
      .get(prepared.attemptId) as { readonly count: number };
    if (blocking.count > 0) return;

    const settlement =
      attempt.status === "Stopping"
        ? STOPPING_SETTLEMENT
        : PRIMARY_OUTCOME_SETTLEMENTS[attempt.primary_outcome];
    this.#transitionAttempt(prepared.attemptId, settlement.status);
    this.#setAttemptTerminalReason(prepared.attemptId, settlement.reason);
    const now = new Date(this.#now()).toISOString();
    this.#releaseSlot(prepared.attemptId, now);
    this.#appendEvent(prepared, settlement.eventType, {
      primaryOutcome: attempt.primary_outcome,
      reason: settlement.reason,
    });
  }

  #ownedProcessesForAttempt(attemptId: string): OwnedProcess[] {
    const rows = this.#db
      .prepare(
        `SELECT planned_session_id AS session_id, bootstrap_pgid AS process_group_id
         FROM launch_intents
         WHERE attempt_id = ? AND bootstrap_pgid IS NOT NULL
         UNION
         SELECT session_id, process_pgid AS process_group_id
         FROM sessions
         WHERE attempt_id = ? AND availability = 'Alive' AND process_pgid IS NOT NULL`,
      )
      .all(attemptId, attemptId) as unknown as {
      readonly session_id: string;
      readonly process_group_id: number;
    }[];
    const found = new Map<SupervisedPtyProcess, number>();
    for (const row of rows) {
      const process = this.#processes.get(row.session_id);
      if (process !== undefined && row.process_group_id > 1) {
        found.set(process, row.process_group_id);
      }
    }
    return [...found].map(([process, processGroupId]) => ({ process, processGroupId }));
  }

  #primarySessionIdForAttempt(attemptId: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT session_id
         FROM sessions
         WHERE attempt_id = ? AND role = 'PrimaryAgent'
         ORDER BY created_at DESC, session_id DESC
         LIMIT 1`,
      )
      .get(attemptId) as { readonly session_id: string } | undefined;
    if (row !== undefined) return row.session_id;
    const planned = this.#db
      .prepare("SELECT planned_session_id FROM launch_intents WHERE attempt_id = ?")
      .get(attemptId) as { readonly planned_session_id: string } | undefined;
    return planned?.planned_session_id ?? null;
  }

  #releaseSlot(attemptId: string, releasedAt: string): void {
    this.#db
      .prepare(
        "UPDATE slot_leases SET released_at = ? WHERE attempt_id = ? AND released_at IS NULL",
      )
      .run(releasedAt, attemptId);
  }

  #reconcileSlotLeases(): void {
    transact(
      this.#db,
      () => {
        const now = new Date(this.#now()).toISOString();
        const rows = this.#db
          .prepare(
            `SELECT slot_leases.attempt_id, slot_leases.released_at, attempts.status,
                    process_dispositions.disposition
             FROM slot_leases
             JOIN attempts ON attempts.attempt_id = slot_leases.attempt_id
             LEFT JOIN process_dispositions
               ON process_dispositions.attempt_id = slot_leases.attempt_id
             ORDER BY slot_leases.acquired_at, slot_leases.slot_lease_id`,
          )
          .all() as unknown as {
          readonly attempt_id: string;
          readonly released_at: string | null;
          readonly status: Attempt.AttemptStatus;
          readonly disposition: ProcessDisposition.ProcessDisposition | null;
        }[];
        for (const row of rows) {
          const activeAttempt =
            row.status === "Starting" ||
            row.status === "Running" ||
            row.status === "Waiting" ||
            row.status === "Stopping";
          let disposition = row.disposition;
          if (row.status === "Uncertain" && disposition === null) {
            disposition = "Probing";
            this.#db
              .prepare(
                `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
                 VALUES (?, 'Probing', ?)`,
              )
              .run(row.attempt_id, now);
          }
          const shouldHold =
            activeAttempt ||
            (row.status === "Uncertain" &&
              disposition !== null &&
              ProcessDisposition.dispositionHoldsSlot(disposition));
          if (shouldHold && row.released_at !== null) {
            this.#db
              .prepare("UPDATE slot_leases SET released_at = NULL WHERE attempt_id = ?")
              .run(row.attempt_id);
          } else if (!shouldHold && row.released_at === null) {
            this.#releaseSlot(row.attempt_id, now);
          }
        }
      },
      this.#now,
    );
  }

  #recordStorageDataGaps(dataGaps: readonly StoreDataGap[]): ReadonlySet<string> {
    const attemptIds = new Set<string>();
    for (const gap of dataGaps) {
      const owner = this.#db
        .prepare(
          `SELECT sessions.attempt_id, attempts.task_id
           FROM sessions
           JOIN attempts ON attempts.attempt_id = sessions.attempt_id
           WHERE sessions.session_id = ? AND sessions.generation = ?`,
        )
        .get(gap.sessionId, gap.generation) as
        | { readonly attempt_id: string; readonly task_id: string }
        | undefined;
      if (owner === undefined) continue;
      attemptIds.add(owner.attempt_id);
      const payload = {
        kind: "chunk",
        sessionId: gap.sessionId,
        generation: gap.generation,
        seq: gap.seq,
        reason: gap.reason,
        missingByteCount: gap.byteLength,
      };
      const serialized = JSON.stringify(payload);
      const exists = this.#db
        .prepare(
          `SELECT 1 AS present
           FROM domain_events
           WHERE task_id = ? AND attempt_id = ? AND session_id = ?
             AND type = 'data-gap-detected' AND payload_json = ?
           LIMIT 1`,
        )
        .get(owner.task_id, owner.attempt_id, gap.sessionId, serialized);
      if (exists !== undefined) continue;
      transact(
        this.#db,
        () => {
          this.#appendLifecycleEvent({
            taskId: owner.task_id,
            attemptId: owner.attempt_id,
            sessionId: gap.sessionId,
            type: "data-gap-detected",
            payload,
          });
        },
        this.#now,
      );
    }
    return attemptIds;
  }

  #appendEvent(prepared: PreparedLaunch, type: string, payload: unknown): void {
    this.#appendLifecycleEvent({
      taskId: prepared.taskId,
      attemptId: prepared.attemptId,
      sessionId: prepared.plannedSessionId,
      type,
      payload,
    });
  }

  #appendLifecycleEvent(input: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly sessionId: string | null;
    readonly type: string;
    readonly payload: unknown;
  }): void {
    appendDomainEvent(this.#db, input, this.#now);
  }
}

const processExecPath = (): string => process.execPath;

const preparedLaunchFromRow = (
  row: LaunchIntentRow & { readonly task_id: string },
): PreparedLaunch => {
  let launchSpec: PreparedLaunch["launchSpec"];
  try {
    launchSpec = JSON.parse(row.launch_spec_json) as PreparedLaunch["launchSpec"];
  } catch {
    throw new StoreError("DataIntegrityFailure", "stored LaunchSpec is not valid JSON");
  }
  if (canonicalSha256(launchSpec) !== row.launch_spec_hash) {
    throw new StoreError("DataIntegrityFailure", "stored LaunchSpec hash does not match");
  }
  if (canonicalSha256(launchSpec.argv) !== row.argv_hash) {
    throw new StoreError("DataIntegrityFailure", "stored argv hash does not match");
  }
  return {
    kind: "prepared",
    attemptId: row.attempt_id,
    taskId: row.task_id,
    commandId: row.command_id,
    agentId: row.agent_id,
    slotLeaseId: row.slot_lease_id,
    launchNonce: row.launch_nonce,
    plannedSessionId: row.planned_session_id,
    launchSpec,
  };
};

const isResumableAttemptStatus = (status: string | null): status is ResumableAttemptStatus =>
  status === "Starting" || status === "Running" || status === "Stopping";

const resolvesWithin = async (promise: Promise<void>, timeoutMs: number): Promise<boolean> =>
  await new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(() => finish(true));
  });

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

const createExecBarrier = async (): Promise<ExecBarrier> => {
  const host = "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  let resolveAuthentication: (() => void) | undefined;
  let resolveClose: (() => void) | undefined;
  const authenticated = new Promise<void>((resolve) => {
    resolveAuthentication = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let authenticatedSocket: Socket | undefined;
  const server = createServer((socket) => {
    if (authenticatedSocket !== undefined) {
      socket.destroy();
      return;
    }
    socket.setEncoding("utf8");
    let received = "";
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!token.startsWith(received)) {
        socket.destroy();
        return;
      }
      if (received !== token) return;
      authenticatedSocket = socket;
      socket.removeAllListeners("data");
      socket.once("close", () => resolveClose?.());
      resolveAuthentication?.();
      server.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", () => {});
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("exec barrier did not bind a TCP port");
  }
  return {
    config: { host, port: address.port, token },
    async waitForAuthentication(timeoutMs) {
      return await resolvesWithin(authenticated, timeoutMs);
    },
    async waitForClose(timeoutMs) {
      return await resolvesWithin(closed, timeoutMs);
    },
    async close() {
      authenticatedSocket?.destroy();
      await closeServer(server);
    },
  };
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
};

const probeProcess = (pid: number): ProcessProbe => {
  const result = spawnSync("/bin/ps", ["-o", "pid=,pgid=,lstart=,command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
    // Pin LC_ALL so ps lstart output is locale-stable and comparable with bootstrap receipts.
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined || result.status === null) return { kind: "unavailable" };
  if (result.status !== 0)
    return result.status === 1 ? { kind: "absent" } : { kind: "unavailable" };

  const tokens = result.stdout.trim().split(/\s+/);
  const observedPid = Number(tokens[0]);
  const pgid = Number(tokens[1]);
  const lstart = tokens.slice(2, 7).join(" ");
  const command = tokens.slice(7).join(" ");
  if (
    observedPid !== pid ||
    !Number.isInteger(pgid) ||
    lstart.length === 0 ||
    command.length === 0
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "observed", identity: { pgid, lstart, command } };
};

const commandMatchesExecutable = (command: string, executablePath: string): boolean => {
  if (command.includes(executablePath)) return true;
  const observedExecutable = command.split(/\s+/, 1)[0];
  return (
    observedExecutable !== undefined && basename(observedExecutable) === basename(executablePath)
  );
};
