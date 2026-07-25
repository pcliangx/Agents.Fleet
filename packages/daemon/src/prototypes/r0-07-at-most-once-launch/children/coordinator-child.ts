// R0-07 — coordinator child runner. Spawned by the crash harness (or the
// evidence driver) under tsx; it plays the Daemon and gets SIGKILLed at the
// armed crash point (RT-T-11). Config in, outcome JSON out — no stdout protocol.

import { readFileSync, writeFileSync } from "node:fs";
import { type CrashPoint, type LaunchCommand, LaunchCoordinator } from "../coordinator.js";
import { scenarioPaths } from "../paths.js";
import { openLifecycleDb } from "../schema.js";

interface CoordinatorChildConfig {
  readonly workDir: string;
  readonly command: LaunchCommand;
  readonly crashPoint: CrashPoint | null;
  /** When true, the child rewrites facts.json right before revalidation. */
  readonly driftBeforeRevalidation: boolean;
  readonly bootstrapPath: string;
  readonly agentPath: string;
}

const main = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: coordinator-child <config.json>");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as CoordinatorChildConfig;
  const paths = scenarioPaths(config.workDir);
  const db = openLifecycleDb(paths.dbPath);

  const coordinator = new LaunchCoordinator({
    db,
    workDir: config.workDir,
    bootstrapPath: config.bootstrapPath,
    agentPath: config.agentPath,
    crashPoint: config.crashPoint,
    onCrashPoint: (point) => {
      // Leave a marker, then die like a real Daemon crash — mid-protocol,
      // with WAL committed exactly up to the last finished transaction.
      writeFileSync(`${config.workDir}/crashed-at-${point}`, new Date().toISOString());
      process.kill(process.pid, "SIGKILL");
    },
    ...(config.driftBeforeRevalidation
      ? {
          beforeRevalidation: () => {
            // RT-CMD-16: an external process rewrote the Worktree facts after
            // the last observation — the final revalidation must catch it.
            writeFileSync(paths.factsPath, JSON.stringify({ drifted: true }));
          },
        }
      : {}),
  });

  try {
    const result = await coordinator.launch(config.command);
    writeFileSync(paths.coordinatorOutcomePath, JSON.stringify({ ok: true, result }));
  } catch (err) {
    writeFileSync(
      paths.coordinatorOutcomePath,
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
};

await main();
