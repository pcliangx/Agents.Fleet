// R1-09 / RT-REC-07..08 / RT-T-08..09 — the production Daemon entrypoint
// must reconcile persisted lifecycle facts before advertising readiness.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FleetProjection } from "../fleet-projection/fleet-projection.js";
import { resolveTsxLoader } from "../prototypes/r0-07-at-most-once-launch/driver.js";
import { openDatabase } from "../storage/database.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { TaskStore } from "../storage/task-store.js";

const DAEMON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (isRunning(child)) child.kill("SIGKILL");
};

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const startDaemon = async (input: {
  readonly dbPath: string;
  readonly socketDir: string;
  readonly tokenPath: string;
}): Promise<ChildProcess> => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolveTsxLoader(),
      DAEMON_ENTRY,
      "--socket-dir",
      input.socketDir,
      "--db-path",
      input.dbPath,
    ],
    {
      env: { ...process.env, AGENTS_FLEET_DEV_TOKEN: input.tokenPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);

  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Daemon readiness timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    const finish = (outcome: () => void): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      outcome();
    };
    const onStdout = (bytes: Buffer): void => {
      stdout += String(bytes);
      if (stdout.includes("<daemon ready ")) finish(resolve);
    };
    const onStderr = (bytes: Buffer): void => {
      stderr += String(bytes);
    };
    const onError = (error: Error): void => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() =>
        reject(new Error(`Daemon exited before readiness (${code ?? signal})\nstderr: ${stderr}`)),
      );
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
  return child;
};

