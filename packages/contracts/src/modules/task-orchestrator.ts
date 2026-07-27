// RT-MOD-02 / RT-SCHED-01..06 — Task Orchestrator public scheduling seam.

import type { AttemptStatus } from "../lifecycle/attempt.js";
import type { LaunchSpec } from "./agent-adapter.js";

export interface PreparedLaunch {
  readonly kind: "prepared";
  readonly attemptId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly agentId: string;
  readonly slotLeaseId: string;
  readonly launchNonce: string;
  readonly plannedSessionId: string;
  readonly launchSpec: LaunchSpec;
}

export type ScheduleNextResult =
  | PreparedLaunch
  | { readonly kind: "idle" }
  | { readonly kind: "blocked"; readonly reason: "agent-slot-unavailable" };

export interface StopSessionImpact {
  readonly sessionId: string;
  readonly generation: number;
}

export interface StopCommandImpact {
  readonly commandType: "RequestAttemptStop" | "CancelTask";
  readonly sideEffectClass: "reversible" | "destructive";
  readonly taskId: string;
  readonly taskStateVersion: number;
  readonly attemptId: string | null;
  readonly attemptStatus: AttemptStatus | null;
  readonly attemptStateVersion: number | null;
  readonly aliveSessions: readonly StopSessionImpact[];
  readonly gitCleanup: false;
  readonly worktreeChangesMayRemain: true;
}

export interface StopCommandResult {
  readonly taskId: string;
  readonly taskLifecycle: "Runnable" | "Cancelled";
  readonly taskStateVersion: number;
  readonly attemptId: string | null;
  readonly attemptStatus: AttemptStatus | null;
  readonly attemptStateVersion: number | null;
  readonly stopRequestedSessionIds: readonly string[];
  readonly gitCleanup: false;
}

export interface TaskOrchestrator {
  scheduleNext(): Promise<ScheduleNextResult>;
  previewRequestAttemptStop(attemptId: string): StopCommandImpact;
  previewCancelTask(taskId: string): StopCommandImpact;
  requestAttemptStop(attemptId: string): StopCommandResult;
  cancelTask(taskId: string): StopCommandResult;
  stopSessions(sessionIds: readonly string[]): Promise<void>;
}
