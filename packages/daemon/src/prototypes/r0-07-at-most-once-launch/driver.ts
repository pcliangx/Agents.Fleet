// R0-07 — crash-injection driver (RT-T-11). Runs ONE scenario: seed durable
// state, spawn the coordinator as a real child process armed with a crash
// point, let it die mid-protocol, then run Reconciliation from a NEW process
// and collect machine-checkable evidence. Shared by the vitest matrix and
// the evidence CLI (evidence.ts).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandKind, CrashPoint, LaunchCommand, LaunchResult } from "./coordinator.js";
import { scanProcesses } from "./ps-helpers.js";
import type { ReconcileAction } from "./reconcile.js";
import { type DbDump, openLifecycleDb } from "./schema.js";
import { sleep } from "./shared.js";

const here = dirname(fileURLToPath(import.meta.url));
export const BOOTSTRAP_PATH = join(here, "children", "bootstrap.mjs");
export const FAKE_AGENT_PATH = join(here, "children", "fake-agent.mjs");
const COORDINATOR_CHILD = join(here, "children", "coordinator-child.ts");
const RECONCILE_CHILD = join(here, "children", "reconcile-child.ts");

// The fake agent's argv starts with its script path; the bootstrap's argv
// merely CARRIES that path after --agent-path, so the trailing " --nonce"
// distinguishes a live agent from a bootstrap in a global ps scan.
const AGENT_ARGV_MARKER = `${FAKE_AGENT_PATH} --nonce`;

/** Resolve tsx's ESM loader (devDependency, no new deps) for in-process TS children. */
export const resolveTsxLoader = (): string => {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("tsx not found — run pnpm install");
};

export interface ScenarioInput {
  readonly kind: CommandKind;
  readonly crashPoint: CrashPoint | null;
  /** RT-LAUNCH-06 variant: kill the Agent after CommitLaunch, before Reconciliation. */
  readonly killAgentBeforeReconcile?: boolean;
}

export interface ScenarioChecks {
  readonly coordinatorDiedAtArmedPoint: boolean;
  readonly exactlyOneLiveAgent: boolean;
  readonly singleAgentIdentityFile: boolean;
  readonly noInFlightAttemptsLeft: boolean;
  readonly noPlannedSessionsLeft: boolean;
  readonly idempotentReissue: boolean;
  readonly retryConverged: boolean;
  readonly noDuplicateAttemptPerCommand: boolean;
  readonly abortedNonceNeverCommitted: boolean;
  readonly uncertainKeptIntentAuthorized: boolean;
  readonly noAutoReplacementForUncertain: boolean;
}

