// RT-MOD-06 / RT-PROJ-01 — read-only Fleet Projection.

import type { DatabaseSync } from "node:sqlite";
import {
  type AttemptProjectionSummary,
  type FleetProjection as FleetProjectionContract,
  type FleetProjectionView,
  type ProjectionSource,
  type RecentObservation,
  type TaskProjection,
  TaskViewProjection,
} from "@agents-fleet/contracts";
import type { AttemptStatus, TaskLifecycle } from "../storage/task-store.js";
import { StoreError } from "../storage/task-store.js";

interface TaskRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly lifecycle: TaskLifecycle;
  readonly state_version: number;
  readonly updated_at: string;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly status: AttemptStatus;
  readonly state_version: number;
  readonly command_kind: "Start" | "Retry" | "Resume";
  readonly source_attempt_id: string | null;
  readonly profile_snapshot_json: string | null;
  readonly session_id: string | null;
  readonly session_count: number;
  readonly worktree_id: string | null;
  readonly waiting_reason: string | null;
  readonly failure_reason: string | null;
  readonly observed_at: string;
}

interface ObservationRow {
  readonly type: string;
  readonly confidence: "authoritative" | "inferred";
  readonly attempt_id: string | null;
  readonly observed_at: string;
  readonly timeline_seq: number;
}

interface CountRow {
  readonly count: number;
  readonly observed_at: string | null;
}

