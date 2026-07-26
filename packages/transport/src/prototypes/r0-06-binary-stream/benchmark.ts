// PROTOTYPE — R0-06 fixed-load binary stream/backpressure benchmark.
// Run: pnpm prototype:r0-06:benchmark

import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  type Generation,
  PLATFORM_MATRIX_VERSION,
  RUNTIME_LIMIT_PROFILE_VERSION,
  type Seq,
  type SessionId,
  type StreamFrameHeader,
} from "@agents-fleet/contracts";
import { decodeFrame, encodeFrame } from "../../binary-frame.js";
import { runQueueBoundaryProbes } from "./boundaries.js";
import {
  type AttachmentFlowState,
  consumeQueuedFrames,
  createAttachmentFlowState,
  type QueuedFrame,
  setAttachmentHidden,
  summarizeAttachmentFlow,
} from "./model.js";
import { recoverUsingRecentDurableFrames } from "./recovery.js";
import {
  createMultiplexRouter,
  type MultiplexRouter,
  replaceRouteState,
  routeBinaryFrame,
} from "./router.js";
import {
  type BenchmarkSessionScenario,
  createR006Scenario,
  type R006Scenario,
  type SessionRole,
  targetFrameCount,
} from "./scenario.js";

const generation = 1 as Generation;

export interface BenchmarkOptions {
  readonly durationSeconds: number;
  readonly outputPath: string | null;
}

export interface BenchmarkResult {
  readonly prototype: "R0-06";
  readonly verdict: "PASS" | "FAIL";
  readonly question: string;
  readonly scope: {
    readonly proves: readonly string[];
    readonly doesNotProve: readonly string[];
  };
  readonly environment: object;
  readonly configuration: object;
  readonly measurements: object;
  readonly boundaryProbes: object;
  readonly isolationCanary: object;
  readonly recoveries: readonly object[];
  readonly acceptance: Readonly<Record<string, boolean>>;
  readonly sessions: readonly object[];
}

interface SessionRuntime {
  readonly scenario: BenchmarkSessionScenario;
  readonly targetFrames: number;
  readonly payload: Uint8Array;
  readonly recentDurableFrames: readonly QueuedFrame[];
  readonly generatedFrames: number;
  readonly consumerBudget: number;
  readonly hiddenStarted: boolean;
  readonly hiddenEnded: boolean;
}

interface RecoveryRecord {
  readonly sessionId: SessionId;
  readonly role: SessionRole;
  readonly requestedBy: "VisibilityResume" | "SlowConsumerRecovery";
  readonly method: "SnapshotPlusDelta";
  readonly snapshotCoversThroughSeq: Seq;
  readonly deltaFrames: number;
  readonly suppliedDeltaFrames: number;
  readonly duplicateDeltaFrames: number;
  readonly ok: boolean;
  readonly failureCode: string | null;
}

const parseOptions = (argv: readonly string[]): BenchmarkOptions => {
  let durationSeconds = 60;
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--duration") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--duration requires seconds");
      durationSeconds = Number(value);
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--out requires a path");
      outputPath = value;
      index += 1;
    }
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("duration must be a positive number");
  }
  return { durationSeconds, outputPath };
};

const waitForNextTick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

const makeHeader = (
  session: BenchmarkSessionScenario,
  sequence: number,
  payloadLength: number,
): StreamFrameHeader => ({
  frameType: "output",
  sessionId: session.sessionId,
  generation,
  seq: sequence as Seq,
  payloadLength,
});

const routeState = (router: MultiplexRouter, sessionId: SessionId): AttachmentFlowState => {
  const route = router.routes.get(sessionId);
  if (route === undefined) throw new Error(`missing route for ${sessionId}`);
  return route.state;
};

const runtimeFor = (
  runtimes: ReadonlyMap<SessionId, SessionRuntime>,
  sessionId: SessionId,
): SessionRuntime => {
  const runtime = runtimes.get(sessionId);
  if (runtime === undefined) throw new Error(`missing runtime for ${sessionId}`);
  return runtime;
};

const sessionWithRole = (
  scenario: R006Scenario,
  role: Exclude<SessionRole, "Background">,
): BenchmarkSessionScenario => {
  const session = scenario.sessions.find((candidate) => candidate.role === role);
  if (session === undefined) throw new Error(`missing ${role} Session`);
  return session;
};

