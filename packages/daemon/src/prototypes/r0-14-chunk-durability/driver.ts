// R0-14 — 崩溃注入驱动（RT-T-23 / RT-T-24）。沿用 r0-07 模式：
// 写入方跑在真实子进程里，每个 durability 步骤之间设 barrier，逐边界
// SIGKILL，然后从**新进程**执行 Reconciliation，最后由本驱动（独立
// orchestrator）经公开 seam（ByteJournal / InputIntentStore）+ 子进程
// 留下的 durable 证据（published.log / pty-writes.log）断言。
// 被 vitest 崩溃矩阵与 evidence CLI 共用。
//
// 崩溃边界定义是数据驱动的（JOURNAL_BOUNDARIES / INTENT_BOUNDARIES），
// driver 的检查与 crash-matrix.test.ts 的断言共享同一张表——新增边界只改一处。

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteJournal } from "../../session-runtime/byte-journal.js";
import type {
  DispatchResult,
  InputIntentReconciliationReport,
} from "../../session-runtime/input-intent-store.js";
import type { StoreReconciliationReport } from "../../session-runtime/store-reconciliation.js";
import { openSessionStoreDb } from "../../session-runtime/store-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const JOURNAL_CHILD = join(here, "children", "journal-child.ts");
const JOURNAL_RECONCILE_CHILD = join(here, "children", "journal-reconcile-child.ts");
const INTENT_CHILD = join(here, "children", "intent-child.ts");
const INTENT_RECONCILE_CHILD = join(here, "children", "intent-reconcile-child.ts");

/**
 * RT-T-23：文件协议四步 + SQLite index + cursor commit + publish。
 * expectation 是崩溃瞬间的持久化形态，决定 Reconciliation 的期望动作：
 * - temp-isolated：rename 前崩溃，临时残骸被隔离（RT-STO-03）；
 * - orphan-adopted：rename 后、index 前崩溃，完整文件被校验后接纳；
 * - index-committed：index + cursor 已提交，无 orphan，frame durable 但未发布。
 */
export const JOURNAL_BOUNDARIES = [
  { point: "afterChecksum", expectation: "temp-isolated" },
  { point: "afterFileFsync", expectation: "temp-isolated" },
  { point: "afterRename", expectation: "orphan-adopted" },
  { point: "afterDirFsync", expectation: "orphan-adopted" },
  { point: "afterIndexTx", expectation: "index-committed" },
  { point: "beforePublish", expectation: "index-committed" },
] as const;
export type JournalCrashPoint = (typeof JOURNAL_BOUNDARIES)[number]["point"];
export type JournalExpectation = (typeof JOURNAL_BOUNDARIES)[number]["expectation"];

/**
 * RT-T-24：文件协议四步 + Prepared commit + PTY write + Dispatched commit。
 * outcome 是重发的期望结果（RT-T-24：只可能是原成功 / 明确失败 / Uncertain）；
 * expectedPtyWrites 是崩溃 + 重发全程的 PTY write 总次数（绝不自动重放）。
 */
export const INTENT_BOUNDARIES = [
  {
    point: "afterChecksum",
    outcome: "Dispatched",
    orphanIsolated: true,
    expectedPtyWrites: 1,
  },
  {
    point: "afterFileFsync",
    outcome: "Dispatched",
    orphanIsolated: true,
    expectedPtyWrites: 1,
  },
  {
    point: "afterRename",
    outcome: "Dispatched",
    orphanIsolated: true,
    expectedPtyWrites: 1,
  },
  {
    point: "afterDirFsync",
    outcome: "Dispatched",
    orphanIsolated: true,
    expectedPtyWrites: 1,
  },
  {
    point: "afterPreparedTx",
    outcome: "Uncertain",
    orphanIsolated: false,
    expectedPtyWrites: 0,
  },
  {
    point: "afterPtyWrite",
    outcome: "Uncertain",
    orphanIsolated: false,
    expectedPtyWrites: 1,
  },
  {
    point: "afterDispatchedTx",
    outcome: "Dispatched",
    orphanIsolated: false,
    expectedPtyWrites: 1,
  },
] as const;
export type IntentCrashPoint = (typeof INTENT_BOUNDARIES)[number]["point"];

export const JOURNAL_CRASH_POINTS: readonly JournalCrashPoint[] = JOURNAL_BOUNDARIES.map(
  (b) => b.point,
);
export const INTENT_CRASH_POINTS: readonly IntentCrashPoint[] = INTENT_BOUNDARIES.map(
  (b) => b.point,
);

