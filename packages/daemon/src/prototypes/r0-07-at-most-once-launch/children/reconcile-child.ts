// R0-07 — reconcile child runner. A NEW process (= restarted Daemon) that
// runs Reconciliation over the durable state the crashed coordinator left,
// then proves RT-CMD-02 / RT-LAUNCH-05 convergence: reissuing the original
// commandId returns the original result; a failed (non-Uncertain) launch can
// be explicitly retried with a new commandId to exactly one Agent.

import { readFileSync, writeFileSync } from "node:fs";
import {
  type LaunchCommand,
  LaunchCoordinator,
  type LaunchResult,
  LaunchRuntime,
} from "../coordinator.js";
import { scenarioPaths } from "../paths.js";
import { type ReconcileReport, reconcile } from "../reconcile.js";
import { type DbDump, dumpDb, openLifecycleDb } from "../schema.js";

interface ReconcileChildConfig {
  readonly workDir: string;
  readonly bootstrapPath: string;
  readonly agentPath: string;
  /** Original command — reissued verbatim to prove idempotent convergence. */
  readonly reissueCommand: LaunchCommand;
  /** Explicit user retry with a NEW commandId, only when the original failed. */
  readonly retryCommand: LaunchCommand | null;
}

interface ReconcileOutcome {
  readonly report: ReconcileReport;
  readonly reissueResult: LaunchResult | null;
  readonly retryResult: LaunchResult | null;
  readonly dbDump: DbDump;
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: reconcile-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ReconcileChildConfig;
  const paths = scenarioPaths(config.workDir);
  const db = openLifecycleDb(paths.dbPath);

  try {
    const rt = new LaunchRuntime({
      db,
      workDir: config.workDir,
      bootstrapPath: config.bootstrapPath,
      agentPath: config.agentPath,
    });
    const report = await reconcile({ rt });

    const coordinator = new LaunchCoordinator({
      db,
      workDir: config.workDir,
      bootstrapPath: config.bootstrapPath,
      agentPath: config.agentPath,
    });
    const reissueResult = coordinator.reissue(config.reissueCommand);

    let retryResult: LaunchResult | null = null;
    const originalFailed = reissueResult !== null && reissueResult.status === "Failed";
    if (config.retryCommand !== null && originalFailed) {
      // RT-CMD-16: the user explicitly retries a Failed launch with a new
      // commandId (and, in the real product, a fresh receipt).
      retryResult = await coordinator.launch(config.retryCommand);
    }

    const outcome: ReconcileOutcome = { report, reissueResult, retryResult, dbDump: dumpDb(db) };
    writeFileSync(paths.reconcileOutcomePath, JSON.stringify(outcome, null, 2));
  } finally {
    db.close();
  }
};

await main();
