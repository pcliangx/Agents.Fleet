// R0-07 — evidence CLI. Runs the full RT-T-11 crash matrix (start / retry /
// resume × every §8.1 boundary + the CommitLaunch-delivery-unknown variant)
// and writes sanitized machine-readable evidence to docs/probes/r0-07/.
//
// Usage:
//   pnpm prototype:r0-07                                    # full matrix → evidence JSON
//   tsx evidence.ts --only start:afterCommitSent --keep     # single scenario, keep dir

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandKind, CRASH_POINTS, type CrashPoint } from "./coordinator.js";
import { allChecksPass, runScenario, type ScenarioEvidence } from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(here, "..", "..", "..", "..", "..", "docs", "probes", "r0-07");
const KINDS: readonly CommandKind[] = ["start", "retry", "resume"];

interface MatrixEntry {
  readonly kind: CommandKind;
  readonly crashPoint: CrashPoint | null;
  readonly killAgentBeforeReconcile: boolean;
}

const fullMatrix = (): MatrixEntry[] => {
  const entries: MatrixEntry[] = [];
  for (const kind of KINDS) {
    entries.push({ kind, crashPoint: null, killAgentBeforeReconcile: false });
    for (const crashPoint of CRASH_POINTS) {
      entries.push({ kind, crashPoint, killAgentBeforeReconcile: false });
    }
    // RT-LAUNCH-08 tail: CommitLaunch delivery unknown → Uncertain, never Aborted.
    entries.push({ kind, crashPoint: "afterCommitSent", killAgentBeforeReconcile: true });
  }
  return entries;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const keep = args.includes("--keep");

  let matrix = fullMatrix();
  if (onlyIdx >= 0) {
    const onlyArg = args[onlyIdx + 1];
    if (!onlyArg) throw new Error("usage: --only <kind>:<crashPoint|null>");
    const [kind, point] = onlyArg.split(":");
    matrix = matrix.filter(
      (e) =>
        e.kind === kind &&
        (point === "null" ? e.crashPoint === null : e.crashPoint === point) &&
        !e.killAgentBeforeReconcile,
    );
    if (point === "afterCommitSent+killAgent") {
      matrix = [
        {
          kind: kind as CommandKind,
          crashPoint: "afterCommitSent",
          killAgentBeforeReconcile: true,
        },
      ];
    }
  }

  const scenarios: ScenarioEvidence[] = [];
  for (const entry of matrix) {
    const label = `${entry.kind}:${entry.crashPoint ?? "baseline"}${entry.killAgentBeforeReconcile ? "+killAgent" : ""}`;
    process.stdout.write(`scenario ${label} ... `);
    const evidence = await runScenario(entry, keep);
    scenarios.push(evidence);
    process.stdout.write(allChecksPass(evidence) ? "PASS\n" : "FAIL\n");
    if (!allChecksPass(evidence)) {
      process.stdout.write(`${JSON.stringify(evidence.checks, null, 2)}\n`);
    }
  }

  const evidence = {
    probe: "r0-07-at-most-once-launch",
    contracts: [
      "RT-LAUNCH-01",
      "RT-LAUNCH-02",
      "RT-LAUNCH-03",
      "RT-LAUNCH-04",
      "RT-LAUNCH-05",
      "RT-LAUNCH-06",
      "RT-LAUNCH-08",
      "RT-T-11",
      "RT-CMD-02",
      "RT-CMD-16",
      "RT-REC-12",
    ],
    capturedAt: new Date().toISOString(),
    platform: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
    node: process.version,
    scenarioCount: scenarios.length,
    allChecksPass: scenarios.every(allChecksPass),
    scenarios,
  };

  if (onlyIdx < 0) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const out = join(EVIDENCE_DIR, "evidence-at-most-once-launch.json");
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    process.stdout.write(`evidence written: ${out}\n`);
  }
};

await main();
