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
import type { LaunchSpec, PreparedLaunch } from "@agents-fleet/contracts";
import { afterEach, describe, expect, it } from "vitest";
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

const createRealProcessSupervisor = async (): Promise<ProcessSupervisor> => {
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
        onData: (listener) => process.onData((data) => listener(data as Uint8Array)),
        onExit: (listener) =>
          process.onExit((event) =>
            listener({ exitCode: event.exitCode, signal: event.signal ?? 0 }),
          ),
      };
    },
  };
  return createProcessSupervisor(driver);
};

const setupPreparedLaunch = async (
  options: {
    readonly keepAlive?: boolean;
    readonly missingExecutable?: boolean;
    readonly wrapperExecutable?: boolean;
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
    "process.stdout.write(Buffer.from([0x41, 0xff, 0x42]));",
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
