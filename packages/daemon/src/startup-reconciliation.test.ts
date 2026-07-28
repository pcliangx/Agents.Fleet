// R1-09 / RT-LAUNCH-05 / RT-T-11 — startup Reconciliation may continue only
// the same Prepared nonce whose bootstrap has not produced side effects.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LaunchSpec, PreparedLaunch } from "@agents-fleet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "./crypto/canonical-hash.js";
import {
  copyNodePtyWithHelperMode,
  type TempNodePtyCopy,
} from "./native-artifact/temp-node-pty-copy.js";
import {
  createProcessSupervisor,
  type PtyDriver,
  type PtyDriverProcess,
} from "./session-runtime/process-supervisor.js";
import { SessionRuntime } from "./session-runtime/session-runtime.js";
import { runStartupReconciliation } from "./startup-reconciliation.js";
import { openDatabase } from "./storage/database.js";
import { ALL_MIGRATIONS } from "./storage/migrations.js";
import { TaskStore } from "./storage/task-store.js";

const tempDirs: string[] = [];
const databases: DatabaseSync[] = [];
const nativeCopies: TempNodePtyCopy[] = [];

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

const setupPreparedLaunch = (): {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly markerPath: string;
  readonly prepared: PreparedLaunch;
} => {
  const root = mkdtempSync(join(tmpdir(), "af-r109-prepared-"));
  tempDirs.push(root);
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir);
  const opened = openDatabase({ path: join(root, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(`database not ready: ${opened.reason}`);
  databases.push(opened.db);
  const tasks = new TaskStore(opened.db);
  const task = tasks.createTask({
    workspaceId: "ws_prepared",
    spec: { goal: "continue the same side-effect-free launch nonce" },
  });
  tasks.startTask(task.taskId);
  const attempt = tasks.listAttempts(task.taskId)[0];
  if (attempt === undefined) throw new Error("started Task has no Attempt");

  const markerPath = join(root, "agent-start-count");
  const script = [
    'const fs = require("node:fs");',
    "fs.appendFileSync(process.argv[1], 'x');",
    "setInterval(() => {}, 1000);",
  ].join("");
  const launchSpec: LaunchSpec = {
    executablePath: process.execPath,
    argv: ["-e", script, markerPath],
    cwd: root,
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
  const prepared: PreparedLaunch = {
    kind: "prepared",
    attemptId: attempt.attemptId,
    taskId: task.taskId,
    commandId: "cmd_prepared",
    agentId: "claude-code",
    slotLeaseId: "sl_prepared",
    launchNonce: "ln_prepared",
    plannedSessionId: "se_prepared",
    launchSpec,
  };
  const now = new Date().toISOString();
  opened.db
    .prepare("UPDATE attempts SET status = 'Starting' WHERE attempt_id = ?")
    .run(attempt.attemptId);
  opened.db
    .prepare(
      `INSERT INTO slot_leases
       (slot_lease_id, attempt_id, host_id, agent_id, acquired_at)
       VALUES (?, ?, 'local', ?, ?)`,
    )
    .run(prepared.slotLeaseId, prepared.attemptId, prepared.agentId, now);
  opened.db
    .prepare(
      `INSERT INTO launch_intents
       (launch_nonce, attempt_id, command_id, slot_lease_id, planned_session_id,
        agent_id, argv_hash, launch_spec_json, launch_spec_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Prepared', ?, ?)`,
    )
    .run(
      prepared.launchNonce,
      prepared.attemptId,
      prepared.commandId,
      prepared.slotLeaseId,
      prepared.plannedSessionId,
      prepared.agentId,
      canonicalSha256(launchSpec.argv),
      JSON.stringify(launchSpec),
      canonicalSha256(launchSpec),
      now,
      now,
    );
  return { db: opened.db, root: runtimeDir, markerPath, prepared };
};

describe("runStartupReconciliation", () => {
  it("revalidates and continues the same Prepared nonce exactly once", async () => {
    const { db, root, markerPath, prepared } = setupPreparedLaunch();
    const nativeCopy = await copyNodePtyWithHelperMode(0o755);
    nativeCopies.push(nativeCopy);
    const driver: PtyDriver = {
      spawn(executablePath, args, options): PtyDriverProcess {
        const process = nativeCopy.nodePty.spawn(executablePath, [...args], {
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
    const runtime = new SessionRuntime({
      db,
      storeDir: root,
      processSupervisor: createProcessSupervisor(driver),
    });

    try {
      const report = await runStartupReconciliation({
        sessions: runtime,
        revalidateAcceptedAttempt: async (attemptId) => attemptId === prepared.attemptId,
      });

      expect(report.reconciliation.actions).toEqual([
        {
          action: "resume-prepared",
          attemptId: prepared.attemptId,
          launchNonce: prepared.launchNonce,
          preparedLaunch: prepared,
        },
      ]);
      expect(report.resumedLaunches).toEqual([
        {
          action: "resumed-prepared",
          attemptId: prepared.attemptId,
          launchNonce: prepared.launchNonce,
          result: {
            kind: "running",
            attemptId: prepared.attemptId,
            sessionId: prepared.plannedSessionId,
            generation: 1,
          },
        },
      ]);
      await waitFor(() => existsSync(markerPath));
      expect(readFileSync(markerPath, "utf8")).toBe("x");
    } finally {
      await runtime.terminate(prepared.plannedSessionId);
    }
  });
});
