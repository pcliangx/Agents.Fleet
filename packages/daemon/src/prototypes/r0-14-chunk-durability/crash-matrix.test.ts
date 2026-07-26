// R0-14 — RT-T-23 / RT-T-24 崩溃矩阵。写入方是真实子进程，在 RT-T-23
// （chunk checksum / 文件 fsync / rename / 目录 fsync / SQLite index +
// cursor commit / publish）与 RT-T-24（content checksum / fsync / rename /
// 目录 fsync / Prepared commit / PTY write / Dispatched commit）的每个边界
// 被 SIGKILL；Reconciliation 与重发在新进程执行；断言由本独立 orchestrator
// 经公开 seam 完成。核心断言：publishedButUnrecoverableFrameCount = 0、
// cursor 内 missingByteCount = 0、无静默缺口、绝不自动重放。

import { describe, expect, it } from "vitest";
import {
  allIntentChecksPass,
  allJournalChecksPass,
  INTENT_CRASH_POINTS,
  JOURNAL_CRASH_POINTS,
  runIntentScenario,
  runJournalScenario,
} from "./driver.js";

const TIMEOUT = 90_000;

describe("R0-14 chunk durability — RT-T-23 crash matrix", () => {
  it.concurrent(
    "baseline: no crash → all frames published and byte-recoverable",
    async () => {
      const e = await runJournalScenario({ crashPoint: null });
      expect(allJournalChecksPass(e), JSON.stringify(e.checks)).toBe(true);
      expect(e.finalCursor).toBe(3);
    },
    TIMEOUT,
  );

  for (const crashPoint of JOURNAL_CRASH_POINTS) {
    it.concurrent(
      `crash ${crashPoint}`,
      async () => {
        const e = await runJournalScenario({ crashPoint });
        expect(allJournalChecksPass(e), JSON.stringify(e.checks)).toBe(true);

        if (crashPoint === "afterRename" || crashPoint === "afterDirFsync") {
          // rename 完成、index tx 未提交：完整文件被校验后接纳（RT-STO-03）。
          expect(e.reconcileReport.adoptedOrphans).toEqual([
            { sessionId: "ses-crash", generation: 1, seq: 2 },
          ]);
        }
        if (crashPoint === "afterChecksum" || crashPoint === "afterFileFsync") {
          // rename 前崩溃：临时残骸被隔离，绝不进索引（RT-STO-03）。
          expect(e.reconcileReport.isolatedOrphans).toHaveLength(1);
          expect(e.reconcileReport.adoptedOrphans).toEqual([]);
        }
        if (crashPoint === "afterIndexTx" || crashPoint === "beforePublish") {
          // index + cursor 已提交：无 orphan，frame 2 durable 但崩溃前未发布。
          expect(e.reconcileReport.adoptedOrphans).toEqual([]);
          expect(e.reconcileReport.isolatedOrphans).toEqual([]);
        }
      },
      TIMEOUT,
    );
  }
});

describe("R0-14 Input Intent — RT-T-24 crash matrix", () => {
  it.concurrent(
    "baseline: no crash → Dispatched, exactly one PTY write",
    async () => {
      const e = await runIntentScenario({ crashPoint: null });
      expect(allIntentChecksPass(e), JSON.stringify(e.checks)).toBe(true);
      expect(e.firstResult?.status).toBe("Dispatched");
      expect(e.redispatchResult.status).toBe("Dispatched");
      expect(e.ptyWriteCount).toBe(1);
    },
    TIMEOUT,
  );

  for (const crashPoint of INTENT_CRASH_POINTS) {
    it.concurrent(
      `crash ${crashPoint}`,
      async () => {
        const e = await runIntentScenario({ crashPoint });
        expect(allIntentChecksPass(e), JSON.stringify(e.checks)).toBe(true);

        if (crashPoint === "afterPreparedTx") {
          // Prepared 已提交、PTY 从未写入 → Uncertain，绝不重放（RT-INPUT-03）。
          expect(e.redispatchResult.status).toBe("Uncertain");
          expect(e.ptyWriteCount).toBe(0);
        }
        if (crashPoint === "afterPtyWrite") {
          // PTY 已写入、Dispatched 未提交 → Uncertain，第二次 write 绝不发生。
          expect(e.redispatchResult.status).toBe("Uncertain");
          expect(e.ptyWriteCount).toBe(1);
        }
        if (crashPoint === "afterDispatchedTx") {
          // Dispatched 已提交 → 重发返回原结果，不重复写 PTY（RT-INPUT-04）。
          expect(e.redispatchResult.status).toBe("Dispatched");
          expect(e.ptyWriteCount).toBe(1);
        }
        if (
          crashPoint === "afterChecksum" ||
          crashPoint === "afterFileFsync" ||
          crashPoint === "afterRename" ||
          crashPoint === "afterDirFsync"
        ) {
          // record 从未提交：命令可安全地作为首次执行完成（PTY 总共恰好一次）。
          expect(e.redispatchResult.status).toBe("Dispatched");
          expect(e.ptyWriteCount).toBe(1);
        }
      },
      TIMEOUT,
    );
  }
});
