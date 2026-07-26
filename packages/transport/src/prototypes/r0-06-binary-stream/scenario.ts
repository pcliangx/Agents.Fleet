import {
  PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION,
  PLATFORM_MATRIX_VERSION,
  type SessionId,
} from "@agents-fleet/contracts";
import type { QueueLimits } from "./model.js";

const MIB = 1024 * 1024;

export type SessionRole = "Hot" | "Slow" | "Hidden" | "Background";

export type VisibilityPolicy =
  | { readonly kind: "AlwaysVisible" }
  | {
      readonly kind: "HiddenInterval";
      readonly startsAtFraction: number;
      readonly endsAtFraction: number;
    };

export interface BenchmarkSessionScenario {
  readonly sessionId: SessionId;
  readonly role: SessionRole;
  readonly payloadMarker: number;
  readonly sourcePayloadBytesPerSecond: number;
  readonly consumerWireBytesPerSecond: number;
  readonly visibility: VisibilityPolicy;
  readonly mustProgressDuringSlowBackpressure: boolean;
}

export interface R006Scenario {
  readonly durationSeconds: number;
  readonly framePayloadBytes: number;
  readonly queueLimits: QueueLimits;
  readonly platformMatrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
  readonly provenanceStatus: "matrix-frozen-limit-profile-pending";
  readonly sessions: readonly BenchmarkSessionScenario[];
}

export const R0_06_QUEUE_LIMITS: QueueLimits = {
  bytes: 1 * MIB,
  frames: 32,
};

const alwaysVisible: VisibilityPolicy = { kind: "AlwaysVisible" };

export const createR006Scenario = (durationSeconds = 60): R006Scenario => ({
  durationSeconds,
  framePayloadBytes: 64 * 1024,
  queueLimits: R0_06_QUEUE_LIMITS,
  platformMatrixVersion: PLATFORM_MATRIX_VERSION,
  runtimeLimitProfileVersion: PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION,
  provenanceStatus: "matrix-frozen-limit-profile-pending",
  sessions: [
    {
      sessionId: "r0-06-session-hot" as SessionId,
      role: "Hot",
      payloadMarker: 0,
      sourcePayloadBytesPerSecond: 5 * MIB,
      consumerWireBytesPerSecond: 8 * MIB,
      visibility: alwaysVisible,
      mustProgressDuringSlowBackpressure: true,
    },
    {
      sessionId: "r0-06-session-slow" as SessionId,
      role: "Slow",
      payloadMarker: 1,
      sourcePayloadBytesPerSecond: 1 * MIB,
      consumerWireBytesPerSecond: 16 * 1024,
      visibility: alwaysVisible,
      mustProgressDuringSlowBackpressure: false,
    },
    {
      sessionId: "r0-06-session-hidden" as SessionId,
      role: "Hidden",
      payloadMarker: 2,
      sourcePayloadBytesPerSecond: 64 * 1024,
      consumerWireBytesPerSecond: 512 * 1024,
      visibility: {
        kind: "HiddenInterval",
        startsAtFraction: 1 / 3,
        endsAtFraction: 2 / 3,
      },
      mustProgressDuringSlowBackpressure: false,
    },
    ...Array.from(
      { length: 7 },
      (_, index): BenchmarkSessionScenario => ({
        sessionId: `r0-06-session-background-${index + 1}` as SessionId,
        role: "Background",
        payloadMarker: index + 3,
        sourcePayloadBytesPerSecond: 64 * 1024,
        consumerWireBytesPerSecond: 512 * 1024,
        visibility: alwaysVisible,
        mustProgressDuringSlowBackpressure: true,
      }),
    ),
  ],
});

export const targetFrameCount = (
  session: BenchmarkSessionScenario,
  scenario: R006Scenario,
): number => {
  const frames =
    (session.sourcePayloadBytesPerSecond * scenario.durationSeconds) / scenario.framePayloadBytes;
  if (!Number.isInteger(frames)) {
    throw new Error(`R0-06 fixed load does not produce whole frames for ${session.sessionId}`);
  }
  return frames;
};
