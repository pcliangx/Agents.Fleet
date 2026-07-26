// S2 — Task store (RT-TASK-01/02/03, RT-STATE-15): bounded versioned Task
// specs, TaskLifecycle transitions, Queued Attempt atomically created on
// start, cancel ≠ delete.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../storage/database.js";
import { TASK_MIGRATIONS, TaskStore } from "../storage/task-store.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const makeStore = (): TaskStore => {
  dir = mkdtempSync(join(tmpdir(), "af-r101-task-"));
  const result = openDatabase({ path: join(dir, "fleet.db"), migrations: TASK_MIGRATIONS });
  if (result.kind !== "ready") throw new Error(`db not ready: ${result.kind}`);
  return new TaskStore(result.db);
};

const spec = (goal = "fix the bug"): { goal: string } => ({ goal });

describe("TaskStore.createTask (RT-TASK-01)", () => {
  it("creates a Draft task with taskSpecVersion 1", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec() });
    expect(task.lifecycle).toBe("Draft");
    expect(task.taskSpecVersion).toBe(1);
  });

  it("each field is bounded at 512 KiB and the whole spec at 1 MiB (limit / limit+1)", () => {
    const store = makeStore();
    expect(() =>
      store.createTask({ workspaceId: "ws1", spec: { goal: "x".repeat(512 * 1024) } }),
    ).not.toThrow();
    expect(() =>
      store.createTask({ workspaceId: "ws1", spec: { goal: "x".repeat(512 * 1024 + 1) } }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));
    const half = "x".repeat(512 * 1024);
    expect(() =>
      store.createTask({ workspaceId: "ws1", spec: { goal: half, context: `${half}y` } }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));
  });

  it("rejects an empty goal without writing anything", () => {
    const store = makeStore();
    expect(() => store.createTask({ workspaceId: "ws1", spec: { goal: "" } })).toThrowError(
      expect.objectContaining({ code: "InvalidRequest" }),
    );
    expect(store.listTasks("ws1")).toHaveLength(0);
  });

  it("updating the spec of a Draft bumps taskSpecVersion", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec("v1") });
    const updated = store.updateTaskSpec(task.taskId, spec("v2"));
    expect(updated.taskSpecVersion).toBe(2);
  });
});

describe("TaskStore lifecycle (RT-STATE-15, RT-TASK-02/03)", () => {
  it("start: Draft → Runnable and creates exactly one Queued Attempt in the same transaction", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec() });
    const started = store.startTask(task.taskId);
    expect(started.lifecycle).toBe("Runnable");
    const attempts = store.listAttempts(task.taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("Queued");
    // RT-TASK-02 — the attempt froze an immutable spec snapshot
    expect(attempts[0]?.taskSpecVersion).toBe(1);
    expect(attempts[0]?.specSnapshot).toEqual(spec());
  });

  it("the attempt snapshot is immutable against later spec edits", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec("before") });
    store.startTask(task.taskId);
    store.updateTaskSpec(task.taskId, spec("after"));
    const attempts = store.listAttempts(task.taskId);
    expect(attempts[0]?.specSnapshot).toEqual(spec("before"));
    expect(attempts[0]?.taskSpecVersion).toBe(1);
  });

  it("start is not idempotent on an already Runnable task", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec() });
    store.startTask(task.taskId);
    expect(() => store.startTask(task.taskId)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
  });

  it("cancel from Draft leaves no attempt; cancel from Runnable keeps history (RT-TASK-03)", () => {
    const store = makeStore();
    const draft = store.createTask({ workspaceId: "ws1", spec: spec("draft") });
    expect(store.cancelTask(draft.taskId).lifecycle).toBe("Cancelled");
    expect(store.listAttempts(draft.taskId)).toHaveLength(0);

    const running = store.createTask({ workspaceId: "ws1", spec: spec("running") });
    store.startTask(running.taskId);
    expect(store.cancelTask(running.taskId).lifecycle).toBe("Cancelled");
    expect(store.listAttempts(running.taskId)).toHaveLength(1);
  });

  it("illegal transitions fail with Conflict: Runnable→start again, Cancelled→anything", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec() });
    store.cancelTask(task.taskId);
    expect(() => store.startTask(task.taskId)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
    expect(() => store.cancelTask(task.taskId)).toThrowError(
      expect.objectContaining({ code: "Conflict" }),
    );
  });

  it("unknown task is NotFound", () => {
    const store = makeStore();
    expect(() => store.startTask("tk_missing")).toThrowError(
      expect.objectContaining({ code: "NotFound" }),
    );
  });

  it("every transition records a domain event (RT-EVENT-01/02)", () => {
    const store = makeStore();
    const task = store.createTask({ workspaceId: "ws1", spec: spec() });
    store.startTask(task.taskId);
    store.cancelTask(task.taskId);
    const events = store.listEvents(task.taskId);
    expect(events.map((e) => e.type)).toEqual([
      "task-created",
      "task-started",
      "attempt-queued",
      "task-cancelled",
    ]);
    expect(events.map((e) => e.timelineSeq)).toEqual([1, 2, 3, 4]);
    expect(events.every((e) => e.confidence === "authoritative")).toBe(true);
  });
});
