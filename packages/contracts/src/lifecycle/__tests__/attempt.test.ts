import { describe, expect, it } from "vitest";
import {
  ATTEMPT_ALL_STATES,
  ATTEMPT_TERMINAL_STATES,
  ATTEMPT_TRANSITIONS,
  allowedNext,
  canTransition,
  isTerminalAttempt,
} from "../attempt.js";

describe("RT-STATE-18 AttemptStatus", () => {
  it("table keys ⇄ AttemptStatus members (no drift)", () => {
    expect(new Set(Object.keys(ATTEMPT_TRANSITIONS))).toEqual(new Set(ATTEMPT_ALL_STATES));
  });

  it.each([
    ["Queued", "Starting"],
    ["Queued", "Failed"],
    ["Starting", "Running"],
    ["Running", "Stopping"],
    ["Stopping", "Interrupted"],
  ] as const)("canTransition(%s → %s) === true", (f, t) => {
    expect(canTransition(f, t)).toBe(true);
  });

  it.each([
    ["Queued", "Running"], // must pass through Starting
    ["Running", "Queued"], // no return to queue
    ["Succeeded", "Running"], // terminal
    ["Failed", "Queued"], // terminal
  ] as const)("canTransition(%s → %s) === false", (f, t) => {
    expect(canTransition(f, t)).toBe(false);
  });

  it("terminal states have no outgoing edges (RT-STATE-05/09)", () => {
    for (const t of ATTEMPT_TERMINAL_STATES) {
      expect(ATTEMPT_TRANSITIONS[t]).toEqual([]);
      expect(isTerminalAttempt(t)).toBe(true);
    }
  });

  it("every non-terminal state has ≥1 outgoing edge", () => {
    for (const s of ATTEMPT_ALL_STATES) {
      if (!isTerminalAttempt(s)) expect(allowedNext(s).length).toBeGreaterThan(0);
    }
  });

  it("no terminal state can transition to anything (RT-STATE-09)", () => {
    for (const t of ATTEMPT_TERMINAL_STATES) {
      for (const s of ATTEMPT_ALL_STATES) expect(canTransition(t, s)).toBe(false);
    }
  });
});