export interface ScenarioEvidence {
  readonly kind: CommandKind;
  readonly crashPoint: CrashPoint | null;
  readonly killAgentBeforeReconcile: boolean;
  readonly coordinatorExit: { readonly code: number | null; readonly signal: string | null };
  readonly crashedAtMarker: string | null;
  readonly reconcileActions: readonly ReconcileAction[];
  readonly reissueResult: LaunchResult | null;
  readonly retryResult: LaunchResult | null;
  readonly liveAgents: readonly { pid: number; pgid: number; lstart: string }[];
  readonly agentIdentityFiles: readonly string[];
  readonly commitFiles: readonly string[];
  readonly abortFiles: readonly string[];
  readonly bootstrapExits: readonly { nonce: string; exitCode: number; reason: string }[];
  readonly dbDump: DbDump;
  readonly checks: ScenarioChecks;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

const runChild = (script: string, configPath: string, killAfterMs = 60_000): Promise<ChildExit> =>
  new Promise((resolve, reject) => {
    // node --import tsx/esm runs the script IN this child process, so a
    // self-SIGKILL at a crash point is observed as signal SIGKILL (the tsx
    // CLI shim would spawn a grandchild and only report exit code 137).
    const child = spawn(process.execPath, ["--import", resolveTsxLoader(), script, configPath], {
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child ${script} timed out\n${stderr}`));
    }, killAfterMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      if (stderr && code !== 0 && signal === null) {
        reject(new Error(`child ${script} exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

/** Seed tasks / prior lineage: start gets a Draft task; retry/resume get a Runnable task with a prior Failed attempt. */
const seed = (workDir: string, kind: CommandKind, taskId: string): void => {
  writeFileSync(
    join(workDir, "facts.json"),
    JSON.stringify({ worktreeBinding: `wt-${taskId}`, baseCommitSha: "0".repeat(40) }),
  );
  const db = openLifecycleDb(join(workDir, "lifecycle.db"));
  try {
    db.prepare("INSERT INTO tasks (task_id, status) VALUES (?, ?)").run(
      taskId,
      kind === "start" ? "Draft" : "Runnable",
    );
    if (kind !== "start") {
      const seedAttempt = `att-seed-${taskId}`;
      db.prepare(
        "INSERT INTO attempts (attempt_id, command_id, task_id, kind, status, snapshot_json, failure_reason, created_at) VALUES (?, ?, ?, 'start', 'Failed', '{}', 'seed-prior-failure', ?)",
      ).run(seedAttempt, `cmd-seed-${taskId}`, taskId, new Date().toISOString());
      db.prepare(
        "INSERT INTO launch_intents (launch_nonce, attempt_id, command_id, argv_hash, status, abort_reason, created_at) VALUES (?, ?, ?, 'x', 'Aborted', 'seed-prior-failure', ?)",
      ).run(`ln-${seedAttempt}`, seedAttempt, `cmd-seed-${taskId}`, new Date().toISOString());
      db.prepare(
        "INSERT INTO idempotency (command_id, payload_hash, status, result_json) VALUES (?, 'seed', 'failed', ?)",
      ).run(`cmd-seed-${taskId}`, JSON.stringify({ status: "Failed", attemptId: seedAttempt }));
    }
  } finally {
    db.close();
  }
};

export const runScenario = async (
  input: ScenarioInput,
  keepDir = false,
): Promise<ScenarioEvidence> => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-07-scenario-"));
  const taskId = `task-${input.kind}`;
  try {
    seed(workDir, input.kind, taskId);
    const command: LaunchCommand = {
      commandId: `cmd-${input.kind}-1`,
      kind: input.kind,
      taskId,
      argv: ["agent", "run", "--task", taskId],
    };
    const retryCommand: LaunchCommand = {
      commandId: `cmd-${input.kind}-2-retry`,
      kind: "retry",
      taskId,
      argv: command.argv,
    };

    // --- phase 1: the (doomed) coordinator process ---
    const coordinatorConfig = {
      workDir,
      command,
      crashPoint: input.crashPoint,
      driftBeforeRevalidation: input.crashPoint === "afterRevalidationFail",
      bootstrapPath: BOOTSTRAP_PATH,
      agentPath: FAKE_AGENT_PATH,
    };
    const coordinatorConfigPath = join(workDir, "coordinator-config.json");
    writeFileSync(coordinatorConfigPath, JSON.stringify(coordinatorConfig));
    const coordinatorExit = await runChild(COORDINATOR_CHILD, coordinatorConfigPath);

    // RT-LAUNCH-06 variant: let the Agent start, then kill it before Reconciliation.
    if (input.killAgentBeforeReconcile) {
      const deadline = Date.now() + 5000;
      let killed = false;
      while (Date.now() < deadline && !killed) {
        const agents = scanProcesses([AGENT_ARGV_MARKER, workDir]);
        if (agents.length > 0) {
          for (const a of agents) process.kill(a.pid, "SIGKILL");
          killed = true;
        } else {
          await sleep(50);
        }
      }
      await sleep(150); // let the process table settle
    } else {
      await sleep(100); // let an orphaned bootstrap notice its parent is gone
    }

    // --- phase 2: Reconciliation from a NEW process ---
    const reconcileConfig = {
      workDir,
      bootstrapPath: BOOTSTRAP_PATH,
      agentPath: FAKE_AGENT_PATH,
      reissueCommand: command,
      retryCommand,
    };
    const reconcileConfigPath = join(workDir, "reconcile-config.json");
    writeFileSync(reconcileConfigPath, JSON.stringify(reconcileConfig));
    await runChild(RECONCILE_CHILD, reconcileConfigPath);

    // RT-LAUNCH-06 — every bootstrap that ever wrote a receipt MUST exit
    // (committed, aborted, or self-timed-out); wait for the durable exit
    // records so evidence collection is deterministic.
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const files = readdirSync(workDir);
        const receipts = files.filter((f) => /^receipt-.+\.json$/.test(f));
        const exits = new Set(files.filter((f) => /^bootstrap-exit-.+\.json$/.test(f)));
        if (receipts.every((r) => exits.has(`bootstrap-exit-${r.slice("receipt-".length)}`))) {
          break;
        }
        await sleep(50);
      }
    }

    // --- phase 3: collect evidence from an independent viewpoint ---
    const outcome = JSON.parse(readFileSync(join(workDir, "reconcile-outcome.json"), "utf8")) as {
      report: { actions: ReconcileAction[] };
      reissueResult: LaunchResult | null;
      retryResult: LaunchResult | null;
      dbDump: DbDump;
    };
    const files = readdirSync(workDir);
    const crashedAtMarker = files.find((f) => f.startsWith("crashed-at-")) ?? null;
    const agentIdentityFiles = files.filter((f) => /^agent-.+\.json$/.test(f));
    const commitFiles = files.filter((f) => /^commit-.+\.json$/.test(f));
    const abortFiles = files.filter((f) => /^abort-.+\.json$/.test(f));
    const bootstrapExits = files
      .filter((f) => /^bootstrap-exit-.+\.json$/.test(f))
      .map((f) => {
        const r = JSON.parse(readFileSync(join(workDir, f), "utf8")) as {
          nonce: string;
          exitCode: number;
          reason: string;
        };
        return { nonce: r.nonce, exitCode: r.exitCode, reason: r.reason };
      });
    const liveAgents = scanProcesses([AGENT_ARGV_MARKER, workDir]).map((a) => ({
      pid: a.pid,
      pgid: a.pgid,
      lstart: a.lstart,
    }));

    const evidence = buildEvidence(input, {
      coordinatorExit,
      crashedAtMarker,
      outcome,
      liveAgents,
      agentIdentityFiles,
      commitFiles,
      abortFiles,
      bootstrapExits,
    });

    // cleanup: never leak fake agents across scenarios
    for (const a of liveAgents) {
      try {
        process.kill(a.pid, "SIGKILL");
      } catch {}
    }
    return evidence;
  } finally {
    if (!keepDir) rmSync(workDir, { recursive: true, force: true });
  }
};

const buildEvidence = (
  input: ScenarioInput,
  got: {
    coordinatorExit: ChildExit;
    crashedAtMarker: string | null;
    outcome: {
      report: { actions: ReconcileAction[] };
      reissueResult: LaunchResult | null;
      retryResult: LaunchResult | null;
      dbDump: DbDump;
    };
    liveAgents: { pid: number; pgid: number; lstart: string }[];
    agentIdentityFiles: string[];
    commitFiles: string[];
    abortFiles: string[];
    bootstrapExits: { nonce: string; exitCode: number; reason: string }[];
  },
): ScenarioEvidence => {
  const { outcome } = got;
  const dump = outcome.dbDump;
  const originalAttemptId = `att-cmd-${input.kind}-1`;
  const reissue = outcome.reissueResult;

  const abortedIntents = dump.launchIntents.filter((i) => i.status === "Aborted");
  const committedNonces = new Set(
    got.commitFiles.map((f) => f.replace(/^commit-/, "").replace(/\.json$/, "")),
  );
  const agentNonces = new Set(
    got.agentIdentityFiles.map((f) => f.replace(/^agent-/, "").replace(/\.json$/, "")),
  );
  const originalAttempt = dump.attempts.find((a) => a.attempt_id === originalAttemptId);
  const originalIntent = dump.launchIntents.find((i) => i.attempt_id === originalAttemptId);

  const expectUncertain = input.killAgentBeforeReconcile === true;
  const expectRunning =
    !expectUncertain &&
    (input.crashPoint === null ||
      input.crashPoint === "afterCommandTx" ||
      input.crashPoint === "afterLaunchTx" ||
      input.crashPoint === "afterCommitSent" ||
      input.crashPoint === "afterAgentObserved");

  const commandCounts = new Map<string, number>();
  for (const a of dump.attempts) {
    commandCounts.set(a.command_id, (commandCounts.get(a.command_id) ?? 0) + 1);
  }

  const checks: ScenarioChecks = {
    coordinatorDiedAtArmedPoint:
      input.crashPoint === null
        ? got.coordinatorExit.code === 0
        : got.coordinatorExit.signal === "SIGKILL" &&
          got.crashedAtMarker === `crashed-at-${input.crashPoint}`,
    exactlyOneLiveAgent: expectUncertain
      ? got.liveAgents.length === 0
      : got.liveAgents.length === 1,
    singleAgentIdentityFile: expectUncertain
      ? got.agentIdentityFiles.length <= 1
      : got.agentIdentityFiles.length === 1,
    noInFlightAttemptsLeft: dump.attempts.every(
      (a) => a.status !== "Queued" && a.status !== "Starting",
    ),
    noPlannedSessionsLeft: dump.sessions.every((s) => s.availability !== "Planned"),
    idempotentReissue: expectUncertain
      ? reissue?.status === "Uncertain"
      : expectRunning
        ? reissue?.status === "Running" &&
          (reissue as { attemptId?: string }).attemptId === originalAttemptId
        : reissue?.status === "Failed" &&
          (reissue as { attemptId?: string }).attemptId === originalAttemptId,
    retryConverged: expectUncertain
      ? outcome.retryResult === null // RT-LAUNCH-06: NO automatic replacement
      : expectRunning
        ? outcome.retryResult === null
        : outcome.retryResult?.status === "Running",
    noDuplicateAttemptPerCommand: [...commandCounts.values()].every((n) => n === 1),
    // RT-LAUNCH-05/08 — an Aborted nonce was never committed and never exec'd.
    abortedNonceNeverCommitted: abortedIntents.every(
      (i) => !committedNonces.has(i.launch_nonce) && !agentNonces.has(i.launch_nonce),
    ),
    // RT-LAUNCH-08 tail — delivery unknown ⇒ NOT Aborted.
    uncertainKeptIntentAuthorized: expectUncertain
      ? originalAttempt?.status === "Uncertain" && originalIntent?.status === "Authorized"
      : true,
    noAutoReplacementForUncertain: expectUncertain
      ? dump.attempts.filter((a) => a.command_id.startsWith(`cmd-${input.kind}-`)).length === 1 &&
        got.liveAgents.length === 0
      : true,
  };

  return {
    kind: input.kind,
    crashPoint: input.crashPoint,
    killAgentBeforeReconcile: input.killAgentBeforeReconcile === true,
    coordinatorExit: got.coordinatorExit,
    crashedAtMarker: got.crashedAtMarker,
    reconcileActions: outcome.report.actions,
    reissueResult: outcome.reissueResult,
    retryResult: outcome.retryResult,
    liveAgents: got.liveAgents,
    agentIdentityFiles: got.agentIdentityFiles,
    commitFiles: got.commitFiles,
    abortFiles: got.abortFiles,
    bootstrapExits: got.bootstrapExits,
    dbDump: dump,
    checks,
  };
};

export const allChecksPass = (e: ScenarioEvidence): boolean =>
  Object.values(e.checks).every(Boolean);
