// PROTOTYPE — R0-06 fixed-load binary stream/backpressure benchmark.
// Run: pnpm prototype:r0-06:benchmark

import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";
import { decodeFrame, encodeFrame } from "../../binary-frame.js";
import {
  type AttachmentFlowState,
  consumeQueuedFrames,
  createAttachmentFlowState,
  ingestDurableFrame,
  resyncAtDurableHead,
  setAttachmentHidden,
  summarizeAttachmentFlow,
} from "./model.js";

const MIB = 1024 * 1024;
const SESSION_COUNT = 10;
const FRAME_PAYLOAD_BYTES = 64 * 1024;
const HOT_SESSION_RATE = 5 * MIB;
const BACKGROUND_SESSION_RATE = 64 * 1024;
const SLOW_SESSION_SOURCE_RATE = 1 * MIB;
const QUEUE_LIMIT_BYTES = 1 * MIB;
const QUEUE_LIMIT_FRAMES = 32;
const SLOW_SESSION_INDEX = 1;
const HIDDEN_SESSION_INDEX = 2;

interface BenchmarkOptions {
  readonly durationSeconds: number;
  readonly outputPath: string | null;
}

interface BenchmarkResult {
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
  readonly acceptance: Readonly<Record<string, boolean>>;
  readonly sessions: readonly object[];
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

const sessionId = (index: number): SessionId => `r0-06-session-${index}` as SessionId;
const generation = 1 as Generation;
const seq = (value: number): Seq => value as Seq;
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`missing benchmark item at index ${index}`);
  return item;
};

const makeHeader = (index: number, sequence: number): StreamFrameHeader => ({
  frameType: "output",
  sessionId: sessionId(index),
  generation,
  seq: seq(sequence),
  payloadLength: FRAME_PAYLOAD_BYTES,
});

