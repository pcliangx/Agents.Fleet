// RT-STATE-16 / RT-STATE-17 / RT-STATE-20 / RT-STATE-24 — pure TaskView projection.
// currentAttempt = the single non-terminal Attempt (or null); lastAttempt = the
// latest by sequence (may be terminal). The projection never stores a separate
// drift-prone status field.

import type { AttemptStatus } from "./attempt.js";
import type { TaskLifecycle } from "./task.js";

export type TaskViewStatus =
  | "Draft"
  | "Queued"
  | "Running"
  | "Waiting"
  | "Succeeded"
  | "Failed"
  | "Interrupted"
  | "Uncertain"
  | "Cancelled";

export type TaskViewPhase = "Starting" | "Stopping" | null;

export interface TaskView {
  readonly status: TaskViewStatus;
  readonly phase: TaskViewPhase;
  readonly currentAttemptStatus: AttemptStatus | null;
  readonly lastAttemptStatus: AttemptStatus | null;
  readonly noFurtherAttempts: boolean;
  readonly cancellationRequested: boolean;
}

export interface ProjectTaskViewInput {
  readonly taskLifecycle: TaskLifecycle;
  readonly currentAttempt: { readonly status: AttemptStatus } | null;
  readonly lastAttempt: { readonly status: AttemptStatus } | null;
}

const TERMINAL_ATTEMPT: ReadonlySet<string> = new Set([
  "Succeeded",
  "Failed",
  "Cancelled",
  "Interrupted",
  "Uncertain",
]);

const isTerminal = (s: AttemptStatus): boolean => TERMINAL_ATTEMPT.has(s);

export const projectTaskView = (input: ProjectTaskViewInput): TaskView => {
  const { taskLifecycle, currentAttempt, lastAttempt } = input;
  const lastAttemptStatus = lastAttempt?.status ?? null;

  // RT-STATE-24 — surface Starting/Stopping explicitly, don't hide behind Running/Waiting.
  const phase: TaskViewPhase =
    currentAttempt?.status === "Starting"
      ? "Starting"
      : currentAttempt?.status === "Stopping"
        ? "Stopping"
        : null;

  const currentAttemptStatus = currentAttempt?.status ?? null;

  // RT-STATE-17 — cancelled but a non-terminal attempt still running.
  const cancellationRequested = taskLifecycle === "Cancelled" && currentAttempt !== null;
  const noFurtherAttempts = cancellationRequested;

  // RT-STATE-16 — top-to-bottom precedence. A non-terminal attempt always wins.
  let status: TaskViewStatus;
  const cs = currentAttempt?.status;
  if (cs === "Queued") status = "Queued";
  else if (cs === "Starting" || cs === "Running") status = "Running";
  else if (cs === "Waiting" || cs === "Stopping") status = "Waiting";
  else if (taskLifecycle === "Cancelled" && currentAttempt === null) status = "Cancelled";
  else if (taskLifecycle === "Draft" && currentAttempt === null && lastAttempt === null)
    status = "Draft";
  else {
    const ls = lastAttemptStatus;
    if (taskLifecycle !== "Cancelled" && ls !== null) {
      status =
        ls === "Succeeded"
          ? "Succeeded"
          : ls === "Failed"
            ? "Failed"
            : ls === "Cancelled"
              ? "Cancelled"
              : ls === "Interrupted"
                ? "Interrupted"
                : ls === "Uncertain"
                  ? "Uncertain"
                  : "Draft";
    } else {
      status = "Draft";
    }
  }

  return {
    status,
    phase,
    currentAttemptStatus,
    lastAttemptStatus,
    noFurtherAttempts,
    cancellationRequested,
  };
};

// Re-exported for tests that want to assert "currentAttempt is the non-terminal one".
export const isTerminalAttemptStatus = isTerminal;
