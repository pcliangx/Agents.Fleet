// RT-T-11 test child: runs the real R1 SessionRuntime in a separate Daemon
// process, self-SIGKILLs at an armed launch boundary, or performs restart
// Reconciliation from a second fresh process.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PreparedLaunch } from "@agents-fleet/contracts";
import type { NativePtyModule } from "../../native-artifact/temp-node-pty-copy.js";
import { openDatabase } from "../../storage/database.js";
import { ALL_MIGRATIONS } from "../../storage/migrations.js";
import {
  createProcessSupervisor,
  type PtyDriver,
  type PtyDriverProcess,
} from "../process-supervisor.js";
import { SessionRuntime } from "../session-runtime.js";

type CrashStep =
  | "afterBootstrapReceipt"
  | "afterAuthorize"
  | "afterCommitSent"
  | "afterAgentObserved";

interface ChildConfig {
  readonly mode: "crash" | "reconcile";
  readonly dbPath: string;
  readonly storeDir: string;
  readonly nodePtyModulePath: string;
  readonly prepared: PreparedLaunch;
  readonly crashStep?: CrashStep;
  readonly outcomePath: string;
}

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("usage: runtime-crash-child <config.json>");
const config = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;
const opened = openDatabase({ path: config.dbPath, migrations: ALL_MIGRATIONS });
if (opened.kind !== "ready") throw new Error(`database not ready: ${opened.reason}`);

const require = createRequire(import.meta.url);
const nodePty = require(config.nodePtyModulePath) as NativePtyModule;
const driver: PtyDriver = {
  spawn(executablePath, args, options): PtyDriverProcess {
    const child = nodePty.spawn(executablePath, [...args], {
      ...options,
      env: { ...options.env },
    });
    return {
      pid: child.pid,
      write: (data) => child.write(Buffer.from(data)),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill(),
      onData: (listener) => child.onData((data) => listener(data as Uint8Array)),
      onExit: (listener) =>
        child.onExit((event) => listener({ exitCode: event.exitCode, signal: event.signal ?? 0 })),
    };
  },
};
const runtime = new SessionRuntime({
  db: opened.db,
  storeDir: config.storeDir,
  processSupervisor: createProcessSupervisor(driver),
  onLaunchStep: (step) => {
    if (config.mode !== "crash" || step !== config.crashStep) return;
    writeFileSync(config.outcomePath, JSON.stringify({ crashedAt: step }));
    process.kill(process.pid, "SIGKILL");
  },
});

if (config.mode === "crash") {
  const result = await runtime.launch(config.prepared, { revalidate: async () => true });
  writeFileSync(config.outcomePath, JSON.stringify({ completed: result }));
} else {
  const report = runtime.reconcileAfterRestart();
  writeFileSync(config.outcomePath, JSON.stringify(report));
}
opened.db.close();
