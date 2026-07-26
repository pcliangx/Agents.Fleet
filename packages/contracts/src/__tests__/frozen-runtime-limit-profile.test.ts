// S1 — frozen RuntimeLimitProfile integrity (RT-LIMIT-01, issue #15 / R0-16).
//
// The independent sources of truth are the spec (RT-TASK-01 bounds, RT-PERF-03
// reference scrollback) and the R0-06 measured prototype caps — never the
// frozen constant recomputed on itself.

import { describe, expect, it } from "vitest";
import { FROZEN_PLATFORM_MATRIX } from "../frozen-platform-matrix.js";
import {
  FROZEN_RUNTIME_LIMIT_PROFILE,
  RUNTIME_LIMIT_PROFILE_VERSION,
} from "../frozen-runtime-limit-profile.js";
import type { RuntimeLimitProfile, TerminalLimits } from "../limits.js";

const profileFields = Object.keys(FROZEN_RUNTIME_LIMIT_PROFILE).filter(
  (k): k is Exclude<keyof RuntimeLimitProfile, "profileVersion" | "terminal"> =>
    k !== "profileVersion" && k !== "terminal",
);

describe("FROZEN_RUNTIME_LIMIT_PROFILE (RT-LIMIT-01)", () => {
  it("profileVersion is 1 and the constant agrees", () => {
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.profileVersion).toBe(1);
    expect(RUNTIME_LIMIT_PROFILE_VERSION).toBe(1);
  });

  it("every limit field is a positive safe integer — no placeholder survives", () => {
    for (const field of profileFields) {
      const value = FROZEN_RUNTIME_LIMIT_PROFILE[field];
      expect(Number.isSafeInteger(value), `${field} = ${value}`).toBe(true);
      expect(value, `${field} = ${value}`).toBeGreaterThan(0);
    }
    for (const [field, value] of Object.entries(FROZEN_RUNTIME_LIMIT_PROFILE.terminal) as [
      keyof TerminalLimits,
      number,
    ][]) {
      expect(Number.isSafeInteger(value), `terminal.${field} = ${value}`).toBe(true);
      expect(value, `terminal.${field} = ${value}`).toBeGreaterThan(0);
    }
  });

  it("freezes the spec-derived bounds exactly (RT-TASK-01)", () => {
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.taskFieldBytes).toBe(512 * 1024);
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.taskSpecBytes).toBe(1024 * 1024);
  });

  it("freezes the R0-06 measured attachment-queue caps", () => {
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes).toBe(1_048_576);
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueFrames).toBe(32);
  });

  it("terminal scrollback covers the RT-PERF-03 reference load", () => {
    expect(FROZEN_RUNTIME_LIMIT_PROFILE.terminal.scrollbackLines).toBeGreaterThanOrEqual(10_000);
  });

  it("cross-field invariants hold", () => {
    const p = FROZEN_RUNTIME_LIMIT_PROFILE;
    // a spec field can never exceed the whole spec (RT-TASK-01)
    expect(p.taskFieldBytes).toBeLessThanOrEqual(p.taskSpecBytes);
    // a start command must be able to carry a full Task spec
    expect(p.commandPayloadBytes).toBeGreaterThanOrEqual(p.taskSpecBytes);
    // the NDJSON envelope wraps the payload
    expect(p.controlLineBytes).toBeGreaterThanOrEqual(p.commandPayloadBytes);
    // an attachment queue must hold at least one maximum frame
    expect(p.attachmentQueueBytes).toBeGreaterThanOrEqual(p.streamFramePayloadBytes);
    // terminal input staging never exceeds the durable Input Intent bound
    expect(p.terminal.pendingInputBytes).toBeLessThanOrEqual(p.inputIntentBytes);
  });

  it("is wired into the frozen platform matrix (RT-DIST-08 / RT-LIMIT-03)", () => {
    expect(FROZEN_PLATFORM_MATRIX.runtimeLimitProfileVersion).toBe(RUNTIME_LIMIT_PROFILE_VERSION);
  });
});
