// R0-07 — Reconciliation for the at-most-once launch protocol. Runs in a NEW
// process after the coordinator died mid-handshake (RT-T-11). It never
// creates a second Attempt / bootstrap / Agent for an existing commandId
// (RT-LAUNCH-05): it either continues the SAME persisted handshake when that
// is provably side-effect-free, or resolves it to terminal truth
// (Failed via Aborted, or Uncertain when CommitLaunch delivery is unknown).

import { existsSync } from "node:fs";
import type { LaunchRuntime } from "./coordinator.js";
import { commitPath, receiptPath } from "./paths.js";
import { probeProcess, type RecordedProcessIdentity } from "./ps-helpers.js";
import type { AttemptRow } from "./schema.js";
import { readJsonFile, readSnapshot, sleep } from "./shared.js";

export interface ReconcileAction {
  readonly attemptId: string;
  readonly action:
    | "continued-from-queued"
    | "continued-from-prepared"
    | "aborted-bootstrap-lost"
    | "aborted-commit-never-sent"
    | "resolved-running-via-probe"
    | "uncertain-commit-delivery-unknown"
    | "already-terminal"
    | "already-running";
  readonly detail?: string;
}

export interface ReconcileReport {
  readonly actions: readonly ReconcileAction[];
}

export interface ReconcileOptions {
  readonly rt: LaunchRuntime;
  /** How long to wait for a doomed (parent-dead) bootstrap to self-timeout. */
  readonly waitBootstrapGoneMs?: number;
}

export const reconcile = async (opts: ReconcileOptions): Promise<ReconcileReport> => {
  const { rt } = opts;
  const actions: ReconcileAction[] = [];

  const inFlight = rt.db
    .prepare(
      `SELECT a.*, i.launch_nonce AS i_nonce, i.status AS i_status, i.argv_hash AS i_argv_hash,
              i.bootstrap_pid AS i_bpid, i.bootstrap_pgid AS i_bpgid, i.bootstrap_lstart AS i_blstart,
              i.commit_sent_at AS i_commit_sent_at
       FROM attempts a LEFT JOIN launch_intents i ON i.attempt_id = a.attempt_id
       WHERE a.status IN ('Queued', 'Starting', 'Running')
       ORDER BY a.created_at`,
    )
    .all() as unknown as Array<
    AttemptRow & {
      i_nonce: string | null;
      i_status: string | null;
      i_argv_hash: string | null;
      i_bpid: number | null;
      i_bpgid: number | null;
      i_blstart: string | null;
      i_commit_sent_at: string | null;
    }
  >;

  for (const row of inFlight) {
    const attemptId = row.attempt_id;

    if (row.status === "Running") {
      actions.push({ attemptId, action: "already-running" });
      continue;
    }

    if (row.status === "Queued") {
      // Crash between command tx and launch tx: nothing was ever spawned.
      // Continue the SAME handshake (RT-LAUNCH-05) — no new Attempt.
      const argvHash = readSnapshot(rt.db, attemptId).argvHash;
      const nonce = rt.launchTx(attemptId, row.command_id, argvHash);
      await continueFromPrepared(
        opts,
        nonce,
        argvHash,
        attemptId,
        actions,
        "continued-from-queued",
      );
      continue;
    }

    // status === "Starting" — an intent always exists here (same tx).
    const nonce = row.i_nonce as string;
    const argvHash = row.i_argv_hash as string;
    const intentStatus = row.i_status as string;

    if (intentStatus === "Aborted") {
      // Aborted is terminal; the abort tx already Failed the attempt. A row
      // still Starting here would be corruption — never resurrect the nonce.
      actions.push({ attemptId, action: "already-terminal", detail: "intent-aborted" });
      continue;
    }

    if (intentStatus === "Prepared") {
      if (!existsSync(receiptPath(rt.workDir, nonce))) {
        // Crash before the bootstrap wrote its receipt (or before spawn):
        // provably no side effects → continue the same handshake.
        await continueFromPrepared(
          opts,
          nonce,
          argvHash,
          attemptId,
          actions,
          "continued-from-prepared",
        );
      } else {
        // A bootstrap ran orphaned; it can never be authorized now and
        // self-times-out (RT-LAUNCH-06). CommitLaunch was provably never
        // sent (only sent after Authorized) → clean abort.
        await waitBootstrapGone(opts, row, nonce);
        rt.abortTx(nonce, "bootstrap-lost-before-authorize");
        actions.push({ attemptId, action: "aborted-bootstrap-lost" });
      }
      continue;
    }

    // intentStatus === "Authorized"
    const commitSent = existsSync(commitPath(rt.workDir, nonce));
    if (!commitSent && row.i_commit_sent_at === null) {
      // CommitLaunch provably never sent (the atomic rename is the ONLY send):
      // no Agent could have started → Authorized → Aborted is legal here.
      await waitBootstrapGone(opts, row, nonce);
      rt.abortTx(nonce, "commit-never-sent-daemon-lost");
      actions.push({ attemptId, action: "aborted-commit-never-sent" });
      continue;
    }

    // CommitLaunch was sent (or recording its send was lost): delivery
    // unknown → RT-LAUNCH-08 FORBIDS Aborted. Probe the durable receipt and
    // full process identity (RT-LAUNCH-06); resolve by observation only.
    const agent = await rt.observeAgent(nonce, argvHash);
    if (agent !== null) {
      rt.finalizeTx(attemptId, agent);
      actions.push({ attemptId, action: "resolved-running-via-probe", detail: `pid=${agent.pid}` });
    } else {
      rt.uncertainTx(attemptId, "commit-delivery-unknown-agent-not-found");
      actions.push({ attemptId, action: "uncertain-commit-delivery-unknown" });
    }
  }

  return { actions };
};

