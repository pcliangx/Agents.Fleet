# R0-14 — Chunk durability + Input Intent 崩溃边界原型

> Branch: `r0-14-chunk-durability`。**本次实测**为以下契约提供协议层面的证据:
> RT-STO-02 / RT-STO-03 / RT-STO-08 / RT-STO-11(§8 chunk 与 Input Intent 持久化协议)、
> RT-ORDER-07(Durable Stream Cursor 连续性)、
> RT-INPUT-01..04(**partial**: 仅 durability 顺序(content object 先 durable → Prepared
> record → PTY write → Dispatched record)、崩溃窗口标 Uncertain 与相同 commandId 幂等
> 不重放子句; §6.5 InputIntent shape 的 `source` / `attachmentId` / `fencingToken`
> provenance 字段未实现, 见「边界与后续」)、
> RT-REC-10(§5 chunk 缺失 / checksum 失败的显式 dataGap)、
> RT-PERF-05(`publishedButUnrecoverableFrameCount = 0`、cursor 内 `missingByteCount = 0`)、
> RT-T-23 / RT-T-24(§13 崩溃矩阵验收)。
> Snapshot 安全 checkpoint(RT-ORDER-08 / RT-TERM-12)、StoragePressure 背压(RT-BP-03..07)、
> 真实 node-pty 写入(RT-TERM-08)、跨 Session 并发与 Runtime Limit Profile **未在本次覆盖**,
> 见「边界与后续」。
>
> 实测于 2026-07-26, macOS (Darwin 25.5.0, xnu-12377.121.10, RELEASE_ARM64_T6050) /
> Apple Silicon / node v22.17.1(pnpm devEngines) / node:sqlite(WAL + synchronous=FULL)。
> 方法: `driver.ts` 把写入方作为真实子进程 spawn(真实 SQLite、真实临时目录文件系统),
> 在 RT-T-23(chunk checksum / 文件 fsync / rename / 目录 fsync / SQLite index +
> cursor commit / publish)与 RT-T-24(content checksum / fsync / rename / 目录 fsync /
> Prepared commit / PTY write / Dispatched commit)的**每个边界**对其 SIGKILL, 随后从
> **新进程**执行 Reconciliation 并续写 / 以相同 commandId 重发; 断言由独立 orchestrator
> 执行(重开 store 经公开 seam 读取 + 子进程留下的 durable 证据 `published.log` /
> `pty-writes.log`)。证据: [`r0-14/evidence.json`](r0-14/evidence.json)。

## 结论

**15 个场景(chunk: 基线 + 6 崩溃点; Input Intent: 基线 + 7 崩溃点)全部满足
RT-T-23 / RT-T-24: 无已发布但不可恢复的 frame、无 cursor 跳跃、无静默缺口;
Input Intent 结果只可能是原成功 / 明确失败 / Uncertain, 绝不自动重放。**

- **实测直接支持**: 「临时文件 → checksum → 文件 fsync → 原子 rename → 目录 fsync →
  SQLite 单事务」方向在每个协议边界崩溃后都能收敛; rename 完成而 index 未提交的
  orphan 经校验接纳、rename 前的临时残骸隔离, 不产生 dataGap; cursor 严格连续
  (RT-ORDER-07), 已发布 frame 崩溃后逐字节可恢复(RT-PERF-05); Prepared 与
  Dispatched 之间崩溃标 Uncertain 且重试返回 Uncertain 不重放(RT-INPUT-03),
  Dispatched 后重试返回原结果不再写 PTY(RT-INPUT-04)。
- **推断(非本次实测)**: 「文件 fsync + rename + 目录 fsync 完成后内容即完整」
  依赖 APFS 的 fsync / rename 语义, 本次以 SIGKILL 模拟进程死亡, 未模拟整机断电;
  同一协议在 Host 重启(RT-REC-08)下的表现是推断(方向一致, R1 复核)。
  PTY 侧用 durable fake sink 记录 write 次数与内容; 真实 node-pty 的「owner 已接受」
  语义由 RT-TERM-08 的 ProcessSupervisor 兑现, 属推断。

## 协议实现要点(实测所基于的设计)

