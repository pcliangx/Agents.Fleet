// RT-STATE-02 / RT-STATE-05 / RT-STATE-18 — Attempt lifecycle.

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type AttemptStatus =
  | "Queued"
  | "Starting"
  | "Running"
  | "Waiting"
  | "Stopping"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "Interrupted"
  | "Uncertain";

// RT-STATE-18 — the authoritative transition table.
export const ATTEMPT_TRANSITIONS = {
  Queued: ["Starting", "Failed", "Cancelled"],
  Starting: ["Running", "Waiting", "Failed", "Cancelled", "Interrupted", "Uncertain"],
  Running: ["Waiting", "Stopping", "Succeeded", "Failed", "Interrupted", "Uncertain"],
  Waiting: ["Starting", "Running", "Stopping", "Succeeded", "Failed", "Interrupted", "Uncertain"],
  Stopping: ["Waiting", "Succeeded", "Failed", "Cancelled", "Interrupted", "Uncertain"],
  Succeeded: [],
  Failed: [],
  Cancelled: [],
  Interrupted: [],
  Uncertain: [],
} as const satisfies TransitionTable<AttemptStatus>;

// RT-STATE-05 — terminal states, never rewritable (RT-STATE-09).
export const ATTEMPT_TERMINAL_STATES = [
  "Succeeded",
  "Failed",
  "Cancelled",
  "Interrupted",
  "Uncertain",
] as const satisfies readonly AttemptStatus[];

export const ATTEMPT_ALL_STATES: readonly AttemptStatus[] = [
  "Queued",
  "Starting",
  "Running",
  "Waiting",
  "Stopping",
  "Succeeded",
  "Failed",
  "Cancelled",
  "Interrupted",
  "Uncertain",
];

export const canTransition = (from: AttemptStatus, to: AttemptStatus): boolean =>
  canTrans(ATTEMPT_TRANSITIONS, from, to);

export const allowedNext = (from: AttemptStatus): readonly AttemptStatus[] =>
  allNext(ATTEMPT_TRANSITIONS, from);

export const isTerminalAttempt = (s: AttemptStatus): boolean =>
  (ATTEMPT_TERMINAL_STATES as readonly string[]).includes(s);