const recoverRoute = (
  router: MultiplexRouter,
  runtime: SessionRuntime,
  requestedBy: RecoveryRecord["requestedBy"],
): { readonly router: MultiplexRouter; readonly record: RecoveryRecord } => {
  const recovery = recoverUsingRecentDurableFrames(
    routeState(router, runtime.scenario.sessionId),
    runtime.recentDurableFrames,
  );
  const nextRouter = recovery.result.ok ? replaceRouteState(router, recovery.result.state) : router;
  return {
    router: nextRouter,
    record: {
      sessionId: runtime.scenario.sessionId,
      role: runtime.scenario.role,
      requestedBy,
      ...recovery.evidence,
      ok: recovery.result.ok,
      failureCode: recovery.result.ok ? null : recovery.result.code,
    },
  };
};

const runIsolationCanary = (
  scenario: R006Scenario,
): {
  readonly crossSessionDetected: boolean;
  readonly sequenceGapDetected: boolean;
  readonly crossSessionFrames: number;
  readonly sequenceErrors: number;
} => {
  const hot = sessionWithRole(scenario, "Hot");
  const slow = sessionWithRole(scenario, "Slow");
  let router = createMultiplexRouter(
    [hot, slow].map((session) => ({
      state: createAttachmentFlowState(session.sessionId, generation, scenario.queueLimits),
      expectedPayloadMarker: session.payloadMarker,
    })),
  );

  const wrongPayload = new Uint8Array(scenario.framePayloadBytes).fill(slow.payloadMarker);
  const crossWire = encodeFrame(makeHeader(hot, 1, wrongPayload.byteLength), wrongPayload);
  router = routeBinaryFrame(router, decodeFrame(crossWire), crossWire).router;

  const correctPayload = new Uint8Array(scenario.framePayloadBytes).fill(hot.payloadMarker);
  const gapWire = encodeFrame(makeHeader(hot, 2, correctPayload.byteLength), correctPayload);
  router = routeBinaryFrame(router, decodeFrame(gapWire), gapWire).router;
  const sequenceErrors = routeState(router, hot.sessionId).sequenceErrors;

  return {
    crossSessionDetected: router.crossSessionFrames === 1,
    sequenceGapDetected: sequenceErrors === 1,
    crossSessionFrames: router.crossSessionFrames,
    sequenceErrors,
  };
};