1. **content object 文件协议与 SQLite record 严格分步**(`content-object-io.ts` +
   `store-schema.ts`): 文件协议(写临时文件 → checksum → 文件 fsync → 原子 rename →
   目录 fsync)全部完成后, 才在**单个** BEGIN IMMEDIATE … COMMIT 中写 index / record
   并推进 cursor。崩溃要么落整个步骤, 要么完全回滚; 完成 rename 的文件即「完整且已
   fsync」, 这是 Reconciliation 能安全接纳 orphan 的依据。
2. **Durable Stream Cursor 只在 index 事务内按连续性推进**(`byte-journal.ts`):
   cursor = 仍存在连续 chunk index 的最大 seq, 绝不越过缺失 / 未索引 frame
   (RT-ORDER-07); 乱序到达的 chunk 先 durable 但不发布, 缺口补齐后一次推进。
   `publishable = seq ≤ durableCursor`, publish 严格位于事务提交之后(RT-STO-02/08)。
3. **读取只提供 cursor 覆盖的 frame, 失败显式化**(`byte-journal.ts`): seq 未被
   cursor 覆盖返回 null; cursor 覆盖但 index 缺失 / 文件缺失 / checksum 失败抛
   `DataIntegrityFailure`——不用空 bytes 或旧数据伪装(RT-STO-03、RT-REC-10)。
4. **Reconciliation 双向对账**(`store-reconciliation.ts`): 索引视角验证每条
   chunk index 的文件存在性与 checksum(失败 = 显式 dataGap, 保留索引与 cursor
   原状); 文件视角把无索引的最终文件校验后接纳进索引并按连续性推进 cursor,
   把 `.tmp-*` 残骸隔离到 quarantine(绝不进索引)。
5. **Input Intent 同一方向**(`input-intent-store.ts`): content object 先 durable,
   再 Prepared record, 此前绝不写 PTY(RT-STO-11、RT-INPUT-01); PTY owner 接受后
   才提交 Dispatched(RT-INPUT-02)。DB 只存 provenance、sha256 与 byteLength,
   原始 bytes 只存 content object(恢复源)。已有 record 的重发永不写 PTY:
   Dispatched → 原结果; Prepared / Uncertain → Uncertain; object 缺失 / 损坏 →
   DataGap(明确失败)。
6. **Reconciliation 把每个 Prepared(非 Dispatched)一律标 Uncertain**
   (`reconcileInputIntents`): 从幸存 record 无法判定 PTY write 是否发生
   (RT-INPUT-03); 无 record 的 object(含临时残骸)隔离回收, 绝不作为输入来源。

## 崩溃点 × 矩阵(实测, 15/15 PASS)

崩溃武装在第 2 个 frame / 唯一的 Input Intent 上。每个单元格为该场景的最终收敛形态。

### RT-T-23 — chunk durability

| 崩溃点(协议边界) | 崩溃瞬间持久化状态 | Reconciliation | 收敛形态 |
| --- | --- | --- | --- |
| 基线(无崩溃) | — | 无 orphan / 无 gap | cursor=3, 全 frame 已发布且逐字节可恢复 |
| afterChecksum | 临时文件(未 fsync) | 临时残骸**隔离** | 续写 seq 2..3, cursor=3, 无 dataGap |
| afterFileFsync | 临时文件(已 fsync) | 临时残骸**隔离** | 同上 |
| afterRename | 最终文件、无索引 | orphan **校验后接纳**, cursor 1→2 | 幂等重发 seq 2 + 续写 seq 3, cursor=3 |
| afterDirFsync | 最终文件、无索引 | orphan **校验后接纳**, cursor 1→2 | 同上 |
| afterIndexTx | index + cursor=2 已提交 | 无 orphan | frame 2 durable 但崩溃前未发布; 重发幂等, cursor=3 |
| beforePublish | index + cursor=2 已提交 | 无 orphan | 同上(publish 边界) |

全部满足: `publishedButUnrecoverableFrameCount = 0`(published.log 中每个 seq 均
≤ cursor 且逐字节读回)、cursor 内 `missingByteCount = 0`、无残留临时文件、无 dataGap。

### RT-T-24 — Input Intent

