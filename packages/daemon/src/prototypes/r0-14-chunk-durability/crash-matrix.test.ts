// R0-14 — RT-T-23 / RT-T-24 崩溃矩阵。写入方是真实子进程，在 RT-T-23
// （chunk checksum / 文件 fsync / rename / 目录 fsync / SQLite index +
// cursor commit / publish）与 RT-T-24（content checksum / fsync / rename /
// 目录 fsync / Prepared commit / PTY write / Dispatched commit）的每个边界
// 被 SIGKILL；Reconciliation 与重发在新进程执行；断言由本独立 orchestrator
// 经公开 seam 完成。核心断言：publishedButUnrecoverableFrameCount = 0、
// cursor 内 missingByteCount = 0、无静默缺口、绝不自动重放。
//
// 边界与期望形态共享 driver.ts 的 JOURNAL_BOUNDARIES / INTENT_BOUNDARIES
// 一张表——新增边界只改 driver.ts 一处。

import { describe, expect, it } from "vitest";
import {
  allIntentChecksPass,
  allJournalChecksPass,
  INTENT_BOUNDARIES,
  JOURNAL_BOUNDARIES,
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

  for (const boundary of JOURNAL_BOUNDARIES) {
    it.concurrent(
      `crash ${boundary.point}`,
      async () => {
        const e = await runJournalScenario({ crashPoint: boundary.point });
        expect(allJournalChecksPass(e), JSON.stringify(e.checks)).toBe(true);

        if (boundary.expectation === "orphan-adopted") {
          // rename 完成、index tx 未提交：完整文件被校验后接纳（RT-STO-03）。
          expect(e.reconcileReport.adoptedOrphans).toEqual([
            { sessionId: "ses-crash", generation: 1, seq: 2 },
          ]);
        }
        if (boundary.expectation === "temp-isolated") {
          // rename 前崩溃：临时残骸被隔离，绝不进索引（RT-STO-03）。
          expect(e.reconcileReport.isolatedOrphans).toHaveLength(1);
          expect(e.reconcileReport.adoptedOrphans).toEqual([]);
        }
        if (boundary.expectation === "index-committed") {
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

  for (const boundary of INTENT_BOUNDARIES) {
    it.concurrent(
      `crash ${boundary.point}`,
      async () => {
        const e = await runIntentScenario({ crashPoint: boundary.point });
        expect(allIntentChecksPass(e), JSON.stringify(e.checks)).toBe(true);
        // RT-T-24：结果只可能是原成功 / 明确失败 / Uncertain；绝不自动重放。
        expect(e.redispatchResult.status).toBe(boundary.outcome);
        expect(e.ptyWriteCount).toBe(boundary.expectedPtyWrites);
      },
      TIMEOUT,
    );
  }
});