const seedAliveSession = (processIdentity: {
  readonly pid: number;
  readonly pgid: number;
  readonly lstart: string;
  readonly command: string;
}): {
  readonly root: string;
  readonly dbPath: string;
  readonly tokenPath: string;
  readonly taskId: string;
  readonly attemptId: string;
} => {
  const root = mkdtempSync(join(tmpdir(), "af-r109-startup-"));
  tempDirs.push(root);
  const dbPath = join(root, "fleet.db");
  const tokenPath = join(root, "dev-token");
  writeFileSync(tokenPath, "r1-09-startup-reconciliation");
  chmodSync(tokenPath, 0o600);

  const opened = openDatabase({ path: dbPath, migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(`database not ready: ${opened.reason}`);
  const tasks = new TaskStore(opened.db);
  const task = tasks.createTask({
    workspaceId: "ws_restart",
    spec: { goal: "survive a restart without inventing process continuity" },
  });
  tasks.startTask(task.taskId);
  const attempt = tasks.listAttempts(task.taskId)[0];
  if (attempt === undefined) throw new Error("started Task has no Attempt");
  const now = new Date().toISOString();
  opened.db
    .prepare("UPDATE attempts SET status = 'Running' WHERE attempt_id = ?")
    .run(attempt.attemptId);
  opened.db
    .prepare(
      `INSERT INTO slot_leases
       (slot_lease_id, attempt_id, host_id, agent_id, acquired_at)
       VALUES ('sl_restart', ?, 'local', 'claude-code', ?)`,
    )
    .run(attempt.attemptId, now);
  opened.db
    .prepare(
      `INSERT INTO sessions
       (session_id, attempt_id, availability, role, completion_policy, generation,
        process_pid, process_pgid, process_started_at, process_command, created_at, updated_at)
       VALUES ('se_restart', ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1,
               ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attempt.attemptId,
      processIdentity.pid,
      processIdentity.pgid,
      processIdentity.lstart,
      processIdentity.command,
      now,
      now,
    );
  opened.db.close();
  return {
    root,
    dbPath,
    tokenPath,
    taskId: task.taskId,
    attemptId: attempt.attemptId,
  };
};

const currentProcessIdentity = (): {
  readonly pid: number;
  readonly pgid: number;
  readonly lstart: string;
  readonly command: string;
} => {
  const observed = spawnSync(
    "/bin/ps",
    ["-o", "pid=,pgid=,lstart=,command=", "-p", String(process.pid)],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1_000,
    },
  );
  if (observed.status !== 0) throw new Error(`could not observe test process: ${observed.stderr}`);
  const tokens = observed.stdout.trim().split(/\s+/);
  const pid = Number(tokens[0]);
  const pgid = Number(tokens[1]);
  const lstart = tokens.slice(2, 7).join(" ");
  const command = tokens.slice(7).join(" ");
  if (
    pid !== process.pid ||
    !Number.isInteger(pgid) ||
    lstart.length === 0 ||
    command.length === 0
  ) {
    throw new Error("test process identity was incomplete");
  }
  return { pid, pgid, lstart, command };
};

describe("production Daemon startup Reconciliation", () => {
  it("publishes readiness only after a missing pre-restart process becomes Interrupted", async () => {
    const fixture = seedAliveSession({
      pid: 99_999_999,
      pgid: 99_999_999,
      lstart: "Mon Jan 1 00:00:00 2001",
      command: "/missing/agent",
    });

    const daemon = await startDaemon({
      dbPath: fixture.dbPath,
      socketDir: join(fixture.root, "run"),
      tokenPath: fixture.tokenPath,
    });
    await stopChild(daemon);

    const restarted = openDatabase({ path: fixture.dbPath, migrations: ALL_MIGRATIONS });
    if (restarted.kind !== "ready") {
      throw new Error(`database not ready after Daemon restart: ${restarted.reason}`);
    }
    try {
      const projection = new FleetProjection(restarted.db).projectTask(fixture.taskId);
      expect(projection).toMatchObject({
        taskView: {
          status: { value: "Interrupted" },
          currentAttemptStatus: { value: null },
          lastAttemptStatus: { value: "Interrupted" },
          terminalReason: { value: "process-confirmed-absent" },
        },
        needsUserAction: { value: true },
        lastAttempt: {
          attemptId: fixture.attemptId,
          status: "Interrupted",
          sessionId: "se_restart",
        },
      });
      expect(
        restarted.db
          .prepare("SELECT availability FROM sessions WHERE session_id = 'se_restart'")
          .get(),
      ).toEqual({ availability: "Lost" });
      expect(
        restarted.db
          .prepare("SELECT disposition FROM process_dispositions WHERE attempt_id = ?")
          .get(fixture.attemptId),
      ).toEqual({ disposition: "ConfirmedAbsent" });
      expect(
        restarted.db
          .prepare("SELECT released_at FROM slot_leases WHERE attempt_id = ?")
          .get(fixture.attemptId),
      ).toEqual({ released_at: expect.any(String) });
    } finally {
      restarted.db.close();
    }
  });

  it("keeps a full-identity orphan Uncertain without spawning a replacement", async () => {
    const identity = currentProcessIdentity();
    const fixture = seedAliveSession(identity);

    const daemon = await startDaemon({
      dbPath: fixture.dbPath,
      socketDir: join(fixture.root, "run"),
      tokenPath: fixture.tokenPath,
    });
    await stopChild(daemon);

    const restarted = openDatabase({ path: fixture.dbPath, migrations: ALL_MIGRATIONS });
    if (restarted.kind !== "ready") {
      throw new Error(`database not ready after Daemon restart: ${restarted.reason}`);
    }
    try {
      const projection = new FleetProjection(restarted.db).projectTask(fixture.taskId);
      expect(projection).toMatchObject({
        taskView: {
          status: { value: "Uncertain" },
          currentAttemptStatus: { value: null },
          lastAttemptStatus: { value: "Uncertain" },
          terminalReason: { value: "orphan-process-identity-matched" },
        },
        needsUserAction: { value: true },
        lastAttempt: {
          attemptId: fixture.attemptId,
          status: "Uncertain",
          sessionId: "se_restart",
        },
      });
      expect(
        restarted.db
          .prepare("SELECT disposition FROM process_dispositions WHERE attempt_id = ?")
          .get(fixture.attemptId),
      ).toEqual({ disposition: "OrphanFound" });
      expect(
        restarted.db
          .prepare("SELECT released_at FROM slot_leases WHERE attempt_id = ?")
          .get(fixture.attemptId),
      ).toEqual({ released_at: null });
      expect(
        restarted.db
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE attempt_id = ?")
          .get(fixture.attemptId),
      ).toEqual({ count: 1 });
      expect(() => process.kill(identity.pid, 0)).not.toThrow();
    } finally {
      restarted.db.close();
    }
  });
});
