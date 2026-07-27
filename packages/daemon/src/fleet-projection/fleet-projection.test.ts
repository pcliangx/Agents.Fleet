import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "../storage/agent-profile-store.js";
import { openDatabase } from "../storage/database.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { TaskStore } from "../storage/task-store.js";
import { FleetProjection } from "./fleet-projection.js";

describe("FleetProjection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects a new Draft task from authoritative persisted state", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const now = () => Date.parse("2026-07-28T01:02:03.000Z");
      const task = new TaskStore(opened.db, now).createTask({
        workspaceId: "ws_1",
        spec: { goal: "Implement the desktop bridge" },
      });

      const projection = new FleetProjection(opened.db, now).projectTask(task.taskId);

      expect(projection).toMatchObject({
        taskId: task.taskId,
        workspaceId: "ws_1",
        taskLifecycle: {
          value: "Draft",
          source: { confidence: "authoritative", attemptId: null },
        },
        taskView: {
          status: {
            value: "Draft",
            source: { confidence: "authoritative", attemptId: null },
          },
          currentAttemptId: {
            value: null,
            source: { confidence: "authoritative", attemptId: null },
          },
          lastAttemptId: {
            value: null,
            source: { confidence: "authoritative", attemptId: null },
          },
        },
        currentAttempt: null,
        lastAttempt: null,
        freshness: "Fresh",
        generatedAt: "2026-07-28T01:02:03.000Z",
      });
    } finally {
      opened.db.close();
    }
  });

  it("projects the same nonterminal Attempt as both current and last", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const now = () => Date.parse("2026-07-28T02:03:04.000Z");
      const store = new TaskStore(opened.db, now);
      const task = store.createTask({
        workspaceId: "ws_1",
        spec: { goal: "Attach to an Agent session" },
      });
      store.startTask(task.taskId);
      const attempt = store.listAttempts(task.taskId)[0];
      if (attempt === undefined) throw new Error("expected queued attempt");
      const profiles = new AgentProfileStore(opened.db, now);
      const profile = profiles.createProfile({
        agentId: "claude-code",
        model: "sonnet",
        permissionMode: "Balanced",
        secretRefs: [],
      });
      profiles.createAttemptSnapshot({
        attemptId: attempt.attemptId,
        profileId: profile.profileId,
        adapter: {
          agentId: "claude-code",
          capabilities: ["PermissionMapping"],
          permissionMappings: [
            {
              requestedMode: "Balanced",
              effectiveMode: "Balanced",
              launchArgumentsPreview: [],
              enforcedCapabilities: [],
              unsupportedControls: [],
              warnings: [],
            },
          ],
        },
      });
      opened.db
        .prepare(
          `INSERT INTO sessions
           (session_id, attempt_id, availability, role, completion_policy, generation,
            created_at, updated_at)
           VALUES ('se_1', ?, 'Alive', 'PrimaryAgent', 'BlocksAttemptCompletion', 1, ?, ?)`,
        )
        .run(attempt.attemptId, "2026-07-28T02:03:04.000Z", "2026-07-28T02:03:04.000Z");

      const projection = new FleetProjection(opened.db, now).projectTask(task.taskId);

      expect(projection).toMatchObject({
        taskLifecycle: { value: "Runnable" },
        taskView: {
          status: {
            value: "Queued",
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          phase: {
            value: null,
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          currentAttemptId: {
            value: attempt.attemptId,
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          currentAttemptStatus: {
            value: "Queued",
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          lastAttemptId: {
            value: attempt.attemptId,
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          lastAttemptStatus: {
            value: "Queued",
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
        },
        currentAttempt: {
          attemptId: attempt.attemptId,
          status: "Queued",
          stateVersion: 1,
          sessionId: "se_1",
          agentProfileSnapshot: {
            agentId: "claude-code",
            profileId: profile.profileId,
            profileVersion: 1,
            model: "sonnet",
            mode: null,
          },
          waitingReason: null,
          terminalReason: null,
        },
        lastAttempt: {
          attemptId: attempt.attemptId,
          status: "Queued",
        },
      });
    } finally {
      opened.db.close();
    }
  });

  it("keeps terminal state authoritative while exposing an inferred recent Observation", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const now = () => Date.parse("2026-07-28T03:04:05.000Z");
      const store = new TaskStore(opened.db, now);
      const task = store.createTask({
        workspaceId: "ws_1",
        spec: { goal: "Render terminal output" },
      });
      store.startTask(task.taskId);
      const attempt = store.listAttempts(task.taskId)[0];
      if (attempt === undefined) throw new Error("expected queued attempt");
      opened.db
        .prepare(
          "UPDATE attempts SET status = 'Failed', state_version = state_version + 1, failure_reason = 'AgentExited' WHERE attempt_id = ?",
        )
        .run(attempt.attemptId);
      opened.db
        .prepare(
          `INSERT INTO domain_events
           (event_id, schema_version, task_id, attempt_id, timeline_seq, type, source,
            confidence, payload_json, occurred_at, observed_at)
           VALUES ('ev_inferred', 1, ?, ?, 99, 'process-lost', 'reconciliation',
                   'inferred', '{}', ?, ?)`,
        )
        .run(
          task.taskId,
          attempt.attemptId,
          "2026-07-28T03:04:04.000Z",
          "2026-07-28T03:04:05.000Z",
        );

      const projection = new FleetProjection(opened.db, now).projectTask(task.taskId);

      expect(projection).toMatchObject({
        taskView: {
          status: {
            value: "Failed",
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
          currentAttemptId: { value: null },
          currentAttemptStatus: { value: null },
          lastAttemptId: { value: attempt.attemptId },
          lastAttemptStatus: { value: "Failed" },
          terminalReason: {
            value: "AgentExited",
            source: { confidence: "authoritative", attemptId: attempt.attemptId },
          },
        },
        currentAttempt: null,
        lastAttempt: {
          attemptId: attempt.attemptId,
          status: "Failed",
          terminalReason: "AgentExited",
        },
        recentObservation: {
          type: "process-lost",
          confidence: "inferred",
          attemptId: attempt.attemptId,
          observedAt: "2026-07-28T03:04:05.000Z",
        },
      });
    } finally {
      opened.db.close();
    }
  });

  it("attributes a terminal Task cancellation to Task lifecycle, not the last Attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const store = new TaskStore(opened.db);
      const task = store.createTask({ workspaceId: "ws_1", spec: { goal: "Cancel safely" } });
      store.startTask(task.taskId);
      store.cancelTask(task.taskId);
      const attempt = store.listAttempts(task.taskId)[0];
      if (attempt === undefined) throw new Error("expected cancelled Attempt");

      const projection = new FleetProjection(opened.db).projectTask(task.taskId);

      expect(projection.taskView.status).toMatchObject({
        value: "Cancelled",
        source: { confidence: "authoritative", attemptId: null },
      });
      expect(projection.taskView.lastAttemptStatus).toMatchObject({
        value: "Cancelled",
        source: { confidence: "authoritative", attemptId: attempt.attemptId },
      });
    } finally {
      opened.db.close();
    }
  });

  it("returns a workspace-scoped Fleet view in stable creation order", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      let clock = Date.parse("2026-07-28T04:00:00.000Z");
      const now = () => clock++;
      const store = new TaskStore(opened.db, now);
      const first = store.createTask({ workspaceId: "ws_1", spec: { goal: "First" } });
      const second = store.createTask({ workspaceId: "ws_1", spec: { goal: "Second" } });
      store.createTask({ workspaceId: "ws_other", spec: { goal: "Not in this Fleet" } });

      const projection = new FleetProjection(opened.db, now).projectFleet("ws_1");

      expect(projection.workspaceId).toBe("ws_1");
      expect(projection.tasks.map((task) => task.taskId)).toEqual([first.taskId, second.taskId]);
      expect(projection).toMatchObject({
        freshness: "Fresh",
        dataGap: false,
      });
    } finally {
      opened.db.close();
    }
  });

  it("advances the projection token when any independently rendered Attempt field changes", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const store = new TaskStore(opened.db);
      const task = store.createTask({ workspaceId: "ws_1", spec: { goal: "Track freshness" } });
      store.startTask(task.taskId);
      const projection = new FleetProjection(opened.db);
      const before = projection.projectTask(task.taskId);
      opened.db
        .prepare(
          "UPDATE attempts SET status = 'Starting', state_version = state_version + 1 WHERE task_id = ?",
        )
        .run(task.taskId);

      const after = projection.projectTask(task.taskId);

      expect(after.stateVersion).toBeGreaterThan(before.stateVersion);
    } finally {
      opened.db.close();
    }
  });

  it("advances the projection token when a recent Observation changes independently", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
    roots.push(root);
    const opened = openDatabase({
      path: join(root, "fleet.db"),
      migrations: ALL_MIGRATIONS,
    });
    if (opened.kind !== "ready") throw new Error(opened.reason);

    try {
      const store = new TaskStore(opened.db);
      const task = store.createTask({
        workspaceId: "ws_1",
        spec: { goal: "Track Observation freshness" },
      });
      const projection = new FleetProjection(opened.db);
      const before = projection.projectTask(task.taskId);
      opened.db
        .prepare(
          `INSERT INTO domain_events
           (event_id, schema_version, task_id, attempt_id, timeline_seq, type, source,
            confidence, payload_json, occurred_at, observed_at)
           VALUES ('ev_projection_token', 1, ?, NULL, 99, 'diagnostic', 'test',
                   'inferred', '{}', ?, ?)`,
        )
        .run(task.taskId, new Date().toISOString(), new Date().toISOString());

      const after = projection.projectTask(task.taskId);

      expect(after.stateVersion).toBeGreaterThan(before.stateVersion);
      expect(after.recentObservation?.type).toBe("diagnostic");
    } finally {
      opened.db.close();
    }
  });

  it.each([
    ["Queued", "Queued", null, true],
    ["Starting", "Running", "Starting", true],
    ["Running", "Running", null, true],
    ["Waiting", "Waiting", null, true],
    ["Stopping", "Waiting", "Stopping", true],
    ["Succeeded", "Succeeded", null, false],
    ["Failed", "Failed", null, false],
    ["Cancelled", "Cancelled", null, false],
    ["Interrupted", "Interrupted", null, false],
    ["Uncertain", "Uncertain", null, false],
  ] as const)(
    "projects Attempt %s as TaskView %s without merging phase or current identity",
    (attemptStatus, expectedStatus, expectedPhase, hasCurrentAttempt) => {
      const root = mkdtempSync(join(tmpdir(), "agents-fleet-projection-"));
      roots.push(root);
      const opened = openDatabase({
        path: join(root, "fleet.db"),
        migrations: ALL_MIGRATIONS,
      });
      if (opened.kind !== "ready") throw new Error(opened.reason);

      try {
        const store = new TaskStore(opened.db);
        const task = store.createTask({ workspaceId: "ws_1", spec: { goal: attemptStatus } });
        store.startTask(task.taskId);
        const attempt = store.listAttempts(task.taskId)[0];
        if (attempt === undefined) throw new Error("expected Attempt");
        opened.db
          .prepare("UPDATE attempts SET status = ? WHERE attempt_id = ?")
          .run(attemptStatus, attempt.attemptId);

        const projection = new FleetProjection(opened.db).projectTask(task.taskId);

        expect(projection.taskView.status).toMatchObject({
          value: expectedStatus,
          source: { confidence: "authoritative", attemptId: attempt.attemptId },
        });
        expect(projection.taskView.phase.value).toBe(expectedPhase);
        expect(projection.taskView.currentAttemptId.value).toBe(
          hasCurrentAttempt ? attempt.attemptId : null,
        );
        expect(projection.taskView.lastAttemptId.value).toBe(attempt.attemptId);
      } finally {
        opened.db.close();
      }
    },
  );
});