| 崩溃点(协议边界) | 崩溃瞬间持久化状态 | 重发结果 | PTY write 总次数 |
| --- | --- | --- | :-: |
| 基线(无崩溃) | Dispatched 已提交 | 原结果 Dispatched(RT-INPUT-04) | 1 |
| afterChecksum | 临时 object | object 隔离 → 全新 dispatch 成功 | 1 |
| afterFileFsync | 临时 object | 同上 | 1 |
| afterRename | 最终 object、无 record | orphan object 隔离 → 全新 dispatch 成功 | 1 |
| afterDirFsync | 最终 object、无 record | 同上 | 1 |
| afterPreparedTx | Prepared record、object 完整 | **Uncertain, 绝不重放**(RT-INPUT-03) | **0** |
| afterPtyWrite | Prepared record、PTY 已写 | **Uncertain, 第二次 write 绝不发生** | **1** |
| afterDispatchedTx | Dispatched 已提交 | 原结果 Dispatched, 不重复写 | 1 |

「record 从未提交」(前四个边界)时命令作为首次执行安全完成, PTY write 恰好一次;
「Prepared 已提交」起, 结果只可能是 Uncertain 或原成功, 绝不自动重放。

## 关键机制实测明细

### 发布门槛(RT-STO-02 / RT-STO-08 / RT-INV-09、RT-PERF-05)

- `appendFrame` 的返回在 index + cursor 事务提交**之后**; 行为测试实测 cursor 未覆盖时
  `publishable = false` 且 `readFrame` 返回 null(乱序 append seq 2 先到, cursor 保持 0,
  seq 1 补齐后 cursor 一次推进到 2, RT-ORDER-07 不跳 seq)。
- 崩溃矩阵实测: 每个进入 `published.log` 的 seq 在恢复后都 ≤ cursor 且逐字节一致
  (含 NUL、invalid UTF-8、跨字节 multibyte fixture); cursor 1..N 每个 seq 逐字节一致。

### orphan 双向对账(RT-STO-03)

- 有文件无索引: 行为测试 + 崩溃矩阵(afterRename / afterDirFsync)实测接纳,
  `adoptedOrphans = [{sessionId, generation, seq: 2}]`, bytes 逐字节可读回;
  orphan seq 2 而 seq 1 缺失时接纳但 cursor 不推进(不跳 seq)。
- rename 前残骸: 行为测试 + 崩溃矩阵(afterChecksum / afterFileFsync)实测隔离到
  quarantine, 不进索引、不影响 cursor。
- 有索引无文件 / checksum 失败: 行为测试实测 `dataGaps` 报告(含索引承诺的
  byteLength, 即 missingByteCount 口径), 读取抛 `DataIntegrityFailure`,
  cursor 与索引保留原状(RT-REC-10: 显式缺口, 不伪装)。

### Input Intent 崩溃窗口(RT-INPUT-01..04、RT-STO-11)

- record 先 PTY 后: 行为测试用公开注入 seam 在 afterPreparedTx 中断 dispatch,
  实测留下 Prepared 残骸且 PTY 0 写; 崩溃矩阵 afterPreparedTx 实测重发 Uncertain、
  `pty-writes.log` 为空。
- Uncertain 绝不重放: afterPtyWrite 实测重发 Uncertain 且 PTY write 总数保持 1
  (第一次 write 确实发生过——这正是必须 Uncertain 而非 Failed 的情形)。
- 幂等: 同 commandId 同 bytes 返回原结果(byteLength / inputIntentId 一致)不重复写;
  同 commandId 不同 bytes 返回 IdempotencyConflict 不写(行为测试)。
- object 缺失 / 损坏: 行为测试 + reconcile 实测标 dataGap, 重发返回
  DataGap(明确失败)且 PTY 0 写; `readContent` 抛 `DataIntegrityFailure`(RT-STO-11)。
- 无 record orphan object: 实测隔离后可作为全新命令正常 dispatch(此前从未有 record)。

## 证据与复现

- 被测 seam: [`packages/daemon/src/session-runtime/`](../../packages/daemon/src/session-runtime/)
  (`byte-journal.ts`、`store-reconciliation.ts`、`input-intent-store.ts`、
  `content-object-io.ts`、`store-schema.ts`, 真实 node:sqlite WAL + synchronous=FULL)。