export const runBenchmark = async (options: BenchmarkOptions): Promise<BenchmarkResult> => {
  const states: AttachmentFlowState[] = Array.from({ length: SESSION_COUNT }, (_, index) =>
    createAttachmentFlowState(sessionId(index), generation, {
      bytes: QUEUE_LIMIT_BYTES,
      frames: QUEUE_LIMIT_FRAMES,
    }),
  );
  const producerBudgets = new Array<number>(SESSION_COUNT).fill(0);
  const consumerBudgets = new Array<number>(SESSION_COUNT).fill(0);
  const sourceRates = Array.from({ length: SESSION_COUNT }, (_, index) => {
    if (index === 0) return HOT_SESSION_RATE;
    if (index === SLOW_SESSION_INDEX) return SLOW_SESSION_SOURCE_RATE;
    return BACKGROUND_SESSION_RATE;
  });
  const consumerRates = Array.from({ length: SESSION_COUNT }, (_, index) => {
    if (index === SLOW_SESSION_INDEX) return 16 * 1024;
    if (index === 0) return 8 * MIB;
    return 512 * 1024;
  });
  const payloads = Array.from({ length: SESSION_COUNT }, (_, index) =>
    new Uint8Array(FRAME_PAYLOAD_BYTES).fill(index),
  );

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const startedAt = performance.now();
  const startedRss = process.memoryUsage().rss;
  let peakRss = startedRss;
  let previousAt = startedAt;
  let sourcePayloadBytes = 0;
  let wireBytes = 0;
  let decodedFrames = 0;
  let crossSessionFrames = 0;
  let queueLimitViolations = 0;
  let hiddenStarted = false;
  let hiddenEnded = false;
  const endAt = startedAt + options.durationSeconds * 1000;

  while (performance.now() < endAt) {
    const now = performance.now();
    const elapsedSeconds = Math.max(0, (now - previousAt) / 1000);
    previousAt = now;

    const progress = (now - startedAt) / (options.durationSeconds * 1000);
    if (!hiddenStarted && progress >= 1 / 3) {
      states[HIDDEN_SESSION_INDEX] = setAttachmentHidden(at(states, HIDDEN_SESSION_INDEX), true);
      hiddenStarted = true;
    }
    if (!hiddenEnded && progress >= 2 / 3) {
      states[HIDDEN_SESSION_INDEX] = setAttachmentHidden(at(states, HIDDEN_SESSION_INDEX), false);
      states[HIDDEN_SESSION_INDEX] = resyncAtDurableHead(at(states, HIDDEN_SESSION_INDEX));
      hiddenEnded = true;
    }

    for (let index = 0; index < SESSION_COUNT; index += 1) {
      let producerBudget = (producerBudgets[index] ?? 0) + at(sourceRates, index) * elapsedSeconds;
      let consumerBudget =
        (consumerBudgets[index] ?? 0) + at(consumerRates, index) * elapsedSeconds;
      let flow = at(states, index);

      while (producerBudget >= FRAME_PAYLOAD_BYTES) {
        const sequence = (flow.durableSeq as number) + 1;
        const encoded = encodeFrame(makeHeader(index, sequence), at(payloads, index));
        const decoded = decodeFrame(encoded);
        decodedFrames += 1;
        sourcePayloadBytes += decoded.payload.byteLength;
        wireBytes += encoded.byteLength;
        if (decoded.header.sessionId !== flow.sessionId) crossSessionFrames += 1;

        flow = ingestDurableFrame(flow, {
          header: decoded.header,
          payloadBytes: decoded.payload.byteLength,
          wireBytes: encoded.byteLength,
        });
        producerBudget -= FRAME_PAYLOAD_BYTES;

        if (flow.queueBytes > QUEUE_LIMIT_BYTES || flow.queue.length > QUEUE_LIMIT_FRAMES) {
          queueLimitViolations += 1;
        }
      }

      const consumed = consumeQueuedFrames(flow, consumerBudget);
      flow = consumed.state;
      consumerBudget -= consumed.consumedWireBytes;

      states[index] = flow;
      producerBudgets[index] = producerBudget;
      consumerBudgets[index] = consumerBudget;
    }

    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await waitForNextTick();
  }

  for (let index = 0; index < SESSION_COUNT; index += 1) {
    let flow = at(states, index);
    if (flow.hidden) flow = setAttachmentHidden(flow, false);
    if (flow.resyncRequired) flow = resyncAtDurableHead(flow);
    states[index] = consumeQueuedFrames(flow, Number.MAX_SAFE_INTEGER).state;
  }

  const finishedAt = performance.now();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  eventLoop.disable();
  const actualDurationSeconds = (finishedAt - startedAt) / 1000;
  const totalTargetRate =
    HOT_SESSION_RATE + SLOW_SESSION_SOURCE_RATE + BACKGROUND_SESSION_RATE * (SESSION_COUNT - 2);
  const achievedRate = sourcePayloadBytes / actualDurationSeconds;
  const identityErrors = states.reduce((sum, state) => sum + state.identityErrors, 0);
  const sequenceErrors = states.reduce((sum, state) => sum + state.sequenceErrors, 0);
  const resyncCount = states.reduce((sum, state) => sum + state.resyncCount, 0);
  const healthyIndexes = [0, 3, 4, 5, 6, 7, 8, 9];
  const healthySessionsCaughtUp = healthyIndexes.every(
    (index) => at(states, index).appliedSeq === at(states, index).durableSeq,
  );
  const productionDurationSeconds = (previousAt - startedAt) / 1000;
  const scheduledPayloadBytes = sourceRates.reduce(
    (sum, rate) =>
      sum +
      Math.floor((rate * productionDurationSeconds) / FRAME_PAYLOAD_BYTES) * FRAME_PAYLOAD_BYTES,
    0,
  );
  const scheduledHotPayloadBytes =
    Math.floor((HOT_SESSION_RATE * productionDurationSeconds) / FRAME_PAYLOAD_BYTES) *
    FRAME_PAYLOAD_BYTES;

  const acceptance = {
    fixedSessionCount: states.length === SESSION_COUNT,
    hotSessionReachedSchedule: at(states, 0).durablePayloadBytes === scheduledHotPayloadBytes,
    aggregatePayloadReachedSchedule: sourcePayloadBytes === scheduledPayloadBytes,
    noCrossSessionFrames: crossSessionFrames === 0 && identityErrors === 0,
    noSequenceErrors: sequenceErrors === 0,
    boundedQueues: queueLimitViolations === 0,
    explicitSlowResyncObserved:
      at(states, SLOW_SESSION_INDEX).backpressureEvents > 0 &&
      at(states, SLOW_SESSION_INDEX).resyncCount > 0,
    explicitHiddenResyncObserved: at(states, HIDDEN_SESSION_INDEX).resyncCount > 0,
    healthySessionsCaughtUp,
  };
  const verdict = Object.values(acceptance).every(Boolean) ? "PASS" : "FAIL";

  return {
    prototype: "R0-06",
    verdict,
    question:
      "Can bounded per-Attachment queues isolate a slow/hidden Renderer under the RT-PERF-08 10-Session binary load without blocking healthy Sessions?",
    scope: {
      proves: [
        "binary frame encode/decode identity remains isolated under the measured load",
        "the prototype queue policy stays within its configured byte/frame caps",
        "slow and hidden consumers use an explicit resync transition",
      ],
      doesNotProve: [
        "chunk durability, fsync ordering, or published-frame crash recovery (R0-14)",
        "xterm.js WebGL2/DOM rendering or Snapshot parser safety (R0-08/R0-09)",
        "production RuntimeLimitProfile values or release performance budgets (R0-16)",
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
    },
    configuration: {
      requestedDurationSeconds: options.durationSeconds,
      sessionCount: SESSION_COUNT,
      hotSessionPayloadBytesPerSecond: HOT_SESSION_RATE,
      backgroundSessionPayloadBytesPerSecond: BACKGROUND_SESSION_RATE,
      slowSessionPayloadBytesPerSecond: SLOW_SESSION_SOURCE_RATE,
      slowConsumerWireBytesPerSecond: at(consumerRates, SLOW_SESSION_INDEX),
      framePayloadBytes: FRAME_PAYLOAD_BYTES,
      attachmentQueueBytes: QUEUE_LIMIT_BYTES,
      attachmentQueueFrames: QUEUE_LIMIT_FRAMES,
      hiddenSessionIndex: HIDDEN_SESSION_INDEX,
      hiddenInterval: ["one-third", "two-thirds"],
    },
    measurements: {
      actualDurationSeconds,
      productionDurationSeconds,
      decodedFrames,
      sourcePayloadBytes,
      wireBytes,
      achievedPayloadBytesPerSecond: achievedRate,
      targetPayloadBytesPerSecond: totalTargetRate,
      crossSessionFrames,
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
    acceptance,
    sessions: states.map(summarizeAttachmentFlow),
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
