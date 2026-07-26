// S4 — frozen performance budget integrity (RT-PERF-01..11, issue #15 / R0-16).
//
// Independent sources of truth: the spec's latency gates (RT-PERF-01/02/03/09)
// and the RT-PERF-08 fixed load definition — never the frozen constant
// recomputed on itself. The RSS / CPU / paint / lag targets are a-priori
// freeze values, to be validated on the matrix floor fixture in R4.

import { describe, expect, it } from "vitest";
import { FROZEN_PERFORMANCE_BUDGET } from "../frozen-performance-budget.js";
import { FROZEN_PLATFORM_MATRIX } from "../frozen-platform-matrix.js";
import { RUNTIME_LIMIT_PROFILE_VERSION } from "../frozen-runtime-limit-profile.js";

const classes = ["activeVisible", "activeHidden", "electronClosed"] as const;

describe("FROZEN_PERFORMANCE_BUDGET (RT-PERF)", () => {
  it("budgetVersion is 1 and references the frozen matrix + profile versions", () => {
    expect(FROZEN_PERFORMANCE_BUDGET.budgetVersion).toBe(1);
    expect(FROZEN_PERFORMANCE_BUDGET.matrixVersion).toBe(FROZEN_PLATFORM_MATRIX.matrixVersion);
    expect(FROZEN_PERFORMANCE_BUDGET.runtimeLimitProfileVersion).toBe(
      RUNTIME_LIMIT_PROFILE_VERSION,
    );
  });

  it("freezes the RT-PERF-08 fixed load exactly", () => {
    expect(FROZEN_PERFORMANCE_BUDGET.fixedLoad).toEqual({
      aliveSessions: 10,
      hotProducerBytesPerSecond: 5 * 1024 * 1024,
      durationSeconds: 60,
    });
  });

  it("freezes the spec latency gates verbatim (RT-PERF-01/02/03)", () => {
    expect(FROZEN_PERFORMANCE_BUDGET.inputLatencyMs).toEqual({ median: 75, p99: 300 });
    expect(FROZEN_PERFORMANCE_BUDGET.outputLatencyMs).toEqual({ p95: 100, p99: 300 });
    expect(FROZEN_PERFORMANCE_BUDGET.sessionRestoreMs).toEqual({ p95: 1000 });
  });

  it("freezes the RT-PERF-09 presentation gate per renderer path (WebGL2 and DOM)", () => {
    expect(FROZEN_PERFORMANCE_BUDGET.presentationMsPerRendererPath).toEqual({
      WebGL2: { p95: 150, p99: 500 },
      DOM: { p95: 150, p99: 500 },
    });
  });

  it("defines all three RT-PERF-10 load classes with non-negative metrics", () => {
    for (const name of classes) {
      const budget = FROZEN_PERFORMANCE_BUDGET.loadClasses[name];
      expect(budget, `load class ${name} missing`).toBeDefined();
      for (const [metric, value] of Object.entries(budget)) {
        if (value === null) continue;
        expect(Number.isFinite(value), `${name}.${metric}`).toBe(true);
        expect(value, `${name}.${metric} = ${value}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("electronClosed carries no Renderer or Main budget — those processes are gone", () => {
    const closed = FROZEN_PERFORMANCE_BUDGET.loadClasses.electronClosed;
    expect(closed.rendererRssBytes).toBe(0);
    expect(closed.mainRssBytes).toBe(0);
    expect(closed.rendererCpuPercent).toBe(0);
    expect(closed.mainCpuPercent).toBe(0);
    expect(closed.paintLatencyP95Ms).toBeNull();
  });

  it("every load class budgets Main CPU (RT-PERF-10 records Main alongside Renderer/Daemon)", () => {
    for (const name of classes) {
      const budget = FROZEN_PERFORMANCE_BUDGET.loadClasses[name];
      expect(budget.mainCpuPercent, `${name}.mainCpuPercent`).toBeGreaterThanOrEqual(0);
    }
    expect(FROZEN_PERFORMANCE_BUDGET.loadClasses.activeHidden.mainCpuPercent).toBeLessThanOrEqual(
      FROZEN_PERFORMANCE_BUDGET.loadClasses.activeVisible.mainCpuPercent,
    );
  });

  it("only the visible class budgets paint latency", () => {
    expect(FROZEN_PERFORMANCE_BUDGET.loadClasses.activeVisible.paintLatencyP95Ms).toBeGreaterThan(
      0,
    );
    expect(FROZEN_PERFORMANCE_BUDGET.loadClasses.activeHidden.paintLatencyP95Ms).toBeNull();
  });

  it("hidden sessions must actually save Renderer memory (RT-PERF-11 / RT-BP-06)", () => {
    const { activeVisible, activeHidden } = FROZEN_PERFORMANCE_BUDGET.loadClasses;
    expect(activeHidden.rendererRssBytes).toBeLessThan(activeVisible.rendererRssBytes);
    expect(activeHidden.rendererCpuPercent).toBeLessThan(activeVisible.rendererCpuPercent);
  });
});
