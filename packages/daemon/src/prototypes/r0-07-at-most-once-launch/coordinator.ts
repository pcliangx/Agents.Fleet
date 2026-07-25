// R0-07 — launch coordinator: the Daemon-side half of the at-most-once
// launch protocol (RT-LAUNCH-01..08, RT-CMD-02/16, RT-T-11). PROTOTYPE —
// evidence code, not the R1 Session Runtime.
//
// Every numbered step that mutates authoritative state is ONE SQLite
// transaction; OS spawn and CommitLaunch delivery sit strictly BETWEEN
// transactions. `crashPoint` lets the crash harness SIGKILL the coordinator
// at each protocol boundary (RT-T-11) — the points are checked in order and
// each maps to "between step N and step N+1" of runtime-contracts-v1 §8.1.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Attempt, LaunchIntent } from "@agents-fleet/contracts";
import { abortPath, agentIdentityPath, commitPath, receiptPath, scenarioPaths } from "./paths.js";
import { probeProcess, type RecordedProcessIdentity } from "./ps-helpers.js";
import { withTx } from "./schema.js";
import {
  asAttemptStatus,
  asLaunchIntentStatus,
  atomicPublish,
  readJsonFile,
  readSnapshot,
  sleep,
} from "./shared.js";

export type { RecordedProcessIdentity };

export type CommandKind = "start" | "retry" | "resume";

export interface LaunchCommand {
  readonly commandId: string;
  readonly kind: CommandKind;
  readonly taskId: string;
  /** Structured argv (no shell) — hashed into the intent (RT-LAUNCH-01). */
  readonly argv: readonly string[];
}

