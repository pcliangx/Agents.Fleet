# R0-14 Chunk Durability + Input Intent 崩溃边界原型

> PROTOTYPE — throwaway evidence code, not the R1 Session Runtime.

本原型验证 ADR-0005 的「content object 先 durable、SQLite record 后提交」协议在
**每个持久化边界**崩溃后的可恢复性（RT-T-23 / RT-T-24）：

- chunk stream：临时 chunk → checksum → 文件 fsync → 原子 rename → 目录 fsync →
  SQLite 单事务（chunk index + 连续 Durable Stream Cursor）→ publish（RT-STO-02）。
- Input Intent：同一文件协议写 content object → SQLite Prepared record →
  PTY write → Dispatched record（RT-STO-11、RT-INPUT-01..04）。

被测 seam 实现位于 `packages/daemon/src/session-runtime/`（byte-journal、
store-reconciliation、input-intent-store、content-object-io、store-schema）。

Layout:

- `driver.ts` — 场景运行器（spawn 注定要崩的 writer 子进程 → 新进程
  Reconciliation + 续写/重发 → 独立 orchestrator 经公开 seam 断言）。
  核心断言：`publishedButUnrecoverableFrameCount = 0`、cursor 内
  `missingByteCount = 0`、无静默缺口、PTY write 总数 ≤ 1（绝不自动重放）。
- `children/journal-child.ts` / `children/journal-reconcile-child.ts` — chunk
  写入方与 Reconciliation 方真实子进程；publish 证据写入 `published.log`（含 fsync）。
- `children/intent-child.ts` / `children/intent-reconcile-child.ts` — Input
  Intent 写入方与 Reconciliation 方真实子进程。
- `children/durable-sink.ts` — 每次 write 追加 `pty-writes.log`（含 fsync）
  的 fake PTY sink；是「是否重放」的独立证据源。
- `crash-matrix.test.ts` — RT-T-23（基线 + 6 边界）与 RT-T-24（基线 + 7 边界）。
- `evidence.ts` — 写 `docs/probes/r0-14/evidence.json`。

注意：child runner 之间**不得**互相 import 带顶层 `await main()` 的模块
（import 副作用会执行对方 main）。

跑全矩阵并重新生成证据：

```sh
pnpm prototype:r0-14
```

跑测试：

```sh
pnpm vitest run packages/daemon/src/prototypes/r0-14-chunk-durability/
```