/** Continue the handshake from Prepared: spawn bootstrap → authorize → revalidate → commit → observe → finalize. */
const continueFromPrepared = async (
  opts: ReconcileOptions,
  nonce: string,
  argvHash: string,
  attemptId: string,
  actions: ReconcileAction[],
  action: ReconcileAction["action"],
): Promise<void> => {
  const { rt } = opts;
  let receipt: RecordedProcessIdentity;
  try {
    receipt = await rt.spawnBootstrapAndAwaitReceipt(nonce, argvHash);
  } catch {
    rt.abortTx(nonce, "bootstrap-receipt-lost");
    actions.push({ attemptId, action: "aborted-bootstrap-lost", detail: "receipt-lost" });
    return;
  }
  rt.authorizeTx(nonce, receipt);
  // RT-LAUNCH-08: Reconciliation also revalidates the RT-CMD-16 facts before CommitLaunch.
  const drifted = rt.factHash() !== readSnapshot(rt.db, attemptId).factHash;
  if (drifted) {
    rt.abortTx(nonce, "fact-drift");
    rt.sendAbort(nonce);
    actions.push({ attemptId, action: "aborted-commit-never-sent", detail: "fact-drift" });
    return;
  }
  rt.sendCommit(nonce, argvHash);
  rt.recordCommitSentTx(nonce);
  const agent: RecordedProcessIdentity | null = await rt.observeAgent(nonce, argvHash);
  if (agent === null) {
    rt.uncertainTx(attemptId, "agent-not-observed-after-commit");
    actions.push({ attemptId, action: "uncertain-commit-delivery-unknown", detail: "post-resume" });
    return;
  }
  rt.finalizeTx(attemptId, agent);
  actions.push({ attemptId, action, detail: `pid=${agent.pid}` });
};

/**
 * An orphaned bootstrap whose Daemon died MUST self-timeout (RT-LAUNCH-06);
 * wait until its full identity is gone before concluding anything. Identity
 * comes from the authorize tx when present, else from the durable receipt.
 */
const waitBootstrapGone = async (
  opts: ReconcileOptions,
  row: { i_bpid: number | null; i_bpgid: number | null; i_blstart: string | null },
  nonce: string,
): Promise<void> => {
  let pid = row.i_bpid;
  let pgid = row.i_bpgid;
  let lstart = row.i_blstart;
  if (pid === null) {
    const receipt = readJsonFile<RecordedProcessIdentity>(receiptPath(opts.rt.workDir, nonce));
    if (!receipt) return;
    pid = receipt.pid;
    pgid = receipt.pgid;
    lstart = receipt.lstart;
  }
  const deadline = Date.now() + (opts.waitBootstrapGoneMs ?? 4000);
  while (Date.now() < deadline) {
    const probe = probeProcess(pid, {
      pgid: pgid ?? undefined,
      lstart: lstart ?? undefined,
      commandIncludes: [opts.rt.bootstrapPath],
    });
    if (!probe.found) return;
    await sleep(50);
  }
};