- 崩溃注入驱动: [`packages/daemon/src/prototypes/r0-14-chunk-durability/`](../../packages/daemon/src/prototypes/r0-14-chunk-durability/README.md)
  (`driver.ts` + `children/` 真实子进程 + `evidence.ts`)。
- 证据: [`r0-14/evidence.json`](r0-14/evidence.json)(15 场景脱敏实测, 含每场景的
  reconcile 报告、published / pty-writes 计数、恢复字节 hex 与检查项)。
- 测试: `session-runtime/` 三个 seam 行为测试(22 例) +
  `prototypes/r0-14-chunk-durability/crash-matrix.test.ts`(15 例)。
- 复现: `pnpm prototype:r0-14`(重跑全矩阵并重新生成证据)与
  `pnpm vitest run packages/daemon/src/session-runtime/ packages/daemon/src/prototypes/r0-14-chunk-durability/`。

## 边界与后续(本次未覆盖)

- **整机断电 / Host 重启(RT-REC-08)**: SIGKILL 只模拟进程死亡; fsync / rename /
  目录 fsync 在 APFS 断电语义下的保证是推断(方向一致, R1 复核)。
- **真实 node-pty(RT-TERM-08)**: PTY 侧是 durable fake sink; 「owner 已接受 bytes」
  的真实语义与 PTY 写入崩溃的真实窗口由 ProcessSupervisor 兑现, 属推断。
- **Snapshot 安全 checkpoint(RT-ORDER-08 / RT-TERM-12)与 RT-REC-09**: 本原型只有
  Durable Stream Cursor, 无 Snapshot; 「Snapshot 损坏但 chunk 完整 → 重建」未实测
  (chunk 逐字节可恢复是其前提, 属 R0-08 / R0-09 范围)。
- **RT-ORDER-09 后半(delta 保留)**: 「Durable Stream Cursor 之内、Snapshot 安全
  checkpoint 之后的原始 frame 保留为 delta, 不得为推进 Snapshot 丢弃或替换」
  依赖 Snapshot 的存在, 本原型无 Snapshot, 未覆盖(随 R0-08 / R0-09 一并验收)。
- **RT-INPUT-01..04 provenance 字段缺口(partial)**: §6.5 InputIntent shape 要求
  `source`(Keyboard / IME / Paste / Mouse / Automation)、`attachmentId` 与
  `fencingToken`; 本原型的 record 只有 commandId / sessionId / generation /
  contentRef / hash。provenance 与 Control Lease 的复合属 R1 Session Runtime,
  届时 RT-INPUT-01 的「durable 记录来源」子句才算完整覆盖。
- **orphan 接纳的来源信任(R1 注明)**: `reconcileStore` 的 orphan 接纳「校验」
  只是自算 sha256 入库(协议内自洽); 一个非协议来源的同名最终文件(外部进程
  按命名规则投放到 storeDir)同样会被接纳。本原型接受这一点(orphan 只在
  Daemon 自己的 storeDir 内产生); R1 若放宽 storeDir 的信任边界, 需要更强的
  来源判定。
- **StoragePressure 与保留上限(RT-BP-03..07、RT-REC-11)**: 无容量上限、ENOSPC 与
  emergency reserve 路径未实测。
- **跨 Session 并发与 Runtime Limit Profile(RT-PERF-06、RT-STREAM-05)**: 单 session /
  单 intent 模型; 并发写同一 store 的 contention 与串线未实测。
- **RT-INPUT-05/06 与 redaction(RT-STO-09)**: contentRef 关联与 redacted preview 的
  时间线呈现未实现; 本原型仅保证 DB 不存原始 bytes、恢复源是 content object。
- **多 generation 交替崩溃**: generation 隔离有行为测试, 但崩溃矩阵只在
  generation=1 上执行; 旧 generation frame 失效(RT-ORDER-03)未实测。
- **dataGap 的 UI / Artifact 呈现(RT-EVIDENCE-01/04)**: dataGap 只到 reconcile
  报告与 `DataIntegrityFailure`, 未接到 projection。
- 单 Host 单次采样; `SupportedPlatformMatrix`(R0-15)冻结后需在矩阵最低 macOS /
  最低硬件上复测同一 fixture。