/** Crash-injection points: one per boundary between two §8.1 steps. */
export const CRASH_POINTS = [
  "afterCommandTx", // RT-LAUNCH-01 cmd tx committed, before launch tx
  "afterLaunchTx", // intent Prepared, before bootstrap spawn (RT-LAUNCH-02)
  "afterBootstrapSpawn", // bootstrap spawned, before authorize tx (RT-LAUNCH-03)
  "afterAuthorizeTx", // intent Authorized, before RT-CMD-16 revalidation
  "afterRevalidationPass", // RT-LAUNCH-08 boundary: revalidated, before CommitLaunch
  "afterRevalidationFail", // RT-LAUNCH-08 boundary: abort tx committed, before AbortLaunch
  "afterCommitSent", // CommitLaunch renamed into place, before commit_sent_at tx
  "afterAgentObserved", // agent identity verified, before finalize tx (RT-LAUNCH-04)
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export type LaunchResult =
  | { readonly status: "Running"; readonly attemptId: string; readonly sessionId: string }
  | { readonly status: "Failed"; readonly attemptId: string; readonly reason: string }
  | { readonly status: "Uncertain"; readonly attemptId: string }
  | { readonly status: "Pending"; readonly attemptId: string }
  | { readonly status: "IdempotencyConflict"; readonly commandId: string };

export interface LaunchRuntimeOptions {
  readonly db: DatabaseSync;
  readonly workDir: string;
  readonly bootstrapPath: string;
  readonly agentPath: string;
  readonly bootstrapTimeoutMs?: number;
  readonly bootstrapGraceMs?: number;
  readonly receiptTimeoutMs?: number;
  readonly observeAgentTimeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => string;
  /** Crash injection (RT-T-11): called synchronously at the armed boundary. */
  readonly crashPoint?: CrashPoint | null;
  readonly onCrashPoint?: (point: CrashPoint) => void;
  /** Test hook invoked just before the RT-CMD-16 revalidation (drift injection). */
  readonly beforeRevalidation?: () => void;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const payloadHashOf = (cmd: LaunchCommand): string =>
  sha256(JSON.stringify({ kind: cmd.kind, taskId: cmd.taskId, argv: cmd.argv }));

export const argvHashOf = (argv: readonly string[]): string => sha256(JSON.stringify(argv));

/** Shared runtime: both the fresh-launch path and Reconciliation drive these steps. */
export class LaunchRuntime {
  readonly db: DatabaseSync;
  readonly workDir: string;
  readonly bootstrapPath: string;
  readonly agentPath: string;
  private readonly o: LaunchRuntimeOptions;

  constructor(o: LaunchRuntimeOptions) {
    this.o = o;
    this.db = o.db;
    this.workDir = o.workDir;
    this.bootstrapPath = o.bootstrapPath;
    this.agentPath = o.agentPath;
  }

  readonly now = (): string => (this.o.now ? this.o.now() : new Date().toISOString());

  readonly maybeCrash = (point: CrashPoint): void => {
    if (this.o.crashPoint === point) this.o.onCrashPoint?.(point);
  };

  readonly runBeforeRevalidationHook = (): void => {
    this.o.beforeRevalidation?.();
  };

  private readonly event = (type: string, payload: unknown): void => {
    this.db
      .prepare("INSERT INTO domain_events (type, payload_json) VALUES (?, ?)")
      .run(type, JSON.stringify(payload));
  };

  readonly factHash = (): string =>
    sha256(readFileSync(scenarioPaths(this.workDir).factsPath, "utf8"));

  // --- RT-LAUNCH-01 step 1: command transaction ---
  readonly commandTx = (cmd: LaunchCommand): { attemptId: string; nonce: string } => {
    const attemptId = `att-${cmd.commandId}`;
    const nonce = `ln-${attemptId}`;
    const snapshot = {
      kind: cmd.kind,
      taskId: cmd.taskId,
      argv: cmd.argv,
      argvHash: argvHashOf(cmd.argv),
      factHash: this.factHash(),
      snapshotId: randomUUID(),
    };
    withTx(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO idempotency (command_id, payload_hash, status) VALUES (?, ?, 'pending')",
        )
        .run(cmd.commandId, payloadHashOf(cmd));
      this.db
        .prepare(
          "INSERT INTO attempts (attempt_id, command_id, task_id, kind, status, snapshot_json, created_at) VALUES (?, ?, ?, ?, 'Queued', ?, ?)",
        )
        .run(attemptId, cmd.commandId, cmd.taskId, cmd.kind, JSON.stringify(snapshot), this.now());
      if (cmd.kind === "start") {
        // start flips Draft Task → Runnable in the SAME transaction.
        this.db
          .prepare("UPDATE tasks SET status = 'Runnable' WHERE task_id = ? AND status = 'Draft'")
          .run(cmd.taskId);
      }
      this.event("attempt.queued", { attemptId, commandId: cmd.commandId, kind: cmd.kind });
    });
    return { attemptId, nonce };
  };

  // --- RT-LAUNCH-01 step 2: launch transaction (Queued → Starting, Prepared intent) ---
  readonly launchTx = (attemptId: string, commandId: string, argvHash: string): string => {
    const nonce = `ln-${attemptId}`;
    const sessionId = `ses-${attemptId}`;
    withTx(this.db, () => {
      const attempt = this.db
        .prepare("SELECT status FROM attempts WHERE attempt_id = ?")
        .get(attemptId) as { status: string } | undefined;
      if (!attempt || !Attempt.canTransition(asAttemptStatus(attempt.status), "Starting")) {
        throw new Error(`launchTx: attempt ${attemptId} not Queued`);
      }
      this.db
        .prepare("UPDATE attempts SET status = 'Starting' WHERE attempt_id = ?")
        .run(attemptId);
      this.db
        .prepare("INSERT INTO slot_leases (slot_id, attempt_id, released) VALUES (?, ?, 0)")
        .run(`slot-${attemptId}`, attemptId);
      this.db
        .prepare(
          "INSERT INTO sessions (session_id, attempt_id, availability) VALUES (?, ?, 'Planned')",
        )
        .run(sessionId, attemptId);
      this.db
        .prepare(
          "INSERT INTO launch_intents (launch_nonce, attempt_id, command_id, argv_hash, status, created_at) VALUES (?, ?, ?, ?, 'Prepared', ?)",
        )
        .run(nonce, attemptId, commandId, argvHash, this.now());
      this.event("launch-intent.prepared", { attemptId, nonce, sessionId });
    });
    return nonce;
  };

  // --- RT-LAUNCH-02: spawn inert bootstrap, await durable receipt (NOT in a tx) ---
  readonly spawnBootstrapAndAwaitReceipt = async (
    nonce: string,
    argvHash: string,
  ): Promise<RecordedProcessIdentity> => {
    const child = spawn(
      process.execPath,
      [
        this.bootstrapPath,
        "--nonce",
        nonce,
        "--dir",
        this.workDir,
        "--timeout-ms",
        String(this.o.bootstrapTimeoutMs ?? 10_000),
        "--grace-ms",
        String(this.o.bootstrapGraceMs ?? 400),
        "--agent-path",
        this.agentPath,
        "--argv-hash",
        argvHash,
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    const deadline = Date.now() + (this.o.receiptTimeoutMs ?? 3000);
    const path = receiptPath(this.workDir, nonce);
    while (Date.now() < deadline) {
      const receipt = readJsonFile<RecordedProcessIdentity>(path);
      if (receipt && receipt.nonce === nonce) return receipt;
      await sleep(this.o.pollMs ?? 25);
    }
    throw new Error(`bootstrap receipt for ${nonce} not observed in time`);
  };

  // --- RT-LAUNCH-03: authorize transaction (bootstrap identity + Authorized) ---
  readonly authorizeTx = (nonce: string, receipt: RecordedProcessIdentity): void => {
    withTx(this.db, () => {
      const intent = this.db
        .prepare("SELECT status FROM launch_intents WHERE launch_nonce = ?")
        .get(nonce) as { status: string } | undefined;
      if (!intent) throw new Error(`authorizeTx: no intent for ${nonce}`);
      // RT-LAUNCH-05/08 — an Aborted nonce can NEVER be (re-)authorized.
      if (!LaunchIntent.canTransition(asLaunchIntentStatus(intent.status), "Authorized")) {
        throw new Error(`authorizeTx: intent ${nonce} is ${intent.status}, cannot authorize`);
      }
      this.db
        .prepare(
          "UPDATE launch_intents SET status = 'Authorized', bootstrap_pid = ?, bootstrap_pgid = ?, bootstrap_lstart = ? WHERE launch_nonce = ?",
        )
        .run(receipt.pid, receipt.pgid, receipt.lstart, nonce);
      this.event("launch-intent.authorized", { nonce, bootstrapPid: receipt.pid });
    });
  };

  // --- RT-LAUNCH-08: abort transaction (Prepared/Authorized → Aborted, terminal) ---
  readonly abortTx = (nonce: string, reason: string): void => {
    withTx(this.db, () => {
      const intent = this.db
        .prepare(
          "SELECT attempt_id, status, commit_sent_at FROM launch_intents WHERE launch_nonce = ?",
        )
        .get(nonce) as
        | { attempt_id: string; status: string; commit_sent_at: string | null }
        | undefined;
      if (!intent) throw new Error(`abortTx: no intent for ${nonce}`);
      if (!LaunchIntent.canTransition(asLaunchIntentStatus(intent.status), "Aborted")) {
        throw new Error(`abortTx: intent ${nonce} is ${intent.status}, cannot abort`);
      }
      // RT-LAUNCH-08 tail — once CommitLaunch may have been sent, Aborted is
      // FORBIDDEN; the attempt must go Uncertain instead.
      if (intent.commit_sent_at !== null || existsSync(commitPath(this.workDir, nonce))) {
        throw new Error(`abortTx: CommitLaunch for ${nonce} may be delivered — must go Uncertain`);
      }
      this.db
        .prepare(
          "UPDATE launch_intents SET status = 'Aborted', abort_reason = ? WHERE launch_nonce = ?",
        )
        .run(reason, nonce);
      const attempt = this.db
        .prepare("SELECT status FROM attempts WHERE attempt_id = ?")
        .get(intent.attempt_id) as { status: string };
      if (!Attempt.canTransition(asAttemptStatus(attempt.status), "Failed")) {
        throw new Error(`abortTx: attempt ${intent.attempt_id} is ${attempt.status}`);
      }
      this.db
        .prepare("UPDATE attempts SET status = 'Failed', failure_reason = ? WHERE attempt_id = ?")
        .run(reason, intent.attempt_id);
      this.db
        .prepare("UPDATE slot_leases SET released = 1 WHERE attempt_id = ?")
        .run(intent.attempt_id);
      this.db.prepare("DELETE FROM sessions WHERE attempt_id = ?").run(intent.attempt_id);
      const cmd = this.db
        .prepare("SELECT command_id FROM attempts WHERE attempt_id = ?")
        .get(intent.attempt_id) as { command_id: string };
      this.db
        .prepare("UPDATE idempotency SET status = 'failed', result_json = ? WHERE command_id = ?")
        .run(
          JSON.stringify({ status: "Failed", attemptId: intent.attempt_id, reason }),
          cmd.command_id,
        );
      this.event("launch.aborted", { nonce, attemptId: intent.attempt_id, reason });
    });
  };

  // --- RT-LAUNCH-08: AbortLaunch signal (or, after a crash, bootstrap self-timeout) ---
  readonly sendAbort = (nonce: string): void => {
    const path = abortPath(this.workDir, nonce);
    if (!existsSync(path)) {
      atomicPublish(path, JSON.stringify({ nonce, sentAt: this.now() }));
    }
  };

  // --- RT-LAUNCH-03: one-shot CommitLaunch bound to the nonce (rename = the send) ---
  readonly sendCommit = (nonce: string, argvHash: string): void => {
    atomicPublish(
      commitPath(this.workDir, nonce),
      JSON.stringify({ nonce, argvHash, sentAt: this.now() }),
    );
  };

  readonly recordCommitSentTx = (nonce: string): void => {
    withTx(this.db, () => {
      this.db
        .prepare("UPDATE launch_intents SET commit_sent_at = ? WHERE launch_nonce = ?")
        .run(this.now(), nonce);
      this.event("launch.commit-sent", { nonce });
    });
  };

  // --- RT-LAUNCH-04: observe the Agent (identity file + FULL process identity) ---
  readonly observeAgent = async (
    nonce: string,
    argvHash: string,
  ): Promise<RecordedProcessIdentity | null> => {
    const deadline = Date.now() + (this.o.observeAgentTimeoutMs ?? 3000);
    const path = agentIdentityPath(this.workDir, nonce);
    while (Date.now() < deadline) {
      const identity = readJsonFile<RecordedProcessIdentity>(path);
      if (identity && identity.nonce === nonce && identity.argvHash === argvHash) {
        // RT-REC-12 — full identity {pid, lstart, pgid, command}, not PID alone.
        const probe = probeProcess(identity.pid, {
          pgid: identity.pgid,
          lstart: identity.lstart,
          commandIncludes: [this.agentPath, this.workDir],
        });
        if (probe.found) return identity;
      }
      await sleep(this.o.pollMs ?? 25);
    }
    return null;
  };

  // --- RT-LAUNCH-04: finalize transaction (Alive Session + Running Attempt) ---
  readonly finalizeTx = (attemptId: string, agent: RecordedProcessIdentity): void => {
    withTx(this.db, () => {
      const attempt = this.db
        .prepare("SELECT status, command_id FROM attempts WHERE attempt_id = ?")
        .get(attemptId) as { status: string; command_id: string };
      if (!Attempt.canTransition(asAttemptStatus(attempt.status), "Running")) {
        throw new Error(`finalizeTx: attempt ${attemptId} is ${attempt.status}`);
      }
      this.db.prepare("UPDATE attempts SET status = 'Running' WHERE attempt_id = ?").run(attemptId);
      this.db
        .prepare(
          "UPDATE sessions SET availability = 'Alive', agent_pid = ?, agent_pgid = ?, agent_lstart = ? WHERE attempt_id = ?",
        )
        .run(agent.pid, agent.pgid, agent.lstart, attemptId);
      this.db
        .prepare(
          "UPDATE idempotency SET status = 'completed', result_json = ? WHERE command_id = ?",
        )
        .run(
          JSON.stringify({
            status: "Running",
            attemptId,
            sessionId: `ses-${attemptId}`,
            agentPid: agent.pid,
          }),
          attempt.command_id,
        );
      this.event("session.alive", { attemptId, agentPid: agent.pid });
      this.event("attempt.running", { attemptId });
    });
  };

  // --- RT-LAUNCH-06: result unknown after Authorized → Uncertain (terminal truth) ---
  readonly uncertainTx = (attemptId: string, reason: string): void => {
    withTx(this.db, () => {
      const attempt = this.db
        .prepare("SELECT status, command_id FROM attempts WHERE attempt_id = ?")
        .get(attemptId) as { status: string; command_id: string };
      if (!Attempt.canTransition(asAttemptStatus(attempt.status), "Uncertain")) {
        throw new Error(`uncertainTx: attempt ${attemptId} is ${attempt.status}`);
      }
      this.db
        .prepare(
          "UPDATE attempts SET status = 'Uncertain', failure_reason = ? WHERE attempt_id = ?",
        )
        .run(reason, attemptId);
      this.db
        .prepare("UPDATE sessions SET availability = 'Lost' WHERE attempt_id = ?")
        .run(attemptId);
      // Slot lease is KEPT: Uncertain still occupies the slot until Process
      // Disposition resolves the leftover process facts (CONTEXT.md).
      this.db
        .prepare(
          "UPDATE idempotency SET status = 'completed', result_json = ? WHERE command_id = ?",
        )
        .run(JSON.stringify({ status: "Uncertain", attemptId, reason }), attempt.command_id);
      this.event("attempt.uncertain", { attemptId, reason });
    });
  };
}

/** Fresh-command path: RT-LAUNCH-01..08 in order, crash-injectable per RT-T-11. */
export class LaunchCoordinator {
  private readonly rt: LaunchRuntime;

  constructor(o: LaunchRuntimeOptions) {
    this.rt = new LaunchRuntime(o);
  }

  /** RT-CMD-02 — same commandId + same payload returns the original result. */
  readonly reissue = (cmd: LaunchCommand): LaunchResult | null => {
    const row = this.rt.db
      .prepare("SELECT payload_hash, status, result_json FROM idempotency WHERE command_id = ?")
      .get(cmd.commandId) as
      | { payload_hash: string; status: string; result_json: string | null }
      | undefined;
    if (!row) return null;
    if (row.payload_hash !== payloadHashOf(cmd)) {
      return { status: "IdempotencyConflict", commandId: cmd.commandId };
    }
    if (row.status === "pending") return { status: "Pending", attemptId: `att-${cmd.commandId}` };
    return JSON.parse(row.result_json as string) as LaunchResult;
  };

  readonly launch = async (cmd: LaunchCommand): Promise<LaunchResult> => {
    const rt = this.rt;
    const prior = this.reissue(cmd);
    if (prior) return prior;

    // Step 1 (RT-LAUNCH-01): command transaction.
    const { attemptId } = rt.commandTx(cmd);
    rt.maybeCrash("afterCommandTx");

    // Step 2 (RT-LAUNCH-01): launch transaction → Starting + Prepared intent.
    const argvHash = argvHashOf(cmd.argv);
    const nonce = rt.launchTx(attemptId, cmd.commandId, argvHash);
    rt.maybeCrash("afterLaunchTx");

    // Step 3 (RT-LAUNCH-02): spawn inert bootstrap, await durable receipt.
    const bootstrap = rt.spawnBootstrapAndAwaitReceipt(nonce, argvHash);
    rt.maybeCrash("afterBootstrapSpawn");
    let receipt: RecordedProcessIdentity;
    try {
      receipt = await bootstrap;
    } catch {
      // Bootstrap died before its durable receipt: no side effects possible,
      // CommitLaunch was never sent → clean abort (RT-LAUNCH-08).
      rt.abortTx(nonce, "bootstrap-receipt-lost");
      return { status: "Failed", attemptId, reason: "bootstrap-receipt-lost" };
    }

    // Step 4 (RT-LAUNCH-03): authorize transaction, THEN CommitLaunch.
    rt.authorizeTx(nonce, receipt);
    rt.maybeCrash("afterAuthorizeTx");

    // Step 5 (RT-LAUNCH-08 / RT-CMD-16): last fact revalidation.
    rt.runBeforeRevalidationHook();
    const drifted = rt.factHash() !== readSnapshot(rt.db, attemptId).factHash;
    if (drifted) {
      rt.abortTx(nonce, "fact-drift");
      rt.maybeCrash("afterRevalidationFail");
      rt.sendAbort(nonce);
      return { status: "Failed", attemptId, reason: "fact-drift" };
    }
    rt.maybeCrash("afterRevalidationPass");

    // Step 6: one-shot CommitLaunch; the rename IS the send.
    rt.sendCommit(nonce, argvHash);
    rt.maybeCrash("afterCommitSent");
    rt.recordCommitSentTx(nonce);

    // Step 7 (RT-LAUNCH-04): observe Agent, then finalize.
    const agent = await rt.observeAgent(nonce, argvHash);
    rt.maybeCrash("afterAgentObserved");
    if (agent === null) {
      // CommitLaunch was sent but no Agent appeared: side effects unknown.
      rt.uncertainTx(attemptId, "agent-not-observed-after-commit");
      return { status: "Uncertain", attemptId };
    }
    rt.finalizeTx(attemptId, agent);
    return { status: "Running", attemptId, sessionId: `ses-${attemptId}` };
  };
}