export const runBenchmark = async (options: BenchmarkOptions): Promise<BenchmarkResult> => {
  const scenario = createR006Scenario(options.durationSeconds);
  let router = createMultiplexRouter(
    scenario.sessions.map((session) => ({
      state: createAttachmentFlowState(session.sessionId, generation, scenario.queueLimits),
      expectedPayloadMarker: session.payloadMarker,
    })),
  );
  const runtimes = new Map<SessionId, SessionRuntime>(
    scenario.sessions.map((session) => [
      session.sessionId,
      {
        scenario: session,
        targetFrames: targetFrameCount(session, scenario),
        payload: new Uint8Array(scenario.framePayloadBytes).fill(session.payloadMarker),
        recentDurableFrames: [],
        generatedFrames: 0,
        consumerBudget: 0,
        hiddenStarted: false,
        hiddenEnded: false,
      },
    ]),
  );
  const recoveries: RecoveryRecord[] = [];
  const healthyProgressBaseline = new Map<SessionId, Seq>();
  let slowBackpressureObserved = false;
  let queueLimitViolations = 0;
  let sourcePayloadBytes = 0;
  let wireBytes = 0;
  let decodedFrames = 0;

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const startedAt = performance.now();
  const endAt = startedAt + scenario.durationSeconds * 1_000;
  const startedRss = process.memoryUsage().rss;
  let peakRss = startedRss;
  let previousAt = startedAt;
  let productionFinishedAt = startedAt;

  while (true) {
    const now = performance.now();
    const elapsedSeconds = Math.min(scenario.durationSeconds, (now - startedAt) / 1_000);
    const tickSeconds = Math.max(0, (now - previousAt) / 1_000);
    previousAt = now;
    const progress = elapsedSeconds / scenario.durationSeconds;

    for (const session of scenario.sessions) {
      if (session.visibility.kind !== "HiddenInterval") continue;
      let runtime = runtimeFor(runtimes, session.sessionId);
      let state = routeState(router, session.sessionId);
      if (!runtime.hiddenStarted && progress >= session.visibility.startsAtFraction) {
        state = setAttachmentHidden(state, true);
        router = replaceRouteState(router, state);
        runtime = { ...runtime, hiddenStarted: true };
        runtimes.set(session.sessionId, runtime);
      }
      if (!runtime.hiddenEnded && progress >= session.visibility.endsAtFraction) {
        router = replaceRouteState(router, setAttachmentHidden(state, false));
        const recovered = recoverRoute(router, runtime, "VisibilityResume");
        router = recovered.router;
        recoveries.push(recovered.record);
        runtimes.set(session.sessionId, { ...runtime, hiddenEnded: true });
      }
    }

    const dueFrames = new Map<SessionId, number>();
    for (const session of scenario.sessions) {
      const runtime = runtimeFor(runtimes, session.sessionId);
      const scheduledFrames =
        now >= endAt
          ? runtime.targetFrames
          : Math.min(
              runtime.targetFrames,
              Math.floor(
                (session.sourcePayloadBytesPerSecond * elapsedSeconds) / scenario.framePayloadBytes,
              ),
            );
      dueFrames.set(session.sessionId, scheduledFrames - runtime.generatedFrames);
    }

    while ([...dueFrames.values()].some((due) => due > 0)) {
      for (const session of scenario.sessions) {
        const due = dueFrames.get(session.sessionId) ?? 0;
        if (due <= 0) continue;
        const runtime = runtimeFor(runtimes, session.sessionId);
        const sequence = runtime.generatedFrames + 1;
        const encoded = encodeFrame(
          makeHeader(session, sequence, runtime.payload.byteLength),
          runtime.payload,
        );
        const decoded = decodeFrame(encoded);
        const routed = routeBinaryFrame(router, decoded, encoded);
        router = routed.router;
        decodedFrames += 1;
        sourcePayloadBytes += decoded.payload.byteLength;
        wireBytes += encoded.byteLength;

        const queuedFrame: QueuedFrame = {
          header: decoded.header,
          payloadBytes: decoded.payload.byteLength,
          wireBytes: encoded.byteLength,
        };
        const nextRuntime: SessionRuntime = {
          ...runtime,
          generatedFrames: sequence,
          recentDurableFrames: [...runtime.recentDurableFrames, queuedFrame].slice(-3),
        };
        runtimes.set(session.sessionId, nextRuntime);
        dueFrames.set(session.sessionId, due - 1);

        const state = routeState(router, session.sessionId);
        if (
          state.queueBytes > scenario.queueLimits.bytes ||
          state.queue.length > scenario.queueLimits.frames
        ) {
          queueLimitViolations += 1;
        }
        if (session.role === "Slow" && state.resyncRequired && !slowBackpressureObserved) {
          slowBackpressureObserved = true;
          for (const healthy of scenario.sessions.filter(
            (candidate) => candidate.mustProgressDuringSlowBackpressure,
          )) {
            healthyProgressBaseline.set(
              healthy.sessionId,
              routeState(router, healthy.sessionId).appliedSeq,
            );
          }
        }
      }
    }

    for (const session of scenario.sessions) {
      const runtime = runtimeFor(runtimes, session.sessionId);
      const availableBudget =
        runtime.consumerBudget + session.consumerWireBytesPerSecond * tickSeconds;
      const consumed = consumeQueuedFrames(routeState(router, session.sessionId), availableBudget);
      router = replaceRouteState(router, consumed.state);
      runtimes.set(session.sessionId, {
        ...runtime,
        consumerBudget: availableBudget - consumed.consumedWireBytes,
      });
    }

    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const exactScheduleComplete = [...runtimes.values()].every(
      (runtime) => runtime.generatedFrames === runtime.targetFrames,
    );
    if (now >= endAt && exactScheduleComplete) {
      productionFinishedAt = performance.now();
      break;
    }
    await waitForNextTick();
  }

  const healthySessionsProgressedDuringSlowBackpressure =
    slowBackpressureObserved &&
    scenario.sessions
      .filter((session) => session.mustProgressDuringSlowBackpressure)
      .every((session) => {
        const baseline = healthyProgressBaseline.get(session.sessionId);
        return (
          baseline !== undefined &&
          (routeState(router, session.sessionId).appliedSeq as number) > (baseline as number)
        );
      });

  for (const session of scenario.sessions) {
    let state = routeState(router, session.sessionId);
    if (state.hidden) {
      state = setAttachmentHidden(state, false);
      router = replaceRouteState(router, state);
    }
    if (state.resyncRequired) {
      const recovered = recoverRoute(
        router,
        runtimeFor(runtimes, session.sessionId),
        session.role === "Slow" ? "SlowConsumerRecovery" : "VisibilityResume",
      );
      router = recovered.router;
      recoveries.push(recovered.record);
    }
    const consumed = consumeQueuedFrames(
      routeState(router, session.sessionId),
      Number.MAX_SAFE_INTEGER,
    );
    router = replaceRouteState(router, consumed.state);
  }

  const finishedAt = performance.now();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  eventLoop.disable();
  const states = scenario.sessions.map((session) => routeState(router, session.sessionId));
  const identityErrors = states.reduce((sum, state) => sum + state.identityErrors, 0);
  const sequenceErrors = states.reduce((sum, state) => sum + state.sequenceErrors, 0);
  const resyncCount = states.reduce((sum, state) => sum + state.resyncCount, 0);
  const expectedFrames = [...runtimes.values()].reduce(
    (total, runtime) => total + runtime.targetFrames,
    0,
  );
  const expectedPayloadBytes = expectedFrames * scenario.framePayloadBytes;
  const hot = sessionWithRole(scenario, "Hot");
  const hotRuntime = runtimeFor(runtimes, hot.sessionId);
  const boundaryProbes = runQueueBoundaryProbes(scenario.queueLimits);
  const isolationCanary = runIsolationCanary(scenario);
  const byteCapBoundariesProven =
    !boundaryProbes.byteCap.limitMinusOne.resyncRequired &&
    !boundaryProbes.byteCap.limit.resyncRequired &&
    boundaryProbes.byteCap.limitPlusOne.resyncRequired;
  const frameCapBoundariesProven =
    !boundaryProbes.frameCap.limitMinusOne.resyncRequired &&
    !boundaryProbes.frameCap.limit.resyncRequired &&
    boundaryProbes.frameCap.limitPlusOne.resyncRequired;
  const explicitSlowSnapshotDeltaRecovery = recoveries.some(
    (record) =>
      record.role === "Slow" &&
      record.requestedBy === "SlowConsumerRecovery" &&
      record.ok &&
      record.deltaFrames > 0,
  );
  const explicitHiddenSnapshotDeltaRecovery = recoveries.some(
    (record) =>
      record.role === "Hidden" &&
      record.requestedBy === "VisibilityResume" &&
      record.ok &&
      record.deltaFrames > 0,
  );
  const acceptance = {
    fixedSessionCount: states.length === scenario.sessions.length && states.length === 10,
    exactFixedFrameSchedule:
      decodedFrames === expectedFrames &&
      [...runtimes.values()].every((runtime) => runtime.generatedFrames === runtime.targetFrames),
    hotSessionReachedExactSchedule:
      routeState(router, hot.sessionId).durablePayloadBytes ===
      hotRuntime.targetFrames * scenario.framePayloadBytes,
    aggregatePayloadReachedExactSchedule: sourcePayloadBytes === expectedPayloadBytes,
    noCrossSessionFrames:
      router.crossSessionFrames === 0 && router.unknownSessionFrames === 0 && identityErrors === 0,
    noSequenceErrors: sequenceErrors === 0,
    isolationCanaryDetectsCrossSession: isolationCanary.crossSessionDetected,
    isolationCanaryDetectsSequenceGap: isolationCanary.sequenceGapDetected,
    boundedQueues: queueLimitViolations === 0,
    byteCapBoundariesProven,
    frameCapBoundariesProven,
    explicitSlowSnapshotDeltaRecovery,
    explicitHiddenSnapshotDeltaRecovery,
    healthySessionsProgressedDuringSlowBackpressure,
    allSessionsCaughtUpAfterExplicitRecovery: states.every(
      (state) => state.appliedSeq === state.durableSeq,
    ),
    versionProvenanceDeclared:
      scenario.platformMatrixVersion === PLATFORM_MATRIX_VERSION &&
      scenario.runtimeLimitProfileVersion === RUNTIME_LIMIT_PROFILE_VERSION &&
      scenario.provenanceStatus === "matrix-and-profile-frozen",
  };
  const verdict = Object.values(acceptance).every(Boolean) ? "PASS" : "FAIL";
  const actualDurationSeconds = (finishedAt - startedAt) / 1_000;
  const productionDurationSeconds = (productionFinishedAt - startedAt) / 1_000;
  const targetPayloadBytesPerSecond = scenario.sessions.reduce(
    (total, session) => total + session.sourcePayloadBytesPerSecond,
    0,
  );

  return {
    prototype: "R0-06",
    verdict,
    question:
      "Can bounded per-Attachment queues isolate a slow/hidden Renderer under the RT-PERF-08 10-Session binary load without blocking healthy Sessions?",
    scope: {
      proves: [
        "shared multiplex routing preserves Session identity under interleaved binary frames",
        "byte and frame queue caps independently pass limit - 1 / limit / limit + 1 probes",
        "slow and hidden consumers recover through an identity-bound Snapshot cursor plus contiguous delta",
        "the fixed schedule emits every required frame, including the final 60-second boundary",
      ],
      doesNotProve: [
        "chunk durability, fsync ordering, or published-frame crash recovery (R0-14)",
        "xterm.js WebGL2/DOM rendering or Snapshot parser safety (R0-08/R0-09)",
        "release performance acceptance on the matrix floor fixture (M1 / 8 GiB) — the RuntimeLimitProfile and SupportedPlatformMatrix are frozen (R0-15/R0-16), but this host is above the floor and results stay non-reusable for acceptance",
      ],
    },
    environment: {
      capturedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtEnd: freemem(),
      platformMatrixVersion: scenario.platformMatrixVersion,
      runtimeLimitProfileVersion: scenario.runtimeLimitProfileVersion,
      provenanceStatus: scenario.provenanceStatus,
      resultReusableAfterProfileOrMatrixFreeze: false,
    },
    configuration: {
      requestedDurationSeconds: scenario.durationSeconds,
      sessionCount: scenario.sessions.length,
      framePayloadBytes: scenario.framePayloadBytes,
      attachmentQueueBytes: scenario.queueLimits.bytes,
      attachmentQueueFrames: scenario.queueLimits.frames,
      expectedFrames,
      expectedPayloadBytes,
      sessions: scenario.sessions.map((session) => ({
        sessionId: session.sessionId,
        role: session.role,
        sourcePayloadBytesPerSecond: session.sourcePayloadBytesPerSecond,
        consumerWireBytesPerSecond: session.consumerWireBytesPerSecond,
        visibility: session.visibility,
        targetFrames: targetFrameCount(session, scenario),
      })),
    },
    measurements: {
      actualDurationSeconds,
      productionDurationSeconds,
      decodedFrames,
      sourcePayloadBytes,
      wireBytes,
      achievedPayloadBytesPerSecond: sourcePayloadBytes / productionDurationSeconds,
      targetPayloadBytesPerSecond,
      productionCrossSessionFrames: router.crossSessionFrames,
      productionUnknownSessionFrames: router.unknownSessionFrames,
      identityErrors,
      sequenceErrors,
      queueLimitViolations,
      resyncCount,
      startedRssBytes: startedRss,
      peakRssBytes: peakRss,
      rssGrowthBytes: peakRss - startedRss,
      eventLoopDelayP50Ms: eventLoop.percentile(50) / 1e6,
      eventLoopDelayP95Ms: eventLoop.percentile(95) / 1e6,
      eventLoopDelayP99Ms: eventLoop.percentile(99) / 1e6,
      eventLoopDelayMaxMs: eventLoop.max / 1e6,
    },
    boundaryProbes,
    isolationCanary,
    recoveries,
    acceptance,
    sessions: scenario.sessions.map((session) => ({
      role: session.role,
      targetFrames: runtimeFor(runtimes, session.sessionId).targetFrames,
      generatedFrames: runtimeFor(runtimes, session.sessionId).generatedFrames,
      ...summarizeAttachmentFlow(routeState(router, session.sessionId)),
    })),
  };
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const result = await runBenchmark(options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(json);
  if (options.outputPath !== null) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, json);
  }
  if (result.verdict !== "PASS") process.exitCode = 1;
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