const journalBoundary = (point: JournalCrashPoint) =>
  JOURNAL_BOUNDARIES.find((b) => b.point === point) ??
  (() => {
    throw new Error(`unknown journal crash point ${point}`);
  })();
const intentBoundary = (point: IntentCrashPoint) =>
  INTENT_BOUNDARIES.find((b) => b.point === point) ??
  (() => {
    throw new Error(`unknown intent crash point ${point}`);
  })();

/** 独立已知字节 fixture（含 NUL、invalid UTF-8、跨字节 multibyte）。 */
export const JOURNAL_FIXTURES: readonly { seq: number; bytes: Uint8Array }[] = [
  { seq: 1, bytes: new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xfe]) },
  { seq: 2, bytes: new TextEncoder().encode("frame-2 中文🙂 split\r\n") },
  { seq: 3, bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x0a]) },
];
export const INTENT_FIXTURE = new Uint8Array([0x67, 0x69, 0x74, 0x20, 0x73, 0x74, 0x0d, 0x00]);

/** 崩溃武装在第 2 个 frame 上：第 1 个已完整发布，第 3 个从未到达。 */
export const CRASH_ON_SEQ = 2;

/** Resolve tsx's ESM loader (devDependency, no new deps) for in-process TS children. */
export const resolveTsxLoader = (): string => {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("tsx not found — run pnpm install");
};

interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

const runChild = (script: string, configPath: string, killAfterMs = 60_000): Promise<ChildExit> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", resolveTsxLoader(), script, configPath], {
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child ${script} timed out\n${stderr}`));
    }, killAfterMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      if (stderr && code !== 0 && signal === null) {
        reject(new Error(`child ${script} exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** 子进程留下的 durable 证据日志（一行一条），不存在视为空。 */
const readDurableLogLines = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];

// ---------------------------------------------------------------------------
// RT-T-23 — chunk durability crash matrix
// ---------------------------------------------------------------------------

export interface JournalScenarioInput {
  readonly crashPoint: JournalCrashPoint | null;
}

export interface JournalScenarioChecks {
  readonly writerDiedAtArmedPoint: boolean;
  /** RT-PERF-05：每个已发布 frame 都能从 store 逐字节恢复。 */
  readonly publishedButUnrecoverableFrameCountZero: boolean;
  /** RT-PERF-05：cursor 覆盖范围内每个 seq 都逐字节可读。 */
  readonly missingByteCountZero: boolean;
  /** 无静默缺口：无 dataGap、无残留临时文件。 */
  readonly noSilentGap: boolean;
  /** 收敛：Reconciliation 后全部 frame 都已发布且 cursor 覆盖到末尾。 */
  readonly convergedAllFramesPublished: boolean;
}

export interface JournalScenarioEvidence {
  readonly crashPoint: JournalCrashPoint | null;
  readonly writerExit: ChildExit;
  readonly crashedAtMarker: string | null;
  readonly reconcileReport: StoreReconciliationReport;
  readonly publishedSeqs: readonly number[];
  readonly finalCursor: number;
  readonly recoveredFrameHex: readonly string[];
  readonly leftoverTempFiles: readonly string[];
  readonly checks: JournalScenarioChecks;
}

