// RT-MOD-02 / RT-SCHED-01..06 — Task Orchestrator public scheduling seam.

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

export interface TaskOrchestrator {
  scheduleNext(): Promise<ScheduleNextResult>;
}
