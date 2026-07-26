// R0-16 — RuntimeLimitProfile freeze evidence CLI.
// Cross-checks the frozen profile against its independent sources (the
// RT-TASK-01 spec bounds, the R0-06 measured prototype caps), replays
// limit-guard boundary probes (limit - 1 / limit / limit + 1 / non-finite),
// verifies the frozen performance budget against the spec latency gates and
// version coherence with the platform matrix, and writes
// docs/probes/r0-16/evidence.json.
//
// Usage: pnpm prototype:r0-16

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkLimit,
  checkTerminalLimit,
  FROZEN_PERFORMANCE_BUDGET,
  FROZEN_PLATFORM_MATRIX,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  RUNTIME_LIMIT_PROFILE_VERSION,
} from "@agents-fleet/contracts";
import { createR006Scenario, R0_06_QUEUE_LIMITS } from "../r0-06-binary-stream/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = join(ROOT, "docs", "probes", "r0-16");

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const profile = FROZEN_RUNTIME_LIMIT_PROFILE;
const budget = FROZEN_PERFORMANCE_BUDGET;

// Independent sources — never the frozen constant itself.
const specTaskBounds = { taskFieldBytes: 512 * 1024, taskSpecBytes: 1024 * 1024 }; // RT-TASK-01
const specLatencyGates = {
  inputLatencyMs: { median: 75, p99: 300 }, // RT-PERF-01
  outputLatencyMs: { p95: 100, p99: 300 }, // RT-PERF-02
  sessionRestoreMs: { p95: 1000 }, // RT-PERF-03
  presentationMs: { p95: 150, p99: 500 }, // RT-PERF-09
};
const specFixedLoad = {
  aliveSessions: 10,
  hotProducerBytesPerSecond: 5 * 1024 * 1024,
  durationSeconds: 60,
}; // RT-PERF-08
const r006 = createR006Scenario(60); // measured caps from the R0-06 prototype

const crossChecks = [
  {
    source: "RT-TASK-01 (spec)",
    checks: {
      taskFieldBytes: profile.taskFieldBytes === specTaskBounds.taskFieldBytes,
      taskSpecBytes: profile.taskSpecBytes === specTaskBounds.taskSpecBytes,
    },
  },
  {
    source: "R0-06 measured prototype",
    checks: {
      attachmentQueueBytes: profile.attachmentQueueBytes === R0_06_QUEUE_LIMITS.bytes,
      attachmentQueueFrames: profile.attachmentQueueFrames === R0_06_QUEUE_LIMITS.frames,
      streamFramePayloadBytes: profile.streamFramePayloadBytes === r006.framePayloadBytes,
    },
  },
  {
    source: "RT-PERF-01/02/03/09 latency gates (spec)",
    checks: {
      inputLatencyMs:
        budget.inputLatencyMs.median === specLatencyGates.inputLatencyMs.median &&
        budget.inputLatencyMs.p99 === specLatencyGates.inputLatencyMs.p99,
      outputLatencyMs:
        budget.outputLatencyMs.p95 === specLatencyGates.outputLatencyMs.p95 &&
        budget.outputLatencyMs.p99 === specLatencyGates.outputLatencyMs.p99,
      sessionRestoreMs: budget.sessionRestoreMs.p95 === specLatencyGates.sessionRestoreMs.p95,
      presentationMsPerRendererPath:
        budget.presentationMsPerRendererPath.WebGL2.p95 === specLatencyGates.presentationMs.p95 &&
        budget.presentationMsPerRendererPath.WebGL2.p99 === specLatencyGates.presentationMs.p99 &&
        budget.presentationMsPerRendererPath.DOM.p95 === specLatencyGates.presentationMs.p95 &&
        budget.presentationMsPerRendererPath.DOM.p99 === specLatencyGates.presentationMs.p99,
    },
  },
  {
    source: "RT-PERF-08 fixed load (spec)",
    checks: {
      fixedLoad:
        budget.fixedLoad.aliveSessions === specFixedLoad.aliveSessions &&
        budget.fixedLoad.hotProducerBytesPerSecond === specFixedLoad.hotProducerBytesPerSecond &&
        budget.fixedLoad.durationSeconds === specFixedLoad.durationSeconds,
    },
  },
  {
    source: "version coherence (RT-DIST-08 / RT-LIMIT-03)",
    checks: {
      profileVersion: RUNTIME_LIMIT_PROFILE_VERSION === 1 && profile.profileVersion === 1,
      matrixRecordsProfile:
        FROZEN_PLATFORM_MATRIX.runtimeLimitProfileVersion === RUNTIME_LIMIT_PROFILE_VERSION,
      matrixBumped: FROZEN_PLATFORM_MATRIX.matrixVersion === 2,
      budgetReferences:
        budget.matrixVersion === FROZEN_PLATFORM_MATRIX.matrixVersion &&
        budget.runtimeLimitProfileVersion === RUNTIME_LIMIT_PROFILE_VERSION,
    },
  },
];