export const runJournalScenario = async (
  input: JournalScenarioInput,
  keepDir = false,
): Promise<JournalScenarioEvidence> => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-14-journal-scenario-"));
  const stream = { sessionId: "ses-crash", generation: 1 } as const;
  try {
    // --- phase 1: 注定要崩的写入进程 ---
    const writerConfig = {
      workDir,
      ...stream,
      frames: JOURNAL_FIXTURES.map((f) => ({ seq: f.seq, bytesHex: toHex(f.bytes) })),
      crashPoint: input.crashPoint,
      crashOnSeq: CRASH_ON_SEQ,
    };
    const writerConfigPath = join(workDir, "journal-writer-config.json");
    writeFileSync(writerConfigPath, JSON.stringify(writerConfig));
    const writerExit = await runChild(JOURNAL_CHILD, writerConfigPath);

    // --- phase 2: 新进程 Reconciliation + 续写余下 frame ---
    const reconcileConfig = {
      workDir,
      ...stream,
      resumeFrames: JOURNAL_FIXTURES.filter((f) => f.seq >= CRASH_ON_SEQ).map((f) => ({
        seq: f.seq,
        bytesHex: toHex(f.bytes),
      })),
    };
    const reconcileConfigPath = join(workDir, "journal-reconcile-config.json");
    writeFileSync(reconcileConfigPath, JSON.stringify(reconcileConfig));
    await runChild(JOURNAL_RECONCILE_CHILD, reconcileConfigPath);

    // --- phase 3: 独立断言（本进程重开 store，只经公开 seam） ---
    const outcome = JSON.parse(readFileSync(join(workDir, "reconcile-outcome.json"), "utf8")) as {
      report: StoreReconciliationReport;
    };
    const publishedSeqs = readDurableLogLines(join(workDir, "published.log")).map(Number);
    const crashedAtMarker = readdirSync(workDir).find((f) => f.startsWith("crashed-at-")) ?? null;

    const db = openSessionStoreDb(join(workDir, "session-store.db"));
    try {
      const journal = new ByteJournal({ storeDir: workDir, db });
      const cursor = journal.durableCursor(stream);

      let publishedButUnrecoverable = 0;
      for (const seq of new Set(publishedSeqs)) {
        const expected = JOURNAL_FIXTURES.find((f) => f.seq === seq);
        const read = seq <= cursor ? journal.readFrame({ ...stream, seq }) : null;
        if (!expected || !read || toHex(read) !== toHex(expected.bytes)) {
          publishedButUnrecoverable += 1;
        }
      }

      let missingBytes = 0;
      const recoveredFrameHex: string[] = [];
      for (let seq = 1; seq <= cursor; seq += 1) {
        const expected = JOURNAL_FIXTURES.find((f) => f.seq === seq);
        const read = journal.readFrame({ ...stream, seq });
        if (!expected || !read) {
          missingBytes += expected?.bytes.byteLength ?? 1;
        } else {
          recoveredFrameHex.push(toHex(read));
          if (toHex(read) !== toHex(expected.bytes)) missingBytes += expected.bytes.byteLength;
        }
      }

      const chunksDir = join(workDir, "chunks", stream.sessionId, String(stream.generation));
      const leftoverTempFiles = existsSync(chunksDir)
        ? readdirSync(chunksDir).filter((f) => f.startsWith(".tmp-"))
        : [];

      const expectedHex = JOURNAL_FIXTURES.map((f) => toHex(f.bytes));
      const checks: JournalScenarioChecks = {
        writerDiedAtArmedPoint:
          input.crashPoint === null
            ? writerExit.code === 0
            : writerExit.signal === "SIGKILL" &&
              crashedAtMarker === `crashed-at-${input.crashPoint}`,
        publishedButUnrecoverableFrameCountZero: publishedButUnrecoverable === 0,
        missingByteCountZero: missingBytes === 0,
        noSilentGap: outcome.report.dataGaps.length === 0 && leftoverTempFiles.length === 0,
        convergedAllFramesPublished:
          cursor === JOURNAL_FIXTURES.length &&
          [...new Set(publishedSeqs)].sort((a, b) => a - b).join(",") ===
            JOURNAL_FIXTURES.map((f) => f.seq).join(",") &&
          recoveredFrameHex.join("|") === expectedHex.join("|"),
      };

      return {
        crashPoint: input.crashPoint,
        writerExit,
        crashedAtMarker,
        reconcileReport: outcome.report,
        publishedSeqs,
        finalCursor: cursor,
        recoveredFrameHex,
        leftoverTempFiles,
        checks,
      };
    } finally {
      db.close();
    }
  } finally {
    if (!keepDir) rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// RT-T-24 — Input Intent crash matrix
// ---------------------------------------------------------------------------

export interface IntentScenarioInput {
  readonly crashPoint: IntentCrashPoint | null;
}

export interface IntentScenarioChecks {
  readonly writerDiedAtArmedPoint: boolean;
  /** 结果只可能是原成功 / 明确失败 / Uncertain（RT-T-24）。 */
  readonly resultIsOriginalSuccessOrExplicitFailureOrUncertain: boolean;
  /** 绝不自动重放：PTY write 总数 ≤ 1，且成功时恰好 1 次、内容逐字节一致。 */
  readonly neverRePlayedBytes: boolean;
  /** Uncertain 边界：Prepared 残留被 Reconciliation 显式标记。 */
  readonly uncertainMarkedWhenExpected: boolean;
  /** 无 record 的 object（含临时残骸）被隔离，不被当作输入来源。 */
  readonly orphanObjectsIsolated: boolean;
  /** 无 dataGap、无静默损坏。 */
  readonly noDataGap: boolean;
}

export interface IntentScenarioEvidence {
  readonly crashPoint: IntentCrashPoint | null;
  readonly writerExit: ChildExit;
  readonly crashedAtMarker: string | null;
  readonly firstResult: DispatchResult | null;
  readonly reconcileReport: InputIntentReconciliationReport;
  readonly redispatchResult: DispatchResult;
  readonly ptyWriteCount: number;
  readonly ptyWritesMatchFixture: boolean;
  readonly checks: IntentScenarioChecks;
}

export const runIntentScenario = async (
  input: IntentScenarioInput,
  keepDir = false,
): Promise<IntentScenarioEvidence> => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-14-intent-scenario-"));
  const commandId = "cmd-crash-1";
  try {
    // --- phase 1: 注定要崩的写入进程 ---
    const writerConfig = {
      workDir,
      commandId,
      sessionId: "ses-crash",
      generation: 1,
      bytesHex: toHex(INTENT_FIXTURE),
      crashPoint: input.crashPoint,
    };
    const writerConfigPath = join(workDir, "intent-writer-config.json");
    writeFileSync(writerConfigPath, JSON.stringify(writerConfig));
    const writerExit = await runChild(INTENT_CHILD, writerConfigPath);

    const firstResult = existsSync(join(workDir, "writer-outcome.json"))
      ? (
          JSON.parse(readFileSync(join(workDir, "writer-outcome.json"), "utf8")) as {
            result: DispatchResult;
          }
        ).result
      : null;

    // --- phase 2: 新进程 Reconciliation + 相同 commandId 重发 ---
    const reconcileConfig = {
      workDir,
      commandId,
      bytesHex: toHex(INTENT_FIXTURE),
      sessionId: "ses-crash",
      generation: 1,
    };
    const reconcileConfigPath = join(workDir, "intent-reconcile-config.json");
    writeFileSync(reconcileConfigPath, JSON.stringify(reconcileConfig));
    await runChild(INTENT_RECONCILE_CHILD, reconcileConfigPath);

    // --- phase 3: 独立断言 ---
    const outcome = JSON.parse(
      readFileSync(join(workDir, "intent-reconcile-outcome.json"), "utf8"),
    ) as {
      report: InputIntentReconciliationReport;
      redispatchResult: DispatchResult;
    };
    const crashedAtMarker = readdirSync(workDir).find((f) => f.startsWith("crashed-at-")) ?? null;
    const ptyWrites = readDurableLogLines(join(workDir, "pty-writes.log"));
    const fixtureHex = toHex(INTENT_FIXTURE);

    const boundary = input.crashPoint === null ? null : intentBoundary(input.crashPoint);
    const final = outcome.redispatchResult;

    const checks: IntentScenarioChecks = {
      writerDiedAtArmedPoint:
        input.crashPoint === null
          ? writerExit.code === 0
          : writerExit.signal === "SIGKILL" && crashedAtMarker === `crashed-at-${input.crashPoint}`,
      resultIsOriginalSuccessOrExplicitFailureOrUncertain: [
        "Dispatched",
        "Uncertain",
        "DataGap",
      ].includes(final.status),
      neverRePlayedBytes:
        ptyWrites.length <= 1 &&
        (final.status !== "Dispatched" ||
          (ptyWrites.length === 1 && ptyWrites[0] === fixtureHex)) &&
        (final.status !== "Uncertain" || ptyWrites.every((w) => w === fixtureHex)),
      uncertainMarkedWhenExpected:
        boundary?.outcome === "Uncertain"
          ? outcome.report.markedUncertain.includes(commandId) && final.status === "Uncertain"
          : !outcome.report.markedUncertain.includes(commandId),
      orphanObjectsIsolated:
        boundary?.orphanIsolated === true ? outcome.report.isolatedOrphans.length === 1 : true,
      noDataGap: outcome.report.dataGaps.length === 0,
    };

    return {
      crashPoint: input.crashPoint,
      writerExit,
      crashedAtMarker,
      firstResult,
      reconcileReport: outcome.report,
      redispatchResult: final,
      ptyWriteCount: ptyWrites.length,
      ptyWritesMatchFixture: ptyWrites.every((w) => w === fixtureHex),
      checks,
    };
  } finally {
    if (!keepDir) rmSync(workDir, { recursive: true, force: true });
  }
};

export const allJournalChecksPass = (e: JournalScenarioEvidence): boolean =>
  Object.values(e.checks).every(Boolean);

export const allIntentChecksPass = (e: IntentScenarioEvidence): boolean =>
  Object.values(e.checks).every(Boolean);

/** 子进程共用的 durable 证据写入：追加一行 + fsync（崩溃后可由 orchestrator 读取）。 */
export const appendDurableLogLine = (path: string, line: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export { intentBoundary, journalBoundary };
