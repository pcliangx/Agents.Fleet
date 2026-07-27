import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type ConfirmationChallenge,
  type ConfirmationReceipt,
  FROZEN_PERFORMANCE_BUDGET,
  type LaunchSpec,
  type PreparedLaunch,
} from "@agents-fleet/contracts";
import { signConfirmation } from "@agents-fleet/transport";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import {
  copyNodePtyWithHelperMode,
  type TempNodePtyCopy,
} from "../native-artifact/temp-node-pty-copy.js";
import { resolveTsxLoader } from "../prototypes/r0-07-at-most-once-launch/driver.js";
import { openDatabase } from "../storage/database.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { WorktreeStore } from "../storage/worktree-store.js";
import { TaskOrchestrator } from "../task-orchestrator/task-orchestrator.js";
import {
  createProcessSupervisor,
  type ProcessSupervisor,
  type PtyDriver,
  type PtyDriverProcess,
} from "./process-supervisor.js";
import { SessionRuntime } from "./session-runtime.js";

const T0 = 1_800_000_000_000;
const SHA = "b".repeat(40);
const CONFIRMATION_TOKEN = new TextEncoder().encode("r1-06-confirmation-token");
const tempDirs: string[] = [];
const databases: DatabaseSync[] = [];
const nativeCopies: TempNodePtyCopy[] = [];
const TEST_CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-children",
  "runtime-crash-child.ts",
);

const runTestChild = (
  configPath: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", resolveTsxLoader(), TEST_CHILD, configPath],
      { stdio: "pipe" },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SessionRuntime child timed out: ${stderr}`));
    }, 15_000);
    child.stderr.on("data", (bytes) => {
      stderr += String(bytes);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 && signal === null) {
        reject(new Error(`SessionRuntime child exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const copy of nativeCopies.splice(0)) await copy.cleanup();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed before timeout");
};

const createConfirmations = (db: DatabaseSync, now: () => number = () => T0) =>
  new PersistentChallengeIssuer({
    db,
    token: CONFIRMATION_TOKEN,
    now,
  });

const confirm = (challenge: ConfirmationChallenge): ConfirmationReceipt => {
  const confirmedAt = new Date(T0).toISOString();
  return {
    challengeId: challenge.challengeId,
    confirmedAt,
    proof: signConfirmation(challenge, confirmedAt, CONFIRMATION_TOKEN),
  };
};

const createRealProcessSupervisor = async (
  injectedOutputListeners?: Set<(bytes: Uint8Array) => void>,
): Promise<ProcessSupervisor> => {
  const copy = await copyNodePtyWithHelperMode(0o755);
  nativeCopies.push(copy);
  const driver: PtyDriver = {
    spawn(executablePath, args, options): PtyDriverProcess {
      const process = copy.nodePty.spawn(executablePath, [...args], {
        ...options,
        env: { ...options.env },
      });
      return {
        pid: process.pid,
        write: (data) => process.write(Buffer.from(data)),
        resize: (cols, rows) => process.resize(cols, rows),
        kill: () => process.kill(),
        onData: (listener) => {
          injectedOutputListeners?.add(listener);
          const subscription = process.onData((data) => listener(data as Uint8Array));
          return {
            dispose() {
              injectedOutputListeners?.delete(listener);
              subscription.dispose();
            },
          };
        },
        onExit: (listener) =>
          process.onExit((event) =>
            listener({ exitCode: event.exitCode, signal: event.signal ?? 0 }),
          ),
      };
    },
  };
  return createProcessSupervisor(driver);
};

const createControllableProcessSupervisor = async (): Promise<{
  readonly processSupervisor: ProcessSupervisor;
  readonly emitOutput: (bytes: Uint8Array) => void;
}> => {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  return {
    processSupervisor: await createRealProcessSupervisor(listeners),
    emitOutput: (bytes) => {
      for (const listener of listeners) listener(bytes);
    },
  };
};