// Boundary probes on the pure guard (RT-LIMIT-02 / RT-T-46 shape).
const boundaryProbes = [
  {
    field: "attachmentQueueBytes" as const,
    allowed: profile.attachmentQueueBytes,
    probes: {
      limitMinus1: checkLimit(profile, "attachmentQueueBytes", profile.attachmentQueueBytes - 1),
      limit: checkLimit(profile, "attachmentQueueBytes", profile.attachmentQueueBytes),
      limitPlus1: checkLimit(profile, "attachmentQueueBytes", profile.attachmentQueueBytes + 1),
      nan: checkLimit(profile, "attachmentQueueBytes", Number.NaN),
      infinity: checkLimit(profile, "attachmentQueueBytes", Number.POSITIVE_INFINITY),
      negative: checkLimit(profile, "attachmentQueueBytes", -1),
      maliciousOverflow: checkLimit(profile, "attachmentQueueBytes", Number.MAX_SAFE_INTEGER),
    },
  },
  {
    field: "terminal.pendingWriteBytes" as const,
    allowed: profile.terminal.pendingWriteBytes,
    probes: {
      limitMinus1: checkTerminalLimit(
        profile,
        "pendingWriteBytes",
        profile.terminal.pendingWriteBytes - 1,
      ),
      limit: checkTerminalLimit(profile, "pendingWriteBytes", profile.terminal.pendingWriteBytes),
      limitPlus1: checkTerminalLimit(
        profile,
        "pendingWriteBytes",
        profile.terminal.pendingWriteBytes + 1,
      ),
      nan: checkTerminalLimit(profile, "pendingWriteBytes", Number.NaN),
      infinity: checkTerminalLimit(profile, "pendingWriteBytes", Number.POSITIVE_INFINITY),
      negative: checkTerminalLimit(profile, "pendingWriteBytes", -1),
      maliciousOverflow: checkTerminalLimit(profile, "pendingWriteBytes", Number.MAX_SAFE_INTEGER),
    },
  },
];

const boundaryVerdicts = boundaryProbes.map((b) => ({
  field: b.field,
  allowed: b.allowed,
  results: Object.fromEntries(
    Object.entries(b.probes).map(([k, r]) => [k, r.ok ? "pass" : "violation"]),
  ),
  correct:
    b.probes.limitMinus1.ok === true &&
    b.probes.limit.ok === true &&
    b.probes.limitPlus1.ok === false &&
    b.probes.nan.ok === false &&
    b.probes.infinity.ok === false &&
    b.probes.negative.ok === false &&
    b.probes.maliciousOverflow.ok === false,
}));

const allCrossChecksPass = crossChecks.every((c) => Object.values(c.checks).every(Boolean));
const allBoundariesCorrect = boundaryVerdicts.every((b) => b.correct);

const evidence = {
  probeId: "r0-16-runtime-limit-profile",
  capturedAt: new Date().toISOString(),
  baseCommit: git("rev-parse", "HEAD"),
  frozenProfile: profile,
  frozenPerformanceBudget: budget,
  provenance: {
    specDerived:
      "taskFieldBytes / taskSpecBytes (RT-TASK-01); terminal.scrollbackLines (RT-PERF-03); latency gates and fixed load (RT-PERF-01/02/03/08/09)",
    r0_06Measured:
      "attachmentQueueBytes / attachmentQueueFrames / streamFramePayloadBytes; streamFramesPerSecond = 3x the observed hot-session 80 fps",
    aPrioriTargets:
      "all remaining fields and the RSS / CPU / paint / lag budgets — engineering bounds to be validated on the matrix floor fixture (M1 / 8 GiB) in R4",
  },
  crossChecks,
  boundaryVerdicts,
  verdict: allCrossChecksPass && allBoundariesCorrect ? "PASS" : "FAIL",
};

mkdirSync(EVIDENCE_DIR, { recursive: true });
const out = join(EVIDENCE_DIR, "evidence.json");
writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(
  `R0-16 RuntimeLimitProfile v${RUNTIME_LIMIT_PROFILE_VERSION} + PerformanceBudget v${budget.budgetVersion} (matrix v${FROZEN_PLATFORM_MATRIX.matrixVersion})`,
);
for (const c of crossChecks) {
  console.log(`  ${Object.values(c.checks).every(Boolean) ? "✓" : "✗"} ${c.source}`);
}
for (const b of boundaryVerdicts) {
  console.log(`  ${b.correct ? "✓" : "✗"} boundary ${b.field} @ ${b.allowed}`);
}
console.log(`verdict: ${evidence.verdict}`);
console.log(`wrote ${out}`);

if (evidence.verdict !== "PASS") process.exitCode = 1;
