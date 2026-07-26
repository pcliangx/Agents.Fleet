// R0-14 — evidence CLI。跑完整 RT-T-23 / RT-T-24 崩溃矩阵并把脱敏的
// 机器可读证据写到 docs/probes/r0-14/evidence.json。
//
// Usage:
//   pnpm prototype:r0-14                                        # 全矩阵 → evidence JSON
//   tsx evidence.ts --only journal:afterRename --keep           # 单场景，保留 workDir
//   tsx evidence.ts --only intent:afterPtyWrite --keep

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FROZEN_PLATFORM_MATRIX } from "@agents-fleet/contracts";
import {
  allIntentChecksPass,
  allJournalChecksPass,
  INTENT_CRASH_POINTS,
  type IntentCrashPoint,
  type IntentScenarioEvidence,
  JOURNAL_CRASH_POINTS,
  type JournalCrashPoint,
  type JournalScenarioEvidence,
  runIntentScenario,
  runJournalScenario,
} from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(here, "..", "..", "..", "..", "..", "docs", "probes", "r0-14");

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf("--only");
  const keep = args.includes("--keep");

  let journalPoints: (JournalCrashPoint | null)[] = [null, ...JOURNAL_CRASH_POINTS];
  let intentPoints: (IntentCrashPoint | null)[] = [null, ...INTENT_CRASH_POINTS];
  if (onlyIdx >= 0) {
    const onlyArg = args[onlyIdx + 1];
    if (!onlyArg) throw new Error("usage: --only <journal|intent>:<crashPoint|null>");
    const [kind, point] = onlyArg.split(":");
    const p = point === "null" ? null : point;
    journalPoints = kind === "journal" ? [p as JournalCrashPoint | null] : [];
    intentPoints = kind === "intent" ? [p as IntentCrashPoint | null] : [];
  }

  const journalScenarios: JournalScenarioEvidence[] = [];
  for (const crashPoint of journalPoints) {
    process.stdout.write(`journal scenario ${crashPoint ?? "baseline"} ... `);
    const e = await runJournalScenario({ crashPoint }, keep);
    journalScenarios.push(e);
    process.stdout.write(`${allJournalChecksPass(e) ? "PASS" : "FAIL"}\n`);
    if (!allJournalChecksPass(e)) process.stdout.write(`${JSON.stringify(e.checks, null, 2)}\n`);
  }

  const intentScenarios: IntentScenarioEvidence[] = [];
  for (const crashPoint of intentPoints) {
    process.stdout.write(`intent scenario ${crashPoint ?? "baseline"} ... `);
    const e = await runIntentScenario({ crashPoint }, keep);
    intentScenarios.push(e);
    process.stdout.write(`${allIntentChecksPass(e) ? "PASS" : "FAIL"}\n`);
    if (!allIntentChecksPass(e)) process.stdout.write(`${JSON.stringify(e.checks, null, 2)}\n`);
  }

  const evidence = {
    probe: "r0-14-chunk-durability",
    contracts: [
      "RT-STO-02",
      "RT-STO-03",
      "RT-STO-08",
      "RT-STO-11",
      "RT-ORDER-07",
      "RT-INPUT-01",
      "RT-INPUT-02",
      "RT-INPUT-03",
      "RT-INPUT-04",
      "RT-REC-10",
      "RT-PERF-05",
      "RT-T-23",
      "RT-T-24",
    ],
    capturedAt: new Date().toISOString(),
    platform: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
    node: process.version,
    matrixVersion: FROZEN_PLATFORM_MATRIX.matrixVersion,
    scenarioCount: journalScenarios.length + intentScenarios.length,
    allChecksPass:
      journalScenarios.every(allJournalChecksPass) && intentScenarios.every(allIntentChecksPass),
    journalScenarios,
    intentScenarios,
  };

  if (onlyIdx < 0) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const out = join(EVIDENCE_DIR, "evidence.json");
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    // 复现产物必须与 biome JSON 风格一致（数组折叠等），保证 lint 常绿。
    execFileSync("pnpm", ["exec", "biome", "format", "--write", out], { stdio: "inherit" });
    process.stdout.write(`evidence written: ${out}\n`);
  }
};

await main();