const setupPreparedLaunch = async (
  options: {
    readonly keepAlive?: boolean;
    readonly missingExecutable?: boolean;
    readonly wrapperExecutable?: boolean;
    readonly outputBytes?: readonly number[];
  } = {},
): Promise<{
  readonly db: DatabaseSync;
  readonly root: string;
  readonly prepared: PreparedLaunch;
  readonly counterPath: string;
}> => {
  const root = mkdtempSync(join(tmpdir(), "af-r105-runtime-"));
  tempDirs.push(root);
  const opened = openDatabase({ path: join(root, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(`database not ready: ${opened.reason}`);
  databases.push(opened.db);
  const db = opened.db;
  const now = new Date(T0).toISOString();
  const worktreePath = join(root, "worktree");
  const counterPath = join(root, "agent-start-count");
  mkdirSync(worktreePath);

  db.prepare(
    `INSERT INTO repository_trusts
      (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino,
       user_identity, challenge_id, created_at, updated_at)
     VALUES ('trust-1', 1, 'Active', ?, 1, 2, 'user', 'challenge', ?, ?)`,
  ).run(root, now, now);
  db.prepare(
    `INSERT INTO workspaces
      (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev,
       common_git_ino, head_commit_sha, current_branch, default_base_ref,
       default_base_ref_sha, git_version, defaults_json, observed_at, created_at)
     VALUES ('workspace-1', 'trust-1', ?, ?, 3, 4, ?, 'main',
             'refs/heads/main', ?, '2.50.1', '{}', ?, ?)`,
  ).run(root, join(root, ".git"), SHA, SHA, now, now);
  db.prepare(
    `INSERT INTO tasks
      (task_id, workspace_id, lifecycle, spec_json, task_spec_version, created_at, updated_at)
     VALUES ('task-1', 'workspace-1', 'Runnable', '{"goal":"test"}', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO attempts
      (attempt_id, task_id, status, spec_snapshot_json, task_spec_version, created_seq, created_at)
     VALUES ('attempt-1', 'task-1', 'Queued', '{"goal":"test"}', 1, 1, ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO fleet_worktrees
      (worktree_id, workspace_id, task_id, state, role, canonical_path,
       repository_identity, branch_name, base_commit_sha, head_commit_sha,
       fs_dev, fs_ino, state_version, observed_at, created_at, updated_at)
     VALUES ('worktree-1', 'workspace-1', 'task-1', 'Ready', 'Active', ?,
             '3:4', 'fleet/runtime', ?, ?, 10, 20, 1, ?, ?, ?)`,
  ).run(worktreePath, SHA, SHA, now, now, now);
  db.prepare(
    `INSERT INTO attempt_worktree_bindings
      (attempt_id, worktree_id, base_commit_sha, created_at)
     VALUES ('attempt-1', 'worktree-1', ?, ?)`,
  ).run(SHA, now);

  const script = [
    'const fs = require("node:fs");',
    "fs.appendFileSync(process.argv[1], 'x');",
    `process.stdout.write(Buffer.from(${JSON.stringify(options.outputBytes ?? [0x41, 0xff, 0x42])}));`,
    ...(options.keepAlive === false
      ? ["setTimeout(() => {}, 300);"]
      : ["setInterval(() => {}, 1000);"]),
  ].join("");
  const wrapperPath = join(root, "agent-wrapper");
  if (options.wrapperExecutable === true) {
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\nagent_executable="$1"\nshift\nexec "$agent_executable" "$@"\n',
      { mode: 0o755 },
    );
  }
  const spec: LaunchSpec = {
    executablePath: options.missingExecutable
      ? join(root, "missing-agent")
      : options.wrapperExecutable === true
        ? wrapperPath
        : process.execPath,
    argv:
      options.wrapperExecutable === true
        ? [process.execPath, "-e", script, counterPath]
        : ["-e", script, counterPath],
    cwd: worktreePath,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    channel: "interactive-pty",
    capabilities: ["Discovery"],
    permissionMapping: {
      requestedMode: "Manual",
      effectiveMode: "Manual",
      launchArgumentsPreview: [],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: [],
    },
    secretReferenceIdentities: [],
  };
  const orchestrator = new TaskOrchestrator({
    db,
    now: () => T0,
    prepareLaunch: async () => ({
      commandId: "command-1",
      agentId: "claude-code",
      launchSpec: spec,
    }),
  });
  const prepared = await orchestrator.scheduleNext();
  if (prepared.kind !== "prepared") throw new Error(`launch not prepared: ${prepared.kind}`);
  return { db, root, prepared, counterPath };
};

describe("SessionRuntime.launch (RT-LAUNCH-02..05)", () => {
  it("returns the original Running Session when the same launch is issued twice and starts one Agent", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    const first = await runtime.launch(prepared, { revalidate: async () => true });
    const second = await runtime.launch(prepared, { revalidate: async () => true });

    expect(first).toMatchObject({
      kind: "running",
      attemptId: "attempt-1",
      sessionId: prepared.plannedSessionId,
    });
    expect(second).toEqual(first);
    await waitFor(() => existsSync(counterPath));
    expect(readFileSync(counterPath, "utf8")).toBe("x");

    if (first.kind === "running") await runtime.terminate(first.sessionId);
  });

  it("observes an Agent launched through an executable wrapper", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch({
      wrapperExecutable: true,
    });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    try {
      expect(launched).toMatchObject({
        kind: "running",
        attemptId: "attempt-1",
        sessionId: prepared.plannedSessionId,
      });
      await waitFor(() => existsSync(counterPath));
      expect(readFileSync(counterPath, "utf8")).toBe("x");
    } finally {
      await runtime.terminate(prepared.plannedSessionId);
    }
  });

  it("observes the committed Agent when bootstrap ps stalls and Daemon ps is unavailable", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const stalledProbePath = join(root, "stalled-ps");
    writeFileSync(stalledProbePath, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      bootstrapProcessProbePath: stalledProbePath,
      processProbe: () => ({ kind: "unavailable" }),
    });

    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    try {
      expect(launched).toMatchObject({
        kind: "running",
        attemptId: "attempt-1",
        sessionId: prepared.plannedSessionId,
      });
      await waitFor(() => existsSync(counterPath));
      expect(readFileSync(counterPath, "utf8")).toBe("x");
    } finally {
      await runtime.terminate(prepared.plannedSessionId);
    }
  });

  it("observes the committed Agent when close-on-exec EOF is unavailable", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      processProbe: () => ({ kind: "unavailable" }),
      waitForExecBarrier: async () => false,
    });

    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    try {
      await waitFor(() => existsSync(counterPath));
      const execReceipt = JSON.parse(
        readFileSync(join(root, "launch", prepared.launchNonce, "exec-receipt.json"), "utf8"),
      ) as { readonly pid: number };
      const intent = db
        .prepare("SELECT bootstrap_pid FROM launch_intents WHERE launch_nonce = ?")
        .get(prepared.launchNonce) as { readonly bootstrap_pid: number };
      expect(execReceipt.pid).toBe(intent.bootstrap_pid);
      expect(launched).toMatchObject({
        kind: "running",
        attemptId: "attempt-1",
        sessionId: prepared.plannedSessionId,
      });
      expect(readFileSync(counterPath, "utf8")).toBe("x");
    } finally {
      await runtime.terminate(prepared.plannedSessionId);
    }
  });

  it("exposes raw PTY bytes only through the durable Session frame reader", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    expect(launched.kind).toBe("running");
    if (launched.kind !== "running") throw new Error(`unexpected launch result: ${launched.kind}`);

    await waitFor(
      () =>
        runtime.readDurableFrame({
          sessionId: launched.sessionId,
          generation: launched.generation,
          seq: 1,
        }) !== null,
    );
    const frame = runtime.readDurableFrame({
      sessionId: launched.sessionId,
      generation: launched.generation,
      seq: 1,
    });
    if (frame === null) throw new Error("durable frame disappeared");
    expect([...frame]).toEqual([0x41, 0xff, 0x42]);

    await runtime.terminate(launched.sessionId);
  });

  it("records an observed Agent exit as Exited without inventing a replacement Session", async () => {
    const { db, root, prepared } = await setupPreparedLaunch({ keepAlive: false });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    expect(launched.kind).toBe("running");
    if (launched.kind !== "running") throw new Error(`unexpected launch result: ${launched.kind}`);

    await waitFor(
      () => runtime.inspectSession(launched.sessionId)?.availability === "Exited",
      5_000,
    );
    expect(runtime.inspectSession(launched.sessionId)).toMatchObject({
      sessionId: launched.sessionId,
      attemptId: launched.attemptId,
      generation: 1,
      availability: "Exited",
    });
  });

  it("marks a formerly Alive Session Lost after Runtime restart and never auto-launches a replacement", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const original = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await original.launch(prepared, { revalidate: async () => true });
    expect(launched.kind).toBe("running");
    if (launched.kind !== "running") throw new Error(`unexpected launch result: ${launched.kind}`);

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const report = restarted.reconcileAfterRestart();

    expect(report.actions).toEqual([
      {
        action: "marked-lost",
        attemptId: launched.attemptId,
        sessionId: launched.sessionId,
      },
    ]);
    expect(restarted.inspectSession(launched.sessionId)?.availability).toBe("Lost");
    expect(new WorktreeStore(db).disposeLifecycleFacts("worktree-1").processDispositions).toEqual([
      expect.objectContaining({
        attemptId: launched.attemptId,
        disposition: "OrphanFound",
      }),
    ]);
    expect(
      (
        db.prepare("SELECT status FROM attempts WHERE attempt_id = ?").get(launched.attemptId) as {
          status: string;
        }
      ).status,
    ).toBe("Uncertain");
    expect(await restarted.launch(prepared, { revalidate: async () => true })).toEqual(launched);

    await original.terminate(launched.sessionId);
  });

  it("aborts before CommitLaunch when final fact revalidation cannot be completed", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    const failed = await runtime.launch(prepared, {
      revalidate: async () => {
        throw new Error("identity probe unavailable");
      },
    });

    expect(failed).toEqual({
      kind: "failed",
      attemptId: prepared.attemptId,
      reason: "launch-facts-unverifiable",
    });
    expect(runtime.inspectSession(prepared.plannedSessionId)).toBeNull();
    expect(existsSync(counterPath)).toBe(false);
    await expect(runtime.launch(prepared, { revalidate: async () => true })).resolves.toEqual(
      failed,
    );
  });

  it("keeps the slot under Probing when CommitLaunch was sent but no Agent can be observed", async () => {
    const { db, root, prepared } = await setupPreparedLaunch({ missingExecutable: true });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      agentTimeoutMs: 300,
    });

    const uncertain = await runtime.launch(prepared, { revalidate: async () => true });

    expect(uncertain).toEqual({
      kind: "uncertain",
      attemptId: prepared.attemptId,
      reason: "agent-not-observed-after-commit",
    });
    expect(runtime.inspectSession(prepared.plannedSessionId)).toBeNull();
    expect(new WorktreeStore(db).disposeLifecycleFacts("worktree-1").processDispositions).toEqual([
      expect.objectContaining({
        attemptId: prepared.attemptId,
        disposition: "Probing",
      }),
    ]);
    await expect(runtime.launch(prepared, { revalidate: async () => true })).resolves.toEqual(
      uncertain,
    );
  });

  it("resumes the same Prepared nonce after restart when no bootstrap receipt was ever written", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });

    expect(restarted.reconcileAfterRestart().actions).toEqual([
      {
        action: "resume-prepared",
        attemptId: prepared.attemptId,
        launchNonce: prepared.launchNonce,
        preparedLaunch: prepared,
      },
    ]);
    const launched = await restarted.launch(prepared, { revalidate: async () => true });

    expect(launched.kind).toBe("running");
    await waitFor(() => existsSync(counterPath));
    expect(readFileSync(counterPath, "utf8")).toBe("x");
    if (launched.kind === "running") await restarted.terminate(launched.sessionId);
  });

  it("aborts an Authorized launch after restart when CommitLaunch was definitely never sent", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const crashing = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      onLaunchStep: (step) => {
        if (step === "afterAuthorize") throw new Error("simulated daemon crash");
      },
    });

    const outcome = await crashing.launch(prepared, { revalidate: async () => true }).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ kind: "crashed" as const, error }),
    );
    if (outcome.kind === "completed" && outcome.value.kind === "running") {
      await crashing.terminate(outcome.value.sessionId);
    }
    expect(outcome).toMatchObject({
      kind: "crashed",
      error: expect.objectContaining({ message: "simulated daemon crash" }),
    });

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    expect(restarted.reconcileAfterRestart().actions).toEqual([
      {
        action: "aborted-before-commit",
        attemptId: prepared.attemptId,
        launchNonce: prepared.launchNonce,
      },
    ]);
    expect(existsSync(counterPath)).toBe(false);
    await expect(restarted.launch(prepared, { revalidate: async () => true })).resolves.toEqual({
      kind: "failed",
      attemptId: prepared.attemptId,
      reason: "commit-never-sent-after-restart",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("marks the Attempt Uncertain after restart when CommitLaunch delivery may have occurred", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const crashing = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      onLaunchStep: (step) => {
        if (step === "afterCommitSent") throw new Error("simulated daemon crash");
      },
    });
    await expect(crashing.launch(prepared, { revalidate: async () => true })).rejects.toThrow(
      "simulated daemon crash",
    );

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    expect(restarted.reconcileAfterRestart().actions).toEqual([
      {
        action: "marked-uncertain",
        attemptId: prepared.attemptId,
        launchNonce: prepared.launchNonce,
      },
    ]);
    expect(new WorktreeStore(db).disposeLifecycleFacts("worktree-1").processDispositions).toEqual([
      expect.objectContaining({
        attemptId: prepared.attemptId,
        disposition: "OrphanFound",
      }),
    ]);
    await expect(restarted.launch(prepared, { revalidate: async () => true })).resolves.toEqual({
      kind: "uncertain",
      attemptId: prepared.attemptId,
      reason: "commit-delivery-unknown-after-restart",
    });

    await crashing.terminate(prepared.plannedSessionId);
  });

  it("aborts a Prepared launch after restart when an old bootstrap receipt already exists", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const crashing = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      onLaunchStep: (step) => {
        if (step === "afterBootstrapReceipt") throw new Error("simulated daemon crash");
      },
    });
    await expect(crashing.launch(prepared, { revalidate: async () => true })).rejects.toThrow(
      "simulated daemon crash",
    );

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    expect(restarted.reconcileAfterRestart().actions).toEqual([
      {
        action: "aborted-bootstrap-lost",
        attemptId: prepared.attemptId,
        launchNonce: prepared.launchNonce,
      },
    ]);
    expect(existsSync(counterPath)).toBe(false);
    await expect(restarted.launch(prepared, { revalidate: async () => true })).resolves.toEqual({
      kind: "failed",
      attemptId: prepared.attemptId,
      reason: "bootstrap-lost-before-authorize",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("reports an indexed corrupt chunk as a data gap after restart and refuses to read it", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    expect(launched.kind).toBe("running");
    if (launched.kind !== "running") throw new Error(`unexpected launch result: ${launched.kind}`);
    await waitFor(
      () =>
        runtime.readDurableFrame({
          sessionId: launched.sessionId,
          generation: launched.generation,
          seq: 1,
        }) !== null,
    );
    await runtime.terminate(launched.sessionId);

    const chunkDir = join(root, "chunks", launched.sessionId, String(launched.generation));
    const chunkName = readdirSync(chunkDir).find((name) => name.endsWith(".bin"));
    if (chunkName === undefined) throw new Error("durable chunk file missing");
    writeFileSync(join(chunkDir, chunkName), Buffer.from("corrupt"));

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const report = restarted.reconcileAfterRestart();

    expect(report.dataIntegrity).toMatchObject({
      verifiedChunks: 0,
      dataGapCount: 1,
    });
    expect(() =>
      restarted.readDurableFrame({
        sessionId: launched.sessionId,
        generation: launched.generation,
        seq: 1,
      }),
    ).toThrowError(expect.objectContaining({ name: "DataIntegrityFailure" }));
  });

  it("returns a durable failure when the bootstrap exits before publishing its receipt", async () => {
    const { db, root, prepared, counterPath } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      bootstrapPath: join(root, "missing-bootstrap.mjs"),
      receiptTimeoutMs: 200,
    });

    const failed = await runtime.launch(prepared, { revalidate: async () => true });

    expect(failed).toEqual({
      kind: "failed",
      attemptId: prepared.attemptId,
      reason: "bootstrap-receipt-lost",
    });
    expect(runtime.inspectSession(prepared.plannedSessionId)).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { readonly count: number })
        .count,
    ).toBe(0);
    expect(existsSync(counterPath)).toBe(false);
    await expect(runtime.launch(prepared, { revalidate: async () => true })).resolves.toEqual(
      failed,
    );
  });

  it("persists Waiting/StoragePressure, retains the slot, and resumes only after revalidation", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`unexpected launch result: ${launched.kind}`);

    await expect(runtime.pauseForStoragePressure(launched.attemptId)).resolves.toEqual({
      attemptId: launched.attemptId,
      waitingReason: "StoragePressure",
      resumeStatus: "Running",
    });
    expect(
      db
        .prepare("SELECT status, waiting_reason, resume_status FROM attempts WHERE attempt_id = ?")
        .get(launched.attemptId),
    ).toEqual({
      status: "Waiting",
      waiting_reason: "StoragePressure",
      resume_status: "Running",
    });
    expect(
      db
        .prepare("SELECT released_at FROM slot_leases WHERE attempt_id = ?")
        .get(launched.attemptId),
    ).toEqual({ released_at: null });

    await expect(
      runtime.resumeFromStoragePressure(launched.attemptId, {
        revalidate: async () => false,
      }),
    ).rejects.toThrow("resume facts drifted");
    expect(
      (
        db.prepare("SELECT status FROM attempts WHERE attempt_id = ?").get(launched.attemptId) as {
          status: string;
        }
      ).status,
    ).toBe("Waiting");

    await expect(
      runtime.resumeFromStoragePressure(launched.attemptId, {
        revalidate: async () => true,
      }),
    ).resolves.toBe("Running");
    expect(
      db
        .prepare("SELECT status, waiting_reason, resume_status FROM attempts WHERE attempt_id = ?")
        .get(launched.attemptId),
    ).toEqual({
      status: "Running",
      waiting_reason: null,
      resume_status: null,
    });
    await runtime.terminate(launched.sessionId);
  });

  it("restores Starting and Stopping from StoragePressure without collapsing either phase", async () => {
    const starting = await setupPreparedLaunch();
    const startingRuntime = new SessionRuntime({
      db: starting.db,
      storeDir: starting.root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    let releaseValidation: ((value: boolean) => void) | undefined;
    const validationGate = new Promise<boolean>((resolve) => {
      releaseValidation = resolve;
    });
    const startingLaunch = startingRuntime.launch(starting.prepared, {
      revalidate: async () => await validationGate,
    });
    await waitFor(
      () =>
        (
          starting.db
            .prepare("SELECT bootstrap_pid FROM launch_intents WHERE launch_nonce = ?")
            .get(starting.prepared.launchNonce) as { bootstrap_pid: number | null }
        ).bootstrap_pid !== null,
    );
    await expect(
      startingRuntime.pauseForStoragePressure(starting.prepared.attemptId),
    ).resolves.toMatchObject({ resumeStatus: "Starting" });
    await expect(
      startingRuntime.resumeFromStoragePressure(starting.prepared.attemptId, {
        revalidate: async () => true,
      }),
    ).resolves.toBe("Starting");
    releaseValidation?.(true);
    const startingResult = await startingLaunch;
    if (startingResult.kind !== "running") {
      throw new Error(`unexpected launch result: ${startingResult.kind}`);
    }
    await startingRuntime.terminate(startingResult.sessionId);

    const stopping = await setupPreparedLaunch();
    const stoppingRuntime = new SessionRuntime({
      db: stopping.db,
      storeDir: stopping.root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const stoppingResult = await stoppingRuntime.launch(stopping.prepared, {
      revalidate: async () => true,
    });
    if (stoppingResult.kind !== "running") {
      throw new Error(`unexpected launch result: ${stoppingResult.kind}`);
    }
    stopping.db
      .prepare("UPDATE attempts SET status = 'Stopping' WHERE attempt_id = ?")
      .run(stoppingResult.attemptId);
    await expect(
      stoppingRuntime.pauseForStoragePressure(stoppingResult.attemptId),
    ).resolves.toMatchObject({ resumeStatus: "Stopping" });
    await expect(
      stoppingRuntime.resumeFromStoragePressure(stoppingResult.attemptId, {
        revalidate: async () => true,
      }),
    ).resolves.toBe("Stopping");
    await stoppingRuntime.terminate(stoppingResult.sessionId);
  });

  it("confirms a missing recorded process absent and releases its held slot on restart", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const now = new Date(T0).toISOString();
    db.prepare("UPDATE attempts SET status = 'Running' WHERE attempt_id = ?").run(
      prepared.attemptId,
    );
    db.prepare(
      `INSERT INTO sessions
       (session_id, attempt_id, availability, role, completion_policy, generation,
        process_pid, process_pgid, process_started_at, process_command, created_at, updated_at)
       VALUES (?, ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1,
               999999, 999999, 'Mon Jan 1 00:00:00 2001', '/missing/agent', ?, ?)`,
    ).run(prepared.plannedSessionId, prepared.attemptId, now, now);

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    expect(restarted.reconcileAfterRestart().actions).toContainEqual({
      action: "marked-lost",
      attemptId: prepared.attemptId,
      sessionId: prepared.plannedSessionId,
    });
    expect(new WorktreeStore(db).disposeLifecycleFacts("worktree-1").processDispositions).toEqual([
      expect.objectContaining({
        attemptId: prepared.attemptId,
        disposition: "ConfirmedAbsent",
      }),
    ]);
    expect(
      db.prepare("SELECT status FROM attempts WHERE attempt_id = ?").get(prepared.attemptId),
    ).toEqual({ status: "Interrupted" });
    expect(
      (
        db
          .prepare("SELECT released_at FROM slot_leases WHERE attempt_id = ?")
          .get(prepared.attemptId) as { released_at: string | null }
      ).released_at,
    ).not.toBeNull();
  });

  it("does not mistake PID reuse for the recorded Session owner", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const now = new Date(T0).toISOString();
    db.prepare("UPDATE attempts SET status = 'Running' WHERE attempt_id = ?").run(
      prepared.attemptId,
    );
    db.prepare(
      `INSERT INTO sessions
       (session_id, attempt_id, availability, role, completion_policy, generation,
        process_pid, process_pgid, process_started_at, process_command, created_at, updated_at)
       VALUES (?, ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1,
               ?, 999999, 'Mon Jan 1 00:00:00 2001', '/different/command', ?, ?)`,
    ).run(prepared.plannedSessionId, prepared.attemptId, process.pid, now, now);

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    restarted.reconcileAfterRestart();

    expect(new WorktreeStore(db).disposeLifecycleFacts("worktree-1").processDispositions).toEqual([
      expect.objectContaining({
        attemptId: prepared.attemptId,
        disposition: "ConfirmedAbsent",
      }),
    ]);
    expect(
      db.prepare("SELECT status FROM attempts WHERE attempt_id = ?").get(prepared.attemptId),
    ).toEqual({ status: "Interrupted" });
  });

  it("reopens a stale released lease when an Uncertain disposition still holds the slot", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const now = new Date(T0).toISOString();
    db.prepare("UPDATE attempts SET status = 'Uncertain' WHERE attempt_id = ?").run(
      prepared.attemptId,
    );
    db.prepare(
      `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
       VALUES (?, 'OrphanFound', ?)`,
    ).run(prepared.attemptId, now);
    db.prepare("UPDATE slot_leases SET released_at = ? WHERE attempt_id = ?").run(
      now,
      prepared.attemptId,
    );

    const restarted = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    restarted.reconcileAfterRestart();

    expect(
      db
        .prepare("SELECT released_at FROM slot_leases WHERE attempt_id = ?")
        .get(prepared.attemptId),
    ).toEqual({ released_at: null });
  });

  it.each([
    "afterBootstrapReceipt",
    "afterAuthorize",
    "afterCommitSent",
    "afterAgentObserved",
  ] as const)(
    "uses a real SIGKILL and a fresh process to reconcile %s",
    async (crashStep) => {
      const { db, root, prepared, counterPath } = await setupPreparedLaunch();
      const nativeCopy = await copyNodePtyWithHelperMode(0o755);
      nativeCopies.push(nativeCopy);
      const crashOutcomePath = join(root, `crash-${crashStep}.json`);
      const crashConfigPath = join(root, `crash-${crashStep}-config.json`);
      writeFileSync(
        crashConfigPath,
        JSON.stringify({
          mode: "crash",
          dbPath: join(root, "fleet.db"),
          storeDir: root,
          nodePtyModulePath: nativeCopy.modulePath,
          prepared,
          crashStep,
          outcomePath: crashOutcomePath,
        }),
      );

      await expect(runTestChild(crashConfigPath)).resolves.toEqual({
        code: null,
        signal: "SIGKILL",
      });
      expect(JSON.parse(readFileSync(crashOutcomePath, "utf8"))).toEqual({
        crashedAt: crashStep,
      });

      const reconcileOutcomePath = join(root, `reconcile-${crashStep}.json`);
      const reconcileConfigPath = join(root, `reconcile-${crashStep}-config.json`);
      writeFileSync(
        reconcileConfigPath,
        JSON.stringify({
          mode: "reconcile",
          dbPath: join(root, "fleet.db"),
          storeDir: root,
          nodePtyModulePath: nativeCopy.modulePath,
          prepared,
          outcomePath: reconcileOutcomePath,
        }),
      );
      await expect(runTestChild(reconcileConfigPath)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      const report = JSON.parse(readFileSync(reconcileOutcomePath, "utf8")) as {
        readonly actions: readonly { readonly action: string }[];
      };
      const expectedAction =
        crashStep === "afterBootstrapReceipt"
          ? "aborted-bootstrap-lost"
          : crashStep === "afterAuthorize"
            ? "aborted-before-commit"
            : "marked-uncertain";
      expect(report.actions.map((action) => action.action)).toContain(expectedAction);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as { count: number }).count,
      ).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM launch_intents").get() as { count: number })
          .count,
      ).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count,
      ).toBe(0);
      if (existsSync(counterPath)) {
        expect(readFileSync(counterPath, "utf8")).toBe("x");
      }

      const processRow = db
        .prepare("SELECT bootstrap_pgid FROM launch_intents WHERE launch_nonce = ?")
        .get(prepared.launchNonce) as { readonly bootstrap_pgid: number | null };
      if (processRow.bootstrap_pgid !== null && processRow.bootstrap_pgid > 1) {
        try {
          process.kill(-processRow.bootstrap_pgid, "SIGKILL");
        } catch {
          // The bootstrap/Agent already exited; the full identity probe covered that case.
        }
      }
    },
    20_000,
  );
});

