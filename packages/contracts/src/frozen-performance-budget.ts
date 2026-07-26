// RT-PERF — frozen R0 performance budget (budgetVersion 1).
//
// The quantitative budgets RT-PERF-10 requires R0 to freeze: latency gates,
// the RT-PERF-08 fixed load, and per-load-class resource budgets for the three
// load classes (active/visible, active/hidden, Electron closed). Bound to the
// frozen matrix (v2) and limit profile (v1) — per RT-LIMIT-03 and RT-DIST-08,
// a change to either produces new versions and re-runs the fixtures.
//
// Latency gates and the fixed load are spec-verbatim (RT-PERF-01/02/03/08/09).
// The RSS / CPU / paint / lag targets are a-priori freeze values with
// rationale below — R4 validates them on the matrix floor fixture
// (M1 / 8 GiB); this Mac (M5 Pro / 48 GiB) is above the floor, and the R0-06
// fixed-load measurement (60 s, 408 MiB processed, ~19 MB RSS growth,
// event-loop p95 ≈ 11 ms) is the only calibration point so far.
//
// Details: docs/probes/r0-16-runtime-limit-profile.md.

export interface LoadClassBudget {
  readonly rendererRssBytes: number;
  readonly mainRssBytes: number;
  readonly daemonRssBytes: number;
  /** Percent of one core (100 = one fully busy core). */
  readonly rendererCpuPercent: number;
  readonly daemonCpuPercent: number;
  /** null where no surface is painted (hidden / Electron closed). */
  readonly paintLatencyP95Ms: number | null;
  /** Daemon read-PTY → chunk durable (RT-STO-02 committed) p95. */
  readonly durableLagP95Ms: number;
  /** attach → first Snapshot rendered and Lease requestable (RT-PERF-03 shape). */
  readonly snapshotLatencyP95Ms: number;
}

export interface PerformanceBudget {
  readonly budgetVersion: number;
  readonly matrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
  /** RT-PERF-08 fixed acceptance load. */
  readonly fixedLoad: {
    readonly aliveSessions: number;
    readonly hotProducerBytesPerSecond: number;
    readonly durationSeconds: number;
  };
  /** RT-PERF-01 — Renderer keydown → Daemon confirmed PTY write. */
  readonly inputLatencyMs: { readonly median: number; readonly p99: number };
  /** RT-PERF-02 — Daemon PTY read → Renderer frame applied. */
  readonly outputLatencyMs: { readonly p95: number; readonly p99: number };
  /** RT-PERF-03 — Session restore at 10,000-line scrollback. */
  readonly sessionRestoreMs: { readonly p95: number };
  /** RT-PERF-09 — Daemon PTY read → affected cell first presentation. */
  readonly presentationMs: { readonly p95: number; readonly p99: number };
  readonly loadClasses: {
    readonly activeVisible: LoadClassBudget;
    readonly activeHidden: LoadClassBudget;
    readonly electronClosed: LoadClassBudget;
  };
}

export const FROZEN_PERFORMANCE_BUDGET: PerformanceBudget = {
  budgetVersion: 1,
  matrixVersion: 2,
  runtimeLimitProfileVersion: 1,

  fixedLoad: {
    aliveSessions: 10,
    hotProducerBytesPerSecond: 5_242_880, // 5 MiB/s (RT-PERF-08)
    durationSeconds: 60,
  },

  inputLatencyMs: { median: 75, p99: 300 },
  outputLatencyMs: { p95: 100, p99: 300 },
  sessionRestoreMs: { p95: 1000 },
  presentationMs: { p95: 150, p99: 500 },

  loadClasses: {
    // 10 live terminals painting: Renderer at the profile memory cap, Daemon
    // with 10 PTY + chunk-store buffers. CPU budgets are per-core percentages
    // on the M1 floor; paint targets one 60 fps frame.
    activeVisible: {
      rendererRssBytes: 2_147_483_648, // = RuntimeLimitProfile.rendererMemoryBytes
      mainRssBytes: 536_870_912, // 512 MiB
      daemonRssBytes: 536_870_912, // 512 MiB — R0-06 fixed load grew RSS ~19 MB total
      rendererCpuPercent: 100,
      daemonCpuPercent: 100,
      paintLatencyP95Ms: 16,
      durableLagP95Ms: 250,
      snapshotLatencyP95Ms: 1000, // RT-PERF-03 gate
    },
    // 9 of 10 hidden: xterm / WebGL / DOM resources released, only durable
    // cursors kept (RT-BP-06) — the hidden class must cost measurably less.
    activeHidden: {
      rendererRssBytes: 1_073_741_824, // 1 GiB — half the visible budget
      mainRssBytes: 536_870_912,
      daemonRssBytes: 536_870_912,
      rendererCpuPercent: 25,
      daemonCpuPercent: 100,
      paintLatencyP95Ms: null,
      durableLagP95Ms: 250,
      snapshotLatencyP95Ms: 1000, // re-show meets RT-PERF-03 (RT-PERF-11)
    },
    // Electron quit: Sessions stay Alive in the Daemon (SESSION-1); no
    // Renderer or Main budget exists at all.
    electronClosed: {
      rendererRssBytes: 0,
      mainRssBytes: 0,
      daemonRssBytes: 536_870_912,
      rendererCpuPercent: 0,
      daemonCpuPercent: 100,
      paintLatencyP95Ms: null,
      durableLagP95Ms: 250,
      snapshotLatencyP95Ms: 1000,
    },
  },
};
