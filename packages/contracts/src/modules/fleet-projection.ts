// RT-MOD-06 / RT-PROJ-01..03 — the Renderer-facing read model.
//
// Every independently rendered field carries its own provenance so the UI
// never upgrades an inferred Observation into authoritative lifecycle state.

import type { AttemptStatus } from "../lifecycle/attempt.js";
import type { TaskViewPhase, TaskViewStatus } from "../lifecycle/projection.js";
import type { TaskLifecycle } from "../lifecycle/task.js";

export interface ProjectionSource {
  readonly confidence: "authoritative" | "inferred";
  readonly attemptId: string | null;
  readonly observedAt: string;
}

export interface ProjectedField<T> {
  readonly value: T;
  readonly source: ProjectionSource;
}

/** Renderer-safe identity fields copied from the immutable Attempt Profile snapshot. */
export interface ProjectedAgentProfileSnapshot {
  readonly agentId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly model: string | null;
  readonly mode: string | null;
}

export interface AttemptProjectionSummary {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly stateVersion: number;
  readonly commandKind: "Start" | "Retry" | "Resume";
  readonly sourceAttemptId: string | null;
  readonly agentProfileSnapshot: ProjectedAgentProfileSnapshot | null;
  readonly sessionId: string | null;
  readonly worktreeId: string | null;
  readonly waitingReason: string | null;
  readonly terminalReason: string | null;
}

export interface RecentObservation {
  readonly type: string;
  readonly confidence: "authoritative" | "inferred";
  readonly attemptId: string | null;
  readonly observedAt: string;
}

export interface TaskProjection {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly taskLifecycle: ProjectedField<TaskLifecycle>;
  readonly taskView: {
    readonly status: ProjectedField<TaskViewStatus>;
    readonly phase: ProjectedField<TaskViewPhase>;
    readonly currentAttemptId: ProjectedField<string | null>;
    readonly currentAttemptStatus: ProjectedField<AttemptStatus | null>;
    readonly lastAttemptId: ProjectedField<string | null>;
    readonly lastAttemptStatus: ProjectedField<AttemptStatus | null>;
    readonly waitingReason: ProjectedField<string | null>;
    readonly terminalReason: ProjectedField<string | null>;
    readonly noFurtherAttempts: ProjectedField<boolean>;
    readonly cancellationRequested: ProjectedField<boolean>;
  };
  /** Explicit attention signal; the Renderer must not infer this from prose or colours. */
  readonly needsUserAction: ProjectedField<boolean>;
  readonly currentAttempt: AttemptProjectionSummary | null;
  readonly lastAttempt: AttemptProjectionSummary | null;
  readonly recentObservation: RecentObservation | null;
  readonly observedAt: string;
  readonly stateVersion: number;
  readonly freshness: "Fresh" | "Stale";
  readonly dataGap: boolean;
  readonly generatedAt: string;
}

export interface FleetProjectionView {
  readonly workspaceId: string;
  readonly tasks: readonly TaskProjection[];
  readonly stateVersion: number;
  readonly freshness: "Fresh" | "Stale";
  readonly dataGap: boolean;
  readonly generatedAt: string;
}

export interface FleetProjection {
  projectTask(taskId: string): TaskProjection;
  projectFleet(workspaceId: string): FleetProjectionView;
}
