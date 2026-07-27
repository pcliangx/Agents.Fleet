// RT-MOD-03 / RT-LAUNCH-02..08 — Session Runtime public seam.
//
// ProcessSupervisor and the file handshake remain private implementation
// details. Callers pass a scheduler-produced PreparedLaunch and receive only
// domain results. The durable LaunchIntent result makes a replay return the
// original Session without spawning a second bootstrap or Agent.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  Attempt,
  type DurableFrameRef,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type LaunchFailedReason,
  LaunchIntent,
  type LaunchSessionResult,
  type LaunchUncertainReason,
  type LaunchValidation,
  type PreparedLaunch,
  ProcessDisposition,
  type RestartReconciliationReport,
  type ResumableAttemptStatus,
  type SessionRuntime as SessionRuntimeContract,
  type SessionRuntimeRecord,
  type StoragePressureWait,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { transact } from "../storage/database.js";
import { appendDomainEvent } from "../storage/domain-event-store.js";
import { StoreError } from "../storage/task-store.js";
import { ByteJournal } from "./byte-journal.js";
import { durableWriteContentObject } from "./content-object-io.js";
import type {
  ProcessSupervisor,
  PtyExitEvent,
  SupervisedPtyProcess,
} from "./process-supervisor.js";
import { reconcileStore } from "./store-reconciliation.js";

const DEFAULT_BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), "bootstrap.mjs");

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
  /** RT-T-11 crash injection at protocol boundaries. */
  readonly onLaunchStep?: (step: LaunchStep) => void;
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
  readonly #onLaunchStep: ((step: LaunchStep) => void) | undefined;
  readonly #journal: ByteJournal;
  readonly #launches = new Map<string, Promise<LaunchSessionResult>>();
  readonly #processes = new Map<string, SupervisedPtyProcess>();
  readonly #outputSubscriptions = new Map<string, () => void>();
  readonly #outputCaptures = new Map<string, OutputCaptureState>();
  readonly #exitSubscriptions = new Map<string, () => void>();
  readonly #exitPromises = new Map<string, Promise<void>>();
  readonly #pendingExits = new Map<string, PtyExitEvent>();
  readonly #streamFailures = new Map<string, unknown>();

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
    this.#onLaunchStep = options.onLaunchStep;
    this.#journal = new ByteJournal({ storeDir: options.storeDir, db: options.db });
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
    const alive = this.#db
      .prepare(
        `SELECT sessions.session_id, sessions.attempt_id, sessions.process_pid,
                sessions.process_pgid, sessions.process_started_at, sessions.process_command,
                attempts.task_id, attempts.status
         FROM sessions
         JOIN attempts ON attempts.attempt_id = sessions.attempt_id
         WHERE sessions.availability = 'Alive'
         ORDER BY sessions.created_at, sessions.session_id`,
      )
      .all() as unknown as {
      readonly session_id: string;
      readonly attempt_id: string;
      readonly task_id: string;
      readonly status: Attempt.AttemptStatus;
      readonly process_pid: number | null;
      readonly process_pgid: number | null;
      readonly process_started_at: string | null;
      readonly process_command: string | null;
    }[];
    const actions: RestartReconciliationReport["actions"][number][] = [];

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
      const identityMatches =
        probe.kind === "observed" &&
        row.process_pgid !== null &&
        row.process_started_at !== null &&
        row.process_command !== null &&
        probe.identity.pgid === row.process_pgid &&
        probe.identity.lstart === row.process_started_at &&
        probe.identity.command === row.process_command;
      const recordedIdentityIsFull =
        row.process_pgid !== null &&
        row.process_started_at !== null &&
        row.process_command !== null;
      const resolution:
        | {
            readonly status: "Uncertain";
            readonly disposition: "OrphanFound" | "Probing";
            readonly reason: string;
          }
        | {
            readonly status: "Interrupted";
            readonly disposition: "ConfirmedAbsent";
            readonly reason: string;
          } = identityMatches
        ? {
            status: "Uncertain",
            disposition: "OrphanFound",
            reason: "orphan-process-identity-matched",
          }
        : probe.kind === "unavailable"
          ? {
              status: "Uncertain",
              disposition: "Probing",
              reason: "process-identity-unavailable",
            }
          : probe.kind === "observed" && !recordedIdentityIsFull
            ? {
                status: "Uncertain",
                disposition: "Probing",
                reason: "recorded-process-identity-incomplete",
              }
            : {
                status: "Interrupted",
                disposition: "ConfirmedAbsent",
                reason:
                  probe.kind === "absent"
                    ? "process-confirmed-absent"
                    : "process-identity-mismatch",
              };

      transact(
        this.#db,
        () => {
          const now = new Date(this.#now()).toISOString();
          this.#db
            .prepare(
              "UPDATE sessions SET availability = 'Lost', updated_at = ? WHERE session_id = ? AND availability = 'Alive'",
            )
            .run(now, row.session_id);
          this.#transitionAttempt(row.attempt_id, resolution.status);
          this.#db
            .prepare(
              `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT (attempt_id) DO UPDATE
               SET disposition = excluded.disposition, updated_at = excluded.updated_at`,
            )
            .run(row.attempt_id, resolution.disposition, now);
          if (!ProcessDisposition.dispositionHoldsSlot(resolution.disposition)) {
            this.#releaseSlot(row.attempt_id, now);
          }
          this.#appendLifecycleEvent({
            taskId: row.task_id,
            attemptId: row.attempt_id,
            sessionId: row.session_id,
            type: "session-lost",
            payload: {
              reason: resolution.reason,
              processDisposition: resolution.disposition,
            },
          });
        },
        this.#now,
      );
      actions.push({
        action: "marked-lost",
        attemptId: row.attempt_id,
        sessionId: row.session_id,
      });
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
      },
    };
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
        this.#appendEvent(prepared, "session-exited", {
          sessionId: prepared.plannedSessionId,
          exitCode: event.exitCode,
          signal: event.signal,
        });
      },
      this.#now,
    );
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
      this.#db.prepare("UPDATE attempts SET status = ? WHERE attempt_id = ?").run(to, attemptId);
      return;
    }
    this.#db
      .prepare(
        `UPDATE attempts
         SET status = ?, waiting_reason = NULL, resume_status = NULL
         WHERE attempt_id = ?`,
      )
      .run(to, attemptId);
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