describe("SessionRuntime Attachment seam (RT-LEASE-09/10)", () => {
  it("attach creates an observe-only Live Attachment without a fencing token", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const attached = runtime.attach(launched.sessionId);

      expect(attached).toMatchObject({
        mode: "Live",
        sessionId: launched.sessionId,
        generation: launched.generation,
        snapshot: {
          coversThroughSeq: 0,
        },
      });
      expect(JSON.parse(new TextDecoder().decode(attached.snapshot.bytes))).toMatchObject({
        schemaVersion: 1,
        coversThroughSeq: 0,
        producer: { kind: "InitialState", receivedPtyHandle: false },
        checkpoint: { parserGround: true, utf8DecoderEmpty: true },
      });
      expect(attached.attachmentId).toEqual(expect.any(String));
      expect(attached).not.toHaveProperty("fencingToken");
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("grants one 15-second Control Lease and rejects a second writer", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const first = runtime.attach(launched.sessionId);
      const second = runtime.attach(launched.sessionId);

      expect(runtime.acquireControl(first.attachmentId)).toEqual({
        sessionId: launched.sessionId,
        generation: launched.generation,
        attachmentId: first.attachmentId,
        fencingToken: 1,
        expiresAt: T0 + 15_000,
      });
      expect(() => runtime.acquireControl(second.attachmentId)).toThrow(
        expect.objectContaining({ code: "Conflict" }),
      );
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("renews the same token and fences the old holder after TTL expiry", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    let now = T0;
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      now: () => now,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const first = runtime.attach(launched.sessionId);
      const second = runtime.attach(launched.sessionId);
      const original = runtime.acquireControl(first.attachmentId);

      now += 5_000;
      expect(runtime.renewControl(original)).toEqual({
        ...original,
        expiresAt: T0 + 20_000,
      });

      now = T0 + 20_000;
      const replacement = runtime.acquireControl(second.attachmentId);
      expect(replacement.fencingToken).toBe(2);
      expect(() => runtime.renewControl(original)).toThrow(
        expect.objectContaining({ code: "StaleControlLease" }),
      );
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("takes over only the confirmed holder and immediately fences its token", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      confirmations: createConfirmations(db),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const first = runtime.attach(launched.sessionId);
      const second = runtime.attach(launched.sessionId);
      const original = runtime.acquireControl(first.attachmentId);
      const unknownReceipt: ConfirmationReceipt = {
        challengeId: "ch-unknown",
        confirmedAt: new Date(T0).toISOString(),
        proof: "00".repeat(32),
      };

      expect(() =>
        runtime.takeoverControl({
          attachmentId: second.attachmentId,
          confirmedHolder: original,
          confirmationReceipt: unknownReceipt,
        }),
      ).toThrow(expect.objectContaining({ code: "ConfirmationRequired" }));
      expect(runtime.renewControl(original).fencingToken).toBe(original.fencingToken);

      const challenge = runtime.issueTakeoverControlChallenge(second.attachmentId, original);
      const receipt = confirm(challenge);
      const replacement = runtime.takeoverControl({
        attachmentId: second.attachmentId,
        confirmedHolder: original,
        confirmationReceipt: receipt,
      });
      expect(replacement).toMatchObject({
        attachmentId: second.attachmentId,
        fencingToken: 2,
        expiresAt: T0 + 15_000,
      });
      expect(() => runtime.renewControl(original)).toThrow(
        expect.objectContaining({ code: "StaleControlLease" }),
      );
      expect(() =>
        runtime.takeoverControl({
          attachmentId: first.attachmentId,
          confirmedHolder: replacement,
          confirmationReceipt: receipt,
        }),
      ).toThrow(expect.objectContaining({ code: "ConfirmationRequired" }));
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("closes an Attachment on control disconnect and revokes its Lease", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const first = runtime.attach(launched.sessionId);
      const second = runtime.attach(launched.sessionId);
      const original = runtime.acquireControl(first.attachmentId);

      runtime.closeAttachment(first.attachmentId);

      expect(() => runtime.renewControl(original)).toThrow(
        expect.objectContaining({ code: "StaleControlLease" }),
      );
      expect(runtime.acquireControl(second.attachmentId).fencingToken).toBe(2);
      expect(() => runtime.acquireControl(first.attachmentId)).toThrow(
        expect.objectContaining({ code: "CapabilityUnavailable" }),
      );
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("reprojects the same Active Attachment to Restored when its Session exits", async () => {
    const { db, root, prepared } = await setupPreparedLaunch({ keepAlive: false });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);
    const attached = runtime.attach(launched.sessionId);
    const lease = runtime.acquireControl(attached.attachmentId);

    await waitFor(() => runtime.inspectSession(launched.sessionId)?.availability === "Exited");

    expect(runtime.inspectAttachment(attached.attachmentId)).toEqual({
      attachmentId: attached.attachmentId,
      sessionId: launched.sessionId,
      generation: launched.generation,
      status: "Active",
      mode: "Restored",
    });
    expect(() => runtime.renewControl(lease)).toThrow(
      expect.objectContaining({ code: "StaleControlLease" }),
    );
    expect(() => runtime.acquireControl(attached.attachmentId)).toThrow(
      expect.objectContaining({ code: "CapabilityUnavailable" }),
    );
  });

  it("durably dispatches input once through the current Control Lease", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const attached = runtime.attach(launched.sessionId);
      const lease = runtime.acquireControl(attached.attachmentId);
      const bytes = new Uint8Array([0x68, 0x69, 0x0d, 0x00]);
      const command = {
        commandId: "input-command-1",
        lease,
        source: "Paste" as const,
        bytes,
      };

      const first = await runtime.writeSessionInput(command);
      const replay = await runtime.writeSessionInput(command);

      expect(first).toMatchObject({
        commandId: command.commandId,
        sessionId: launched.sessionId,
        generation: launched.generation,
        attachmentId: attached.attachmentId,
        fencingToken: lease.fencingToken,
        source: "Paste",
        byteLength: bytes.byteLength,
        status: "Dispatched",
      });
      expect(replay).toEqual(first);
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("returns the original Dispatched input after Control Lease takeover", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      confirmations: createConfirmations(db),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const firstAttachment = runtime.attach(launched.sessionId);
      const secondAttachment = runtime.attach(launched.sessionId);
      const firstLease = runtime.acquireControl(firstAttachment.attachmentId);
      const bytes = new Uint8Array([0x72, 0x65, 0x74, 0x72, 0x79]);
      const original = await runtime.writeSessionInput({
        commandId: "input-across-takeover",
        lease: firstLease,
        source: "Automation",
        bytes,
      });

      const challenge = runtime.issueTakeoverControlChallenge(
        secondAttachment.attachmentId,
        firstLease,
      );
      const secondLease = runtime.takeoverControl({
        attachmentId: secondAttachment.attachmentId,
        confirmedHolder: firstLease,
        confirmationReceipt: confirm(challenge),
      });

      await expect(
        runtime.writeSessionInput({
          commandId: "input-across-takeover",
          lease: secondLease,
          source: "Automation",
          bytes,
        }),
      ).resolves.toEqual(original);
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("rejects input, resize, and terminate through an old fencing token", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      confirmations: createConfirmations(db),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const first = runtime.attach(launched.sessionId);
      const second = runtime.attach(launched.sessionId);
      const oldLease = runtime.acquireControl(first.attachmentId);
      const terminateChallenge = runtime.issueTerminateSessionChallenge(oldLease);
      const challenge = runtime.issueTakeoverControlChallenge(second.attachmentId, oldLease);
      runtime.takeoverControl({
        attachmentId: second.attachmentId,
        confirmedHolder: oldLease,
        confirmationReceipt: confirm(challenge),
      });

      await expect(
        runtime.writeSessionInput({
          commandId: "stale-input",
          lease: oldLease,
          source: "Automation",
          bytes: new Uint8Array([0x78]),
        }),
      ).rejects.toMatchObject({ code: "StaleControlLease" });
      await expect(
        runtime.resizeSession({ lease: oldLease, cols: 120, rows: 40 }),
      ).rejects.toMatchObject({ code: "StaleControlLease" });
      await expect(
        runtime.terminateSession({
          lease: oldLease,
          confirmationReceipt: confirm(terminateChallenge),
        }),
      ).rejects.toMatchObject({ code: "ConfirmationRequired" });
      expect(runtime.inspectSession(launched.sessionId)?.availability).toBe("Alive");
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("requires a one-time destructive confirmation before terminating a Session", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      confirmations: createConfirmations(db),
      now: () => T0,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const attached = runtime.attach(launched.sessionId);
      const lease = runtime.acquireControl(attached.attachmentId);
      const unknownReceipt: ConfirmationReceipt = {
        challengeId: "ch-unknown",
        confirmedAt: new Date(T0).toISOString(),
        proof: "00".repeat(32),
      };

      await expect(
        runtime.terminateSession({ lease, confirmationReceipt: unknownReceipt }),
      ).rejects.toMatchObject({ code: "ConfirmationRequired" });
      expect(runtime.inspectSession(launched.sessionId)?.availability).toBe("Alive");

      const challenge = runtime.issueTerminateSessionChallenge(lease);
      await runtime.terminateSession({ lease, confirmationReceipt: confirm(challenge) });
      await waitFor(() => runtime.inspectSession(launched.sessionId)?.availability === "Exited");
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("reads durable delta from the Attachment Snapshot cursor without changing identity", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const attached = runtime.attach(launched.sessionId);
      await waitFor(
        () =>
          runtime.readDurableFrame({
            sessionId: launched.sessionId,
            generation: launched.generation,
            seq: 1,
          }) !== null,
      );

      const delta = runtime.readSessionDelta(
        attached.attachmentId,
        attached.snapshot.coversThroughSeq + 1,
      );

      expect(delta).toEqual({
        attachmentId: attached.attachmentId,
        sessionId: launched.sessionId,
        generation: launched.generation,
        durableThroughSeq: 1,
        nextSeq: 2,
        frames: [
          {
            header: {
              frameType: "PtyOutput",
              sessionId: launched.sessionId,
              generation: launched.generation,
              seq: 1,
              payloadLength: 3,
            },
            bytes: new Uint8Array([0x41, 0xff, 0x42]),
          },
        ],
      });
      expect(runtime.inspectAttachment(attached.attachmentId)?.status).toBe("Active");
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("attaches from a durable parser-safe Snapshot and only requests later delta", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      await waitFor(
        () =>
          runtime.readDurableFrame({
            sessionId: launched.sessionId,
            generation: launched.generation,
            seq: 1,
          }) !== null,
      );
      const created = await runtime.createSessionSnapshot(launched.sessionId);
      const document = JSON.parse(new TextDecoder().decode(created.bytes)) as {
        readonly schemaVersion: number;
        readonly terminalPackageSet: Readonly<Record<string, string>>;
        readonly producer: {
          readonly kind: string;
          readonly threadId: number;
          readonly receivedPtyHandle: boolean;
        };
        readonly checkpoint: {
          readonly parserGround: boolean;
          readonly utf8DecoderEmpty: boolean;
        };
      };
      const attached = runtime.attach(launched.sessionId);

      expect(created.coversThroughSeq).toBe(1);
      expect(document).toMatchObject({
        schemaVersion: 1,
        terminalPackageSet: { "@xterm/headless": "6.0.0" },
        producer: {
          kind: "SnapshotWorker",
          threadId: expect.any(Number),
          receivedPtyHandle: false,
        },
        checkpoint: { parserGround: true, utf8DecoderEmpty: true },
      });
      expect(document.producer.threadId).toBeGreaterThan(0);
      expect(attached.snapshot).toEqual(created);
      expect(runtime.readSessionDelta(attached.attachmentId, 2).frames).toEqual([]);
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("advances Worker Snapshots only at UTF-8, CSI, OSC, and DCS safe byte boundaries", {
    timeout: 30_000,
  }, async () => {
    const { db, root, prepared } = await setupPreparedLaunch({ outputBytes: [] });
    const controlled = await createControllableProcessSupervisor();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: controlled.processSupervisor,
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    // A | 人 | CSI 2;3H | OSC title BEL | DCS zhi ST.
    // These literals are the independently reviewed safe prefix lengths.
    const fixture = Uint8Array.from([
      0x41, 0xe4, 0xba, 0xba, 0x1b, 0x5b, 0x32, 0x3b, 0x33, 0x48, 0x1b, 0x5d, 0x30, 0x3b, 0x48,
      0x69, 0x07, 0x1b, 0x50, 0x7a, 0x68, 0x69, 0x1b, 0x5c,
    ]);
    const safePrefixes = new Set([1, 4, 10, 17, 24]);
    let lastSafePrefix = 0;

    try {
      for (const [index, byte] of fixture.entries()) {
        const seq = index + 1;
        controlled.emitOutput(Uint8Array.of(byte));
        await waitFor(
          () =>
            runtime.readDurableFrame({
              sessionId: launched.sessionId,
              generation: launched.generation,
              seq,
            }) !== null,
        );
        if (safePrefixes.has(seq)) lastSafePrefix = seq;

        const snapshot = await runtime.createSessionSnapshot(launched.sessionId);
        expect(snapshot.coversThroughSeq).toBe(lastSafePrefix);
      }
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("falls back to initial Snapshot plus durable delta for corrupt or incompatible cache", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      await waitFor(
        () =>
          runtime.readDurableFrame({
            sessionId: launched.sessionId,
            generation: launched.generation,
            seq: 1,
          }) !== null,
      );
      await runtime.createSessionSnapshot(launched.sessionId);
      const snapshotPath = join(
        root,
        "snapshots",
        launched.sessionId,
        String(launched.generation),
        "snapshot-1.json",
      );

      writeFileSync(snapshotPath, "corrupt");
      expect(runtime.readSessionSnapshot(launched.sessionId).coversThroughSeq).toBe(0);

      await runtime.createSessionSnapshot(launched.sessionId);
      db.prepare(
        "UPDATE session_snapshots SET schema_version = 999 WHERE session_id = ? AND generation = ?",
      ).run(launched.sessionId, launched.generation);
      expect(runtime.readSessionSnapshot(launched.sessionId).coversThroughSeq).toBe(0);

      await runtime.createSessionSnapshot(launched.sessionId);
      db.prepare(
        "UPDATE session_snapshots SET package_set_json = '{}' WHERE session_id = ? AND generation = ?",
      ).run(launched.sessionId, launched.generation);
      const attached = runtime.attach(launched.sessionId);
      expect(attached.snapshot.coversThroughSeq).toBe(0);
      expect(runtime.readSessionDelta(attached.attachmentId, 1).frames).toEqual([
        expect.objectContaining({
          header: expect.objectContaining({ seq: 1 }),
          bytes: new Uint8Array([0x41, 0xff, 0x42]),
        }),
      ]);
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });

  it("creates a final Snapshot after exit without any Active Attachment", async () => {
    const { db, root, prepared } = await setupPreparedLaunch({ keepAlive: false });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    await waitFor(() => runtime.inspectSession(launched.sessionId)?.availability === "Exited");
    await waitFor(() => runtime.readSessionSnapshot(launched.sessionId).coversThroughSeq === 1);

    const attached = runtime.attach(launched.sessionId);
    expect(attached.mode).toBe("Restored");
    expect(attached.snapshot.coversThroughSeq).toBe(1);
  });

  it("serves a 10,000-line final Snapshot within the daemon-side restore budget", {
    timeout: 30_000,
  }, async () => {
    const output = new TextEncoder().encode("x\n".repeat(10_000));
    const { db, root, prepared } = await setupPreparedLaunch({
      keepAlive: false,
      outputBytes: [...output],
    });
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    await waitFor(
      () => runtime.inspectSession(launched.sessionId)?.availability === "Exited",
      5_000,
    );
    await waitFor(() => runtime.readSessionSnapshot(launched.sessionId).coversThroughSeq > 0);

    const samples: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) {
      const started = performance.now();
      const attached = runtime.attach(launched.sessionId);
      samples.push(performance.now() - started);
      expect(attached.mode).toBe("Restored");
      expect(attached.snapshot.coversThroughSeq).toBeGreaterThan(0);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThan(FROZEN_PERFORMANCE_BUDGET.sessionRestoreMs.p95);
  });

  it("reconciles Prepared input as Uncertain after the PTY-write boundary", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const original = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
      onInputStep: (step: string) => {
        if (step === "afterPtyWrite") throw new Error("injected daemon boundary failure");
      },
    });
    const launched = await original.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);
    try {
      const attached = original.attach(launched.sessionId);
      const lease = original.acquireControl(attached.attachmentId);

      await expect(
        original.writeSessionInput({
          commandId: "uncertain-input",
          lease,
          source: "Automation",
          bytes: new Uint8Array([0x79, 0x0d]),
        }),
      ).rejects.toThrow("injected daemon boundary failure");

      const restarted = new SessionRuntime({
        db,
        storeDir: root,
        processSupervisor: await createRealProcessSupervisor(),
      });
      restarted.reconcileAfterRestart();

      expect(restarted.inspectInputIntent("uncertain-input")).toMatchObject({
        commandId: "uncertain-input",
        status: "Uncertain",
      });
      await expect(
        restarted.writeSessionInput({
          commandId: "uncertain-input",
          lease,
          source: "Automation",
          bytes: new Uint8Array([0x79, 0x0d]),
        }),
      ).resolves.toMatchObject({
        commandId: "uncertain-input",
        status: "Uncertain",
      });
    } finally {
      await original.terminate(launched.sessionId);
    }
  });

  it("invalidates an Attachment and immediately revokes its Control Lease", async () => {
    const { db, root, prepared } = await setupPreparedLaunch();
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: await createRealProcessSupervisor(),
    });
    const launched = await runtime.launch(prepared, { revalidate: async () => true });
    if (launched.kind !== "running") throw new Error(`launch failed: ${launched.kind}`);

    try {
      const attached = runtime.attach(launched.sessionId);
      const lease = runtime.acquireControl(attached.attachmentId);

      runtime.invalidateAttachment(attached.attachmentId);

      expect(runtime.inspectAttachment(attached.attachmentId)?.status).toBe("Invalidated");
      expect(() => runtime.renewControl(lease)).toThrow(
        expect.objectContaining({ code: "StaleControlLease" }),
      );
    } finally {
      await runtime.terminate(launched.sessionId);
    }
  });
});
