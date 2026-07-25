// RT-STATE-01 / RT-STATE-15 — TaskLifecycle. Cancelled is terminal; no rollback.

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type TaskLifecycle = "Draft" | "Runnable" | "Cancelled";

export const TASK_TRANSITIONS = {
  Draft: ["Runnable", "Cancelled"],
  Runnable: ["Cancelled"],
  Cancelled: [],
} as const satisfies TransitionTable<TaskLifecycle>;

export const TASK_TERMINAL_STATES = ["Cancelled"] as const satisfies readonly TaskLifecycle[];

export const canTransition = (from: TaskLifecycle, to: TaskLifecycle): boolean =>
  canTrans(TASK_TRANSITIONS, from, to);

export const allowedNext = (from: TaskLifecycle): readonly TaskLifecycle[] =>
  allNext(TASK_TRANSITIONS, from);

export const isTerminalTask = (s: TaskLifecycle): boolean =>
  (TASK_TERMINAL_STATES as readonly string[]).includes(s);