const agentProfileSnapshot = (
  attempt: AttemptRow,
): AttemptProjectionSummary["agentProfileSnapshot"] => {
  if (attempt.profile_snapshot_json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(attempt.profile_snapshot_json);
  } catch {
    throw new StoreError("DataIntegrityFailure", "Attempt Profile snapshot is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("DataIntegrityFailure", "Attempt Profile snapshot is invalid");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.agentId !== "string" ||
    snapshot.agentId.length === 0 ||
    typeof snapshot.profileId !== "string" ||
    snapshot.profileId.length === 0 ||
    !Number.isSafeInteger(snapshot.profileVersion) ||
    (snapshot.profileVersion as number) < 1 ||
    (snapshot.model !== null && typeof snapshot.model !== "string") ||
    (snapshot.mode !== null && typeof snapshot.mode !== "string")
  ) {
    throw new StoreError("DataIntegrityFailure", "Attempt Profile snapshot is invalid");
  }
  return {
    agentId: snapshot.agentId,
    profileId: snapshot.profileId,
    profileVersion: snapshot.profileVersion as number,
    model: snapshot.model,
    mode: snapshot.mode,
  } as AttemptProjectionSummary["agentProfileSnapshot"];
};

const attemptSummary = (attempt: AttemptRow): AttemptProjectionSummary => ({
  attemptId: attempt.attempt_id,
  status: attempt.status,
  stateVersion: attempt.state_version,
  commandKind: attempt.command_kind,
  sourceAttemptId: attempt.source_attempt_id,
  agentProfileSnapshot: agentProfileSnapshot(attempt),
  sessionId: attempt.session_id,
  worktreeId: attempt.worktree_id,
  waitingReason: attempt.waiting_reason,
  terminalReason: attempt.failure_reason,
});

export class FleetProjection implements FleetProjectionContract {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  projectFleet(workspaceId: string): FleetProjectionView {
    const rows = this.#db
      .prepare("SELECT task_id FROM tasks WHERE workspace_id = ? ORDER BY created_at, task_id")
      .all(workspaceId) as unknown as readonly { readonly task_id: string }[];
    const tasks = rows.map((row) => this.projectTask(row.task_id));
    return {
      workspaceId,
      tasks,
      stateVersion: tasks.reduce((version, task) => version + task.stateVersion, 0),
      freshness: "Fresh",
      dataGap: tasks.some((task) => task.dataGap),
      generatedAt: new Date(this.#now()).toISOString(),
    };
  }

  projectTask(taskId: string): TaskProjection {
    const task = this.#db
      .prepare(
        "SELECT task_id, workspace_id, lifecycle, state_version, updated_at FROM tasks WHERE task_id = ?",
      )
      .get(taskId) as TaskRow | undefined;
    if (task === undefined) throw new StoreError("NotFound", `no such task: ${taskId}`);

    const generatedAt = new Date(this.#now()).toISOString();
    const taskSource: ProjectionSource = {
      confidence: "authoritative",
      attemptId: null,
      observedAt: task.updated_at,
    };
    const attempts = this.#db
      .prepare(
        `SELECT a.attempt_id, a.status, a.state_version, a.command_kind,
                a.source_attempt_id, a.waiting_reason, a.failure_reason,
                (SELECT p.snapshot_json
                 FROM attempt_profile_snapshots p
                 WHERE p.attempt_id = a.attempt_id) AS profile_snapshot_json,
                (SELECT s.session_id
                 FROM sessions s
                 WHERE s.attempt_id = a.attempt_id
                 ORDER BY CASE s.role WHEN 'PrimaryAgent' THEN 0 ELSE 1 END, s.created_at DESC
                 LIMIT 1) AS session_id,
                (SELECT COUNT(*)
                 FROM sessions s
                 WHERE s.attempt_id = a.attempt_id) AS session_count,
                (SELECT b.worktree_id
                 FROM attempt_worktree_bindings b
                 WHERE b.attempt_id = a.attempt_id) AS worktree_id,
                COALESCE(
                  (SELECT e.observed_at
                   FROM domain_events e
                   WHERE e.attempt_id = a.attempt_id
                     AND e.confidence = 'authoritative'
                   ORDER BY e.timeline_seq DESC LIMIT 1),
                  a.created_at
                ) AS observed_at
         FROM attempts a
         WHERE a.task_id = ?
         ORDER BY a.created_seq DESC`,
      )
      .all(taskId) as unknown as readonly AttemptRow[];
    const lastAttemptRow = attempts[0] ?? null;
    const currentAttemptRow =
      attempts.find((attempt) => !TaskViewProjection.isTerminalAttemptStatus(attempt.status)) ??
      null;
    const lastAttempt = lastAttemptRow === null ? null : attemptSummary(lastAttemptRow);
    const currentAttempt = currentAttemptRow === null ? null : attemptSummary(currentAttemptRow);
    const observation = this.#db
      .prepare(
        `SELECT type, confidence, attempt_id, observed_at, timeline_seq
         FROM domain_events
         WHERE task_id = ?
         ORDER BY timeline_seq DESC
         LIMIT 1`,
      )
      .get(taskId) as ObservationRow | undefined;
    const recentObservation: RecentObservation | null =
      observation === undefined
        ? null
        : {
            type: observation.type,
            confidence: observation.confidence,
            attemptId: observation.attempt_id,
            observedAt: observation.observed_at,
          };
    const taskView = TaskViewProjection.projectTaskView({
      taskLifecycle: task.lifecycle,
      currentAttempt,
      lastAttempt,
    });
    const currentSource: ProjectionSource = {
      confidence: "authoritative",
      attemptId: currentAttempt?.attemptId ?? null,
      observedAt: currentAttemptRow?.observed_at ?? task.updated_at,
    };
    const lastSource: ProjectionSource = {
      confidence: "authoritative",
      attemptId: lastAttempt?.attemptId ?? null,
      observedAt: lastAttemptRow?.observed_at ?? task.updated_at,
    };
    const waitingReason = currentAttempt?.waitingReason ?? null;
    const terminalReason =
      currentAttempt === null && lastAttempt !== null ? lastAttempt.terminalReason : null;
    const statusSource =
      currentAttempt !== null
        ? currentSource
        : task.lifecycle === "Cancelled" || task.lifecycle === "Draft"
          ? taskSource
          : lastSource;
    const dataGap = this.#db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(observed_at) AS observed_at
         FROM (
           SELECT i.created_at AS observed_at
           FROM input_intents i
           JOIN sessions s ON s.session_id = i.session_id
           JOIN attempts a ON a.attempt_id = s.attempt_id
           WHERE a.task_id = ? AND i.data_gap = 1
           UNION ALL
           SELECT e.observed_at
           FROM domain_events e
           WHERE e.task_id = ? AND e.type = 'data-gap-detected'
         )`,
      )
      .get(taskId, taskId) as unknown as CountRow;
    const needsUserAction =
      currentAttempt?.status === "Waiting" ||
      (currentAttempt === null &&
        (lastAttempt?.status === "Failed" ||
          lastAttempt?.status === "Interrupted" ||
          lastAttempt?.status === "Uncertain"));
    const observedAt = [
      task.updated_at,
      ...attempts.map((attempt) => attempt.observed_at),
      ...(observation === undefined ? [] : [observation.observed_at]),
      ...(dataGap.observed_at === null ? [] : [dataGap.observed_at]),
    ].reduce((latest, candidate) => (candidate > latest ? candidate : latest));

    return {
      taskId: task.task_id,
      workspaceId: task.workspace_id,
      taskLifecycle: { value: task.lifecycle, source: taskSource },
      taskView: {
        status: { value: taskView.status, source: statusSource },
        phase: { value: taskView.phase, source: currentSource },
        currentAttemptId: { value: currentAttempt?.attemptId ?? null, source: currentSource },
        currentAttemptStatus: { value: taskView.currentAttemptStatus, source: currentSource },
        lastAttemptId: { value: lastAttempt?.attemptId ?? null, source: lastSource },
        lastAttemptStatus: { value: taskView.lastAttemptStatus, source: lastSource },
        waitingReason: { value: waitingReason, source: currentSource },
        terminalReason: { value: terminalReason, source: lastSource },
        noFurtherAttempts: { value: taskView.noFurtherAttempts, source: taskSource },
        cancellationRequested: { value: taskView.cancellationRequested, source: taskSource },
      },
      needsUserAction: { value: needsUserAction, source: statusSource },
      currentAttempt,
      lastAttempt,
      recentObservation,
      observedAt,
      stateVersion:
        task.state_version +
        attempts.reduce(
          (version, attempt) =>
            version +
            attempt.state_version +
            attempt.session_count +
            (attempt.profile_snapshot_json === null ? 0 : 1) +
            (attempt.worktree_id === null ? 0 : 1),
          0,
        ) +
        (observation?.timeline_seq ?? 0) +
        dataGap.count,
      freshness: "Fresh",
      dataGap: dataGap.count > 0,
      generatedAt,
    };
  }
}
