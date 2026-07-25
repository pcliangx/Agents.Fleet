# R0-07 — At-most-once Agent 启动协议原型

> Branch: `r0-07-at-most-once-launch`。**本次实测**为以下契约提供协议骨架层面的证据:
> RT-LAUNCH-01..06 / RT-LAUNCH-08(§8.1 at-most-once launch)、RT-T-11(崩溃矩阵验收)、
> RT-CMD-02(命令幂等)、RT-CMD-16(启动前最终事实重验)、RT-REC-12(按完整身份再识别)。
> RT-LAUNCH-07 的 per-Session supervisor 归属、真实 Agent 经 node-pty 启动(R0-09/R1)、
> SQLite 事务与 chunk store 的交互(R0-14)**未在本次覆盖**, 见「边界与后续」。
>
> 实测于 2026-07-25, macOS 26.5.2 (25F84) / Darwin 25.5.0 / Apple Silicon / node v26.4.0 /
> node:sqlite(WAL + synchronous=FULL)。
> 方法: `driver.ts` 把 coordinator 作为真实子进程 spawn(真实 SQLite、真实 inert bootstrap
> 与 fake agent 子进程), 在 RT-LAUNCH-01..08 **每两个步骤之间**(含 RT-LAUNCH-08 的
> 验证失败 → AbortLaunch 边界与 CommitLaunch → 送达记录边界)对其 SIGKILL, 随后从
> **新进程**执行 Reconciliation 并做幂等重发与显式 retry; 断言由独立 orchestrator
> 执行(全局 `ps` 扫描 + durable 文件 + DB dump)。证据:
> [`r0-07/evidence-at-most-once-launch.json`](r0-07/evidence-at-most-once-launch.json)。

## 结论

**30 个场景(start / retry / resume × 基线 + 8 个崩溃点 + CommitLaunch 送达未知变体)全部满足
RT-T-11: 不留部分 Attempt / Worktree binding、不启动重复 Agent、不继续 Aborted nonce。**

- **实测直接支持**: 协议骨架(单事务步骤 + 原子 rename 的 CommitLaunch/AbortLaunch +
  O_EXCL durable receipt + 自超时 inert bootstrap + 新进程 Reconciliation)在每个协议
  边界崩溃后都能收敛; 相同 commandId 幂等返回原结果(RT-CMD-02); CommitLaunch 送达未知时
  标 Uncertain 而非 Aborted, 且不自动启动 replacement(RT-LAUNCH-06/08 尾部)。
- **推断(非本次实测)**: 「观察 Agent」在本原型用 fake agent 的 identity 文件 + `ps`
  完整身份判定; 真实 Agent 经 node-pty 启动后, 该判定要改由 PTY/进程事实完成(方向一致,
  R0-09/R1 复核)。bootstrap 自超时实测基于 ppid→1 检测; LaunchAgent 托管的真实 Daemon
  死亡后语义相同是推断(但 R0-03 已实测孤儿会 reparent 到 pid 1)。

## 协议实现要点(实测所基于的设计)

1. **每个会改权威状态的步骤都是一个 SQLite 事务**(WAL + synchronous=FULL);
   OS spawn 与 CommitLaunch 发送严格位于事务之间。崩溃要么落整个步骤, 要么完全回滚。
2. **CommitLaunch / AbortLaunch IPC 选型: write-tmp + rename 原子文件**。FIFO 会把
   writer 阻塞到 reader open(把崩溃窗口与 bootstrap 轮询耦合); 信号无法携带 nonce
   (无法验证「正确授权」); 原子 rename 使 Reconciliation 能区分「CommitLaunch 确定
   未发送」(文件不存在)与「送达未知」(文件存在) —— 这正是 RT-LAUNCH-08 尾部要求的
   分支条件(实测依赖此判定)。
3. **durable receipt 用 O_CREAT|O_EXCL 写入**: 第二个携带同 nonce 的 bootstrap 会
   失败而不是覆盖前者身份(实测 `receipt-conflict`)。
4. **bootstrap 的 Daemon 消失检测用 ppid→1**(reparent 到 launchd, R0-03 已实测)+
   grace 窗口; 未授权即退出, 绝不 exec(实测 `daemon-gone-timeout`)。
5. **abortTx 防御性不变量**: 一旦 commit 文件存在或 `commit_sent_at` 已记录,
   拒绝 Aborted, 必须走 Uncertain(实测抛错)。

## 崩溃点 × 命令类型矩阵(实测, 30/30 PASS)

每个单元格为该场景的最终收敛形态; 全部满足「恰好一个 Agent / 无部分状态 / 幂等收敛」。

| 崩溃点(协议边界) | start | retry | resume | 收敛形态 |
| --- | :-: | :-: | :-: | --- |
| 基线(无崩溃) | ✅ | ✅ | ✅ | Running, 恰好一个 Agent |
| afterCommandTx(RT-LAUNCH-01 两个事务之间) | ✅ | ✅ | ✅ | 无副作用 → 新进程继续**同一** handshake(RT-LAUNCH-05) |
| afterLaunchTx(Prepared ←→ spawn) | ✅ | ✅ | ✅ | 同上(从未有 bootstrap) |
| afterBootstrapSpawn(spawn ←→ authorize) | ✅ | ✅ | ✅ | 孤儿 bootstrap 自超时 → Aborted+Failed → 显式 retry 收敛 |
| afterAuthorizeTx(Authorized ←→ 重验) | ✅ | ✅ | ✅ | commit 文件缺失 ⇒ 确定未发送 ⇒ Aborted 合法 → retry 收敛 |
| afterRevalidationPass(验证过 ←→ CommitLaunch) | ✅ | ✅ | ✅ | 同上(RT-LAUNCH-08 边界) |
| afterRevalidationFail(abort tx ←→ AbortLaunch) | ✅ | ✅ | ✅ | abort tx 已落库; AbortLaunch 未发出, bootstrap 自超时兜底(RT-LAUNCH-08 允许) |
| afterCommitSent(rename ←→ 送达记录) | ✅ | ✅ | ✅ | 送达未知 → 探测到 Agent → finalize Running(RT-LAUNCH-06) |
| afterAgentObserved(观察 ←→ finalize) | ✅ | ✅ | ✅ | 同上 |
| afterCommitSent + Agent 被杀(送达不可证) | ✅ | ✅ | ✅ | **Uncertain, intent 保持 Authorized(非 Aborted), 不启动 replacement** |

## 关键机制实测明细

### 幂等与 nonce 终态(RT-CMD-02 / RT-LAUNCH-05 / RT-LAUNCH-08)

- 相同 commandId + 相同 payload 在崩溃后重发返回**原结果**(Running / Failed / Uncertain),
  不创建第二个 Attempt / bootstrap / Agent(全矩阵实测; DB 层另有 UNIQUE 约束兜底)。
- 相同 commandId + 不同 payload 返回 IdempotencyConflict(单测实测)。
- Aborted nonce: 无 commit 文件、无 agent identity、对 Aborted intent 再 authorize 抛错
  (实测), 且 retry 使用**新 commandId + 新 nonce**, 旧 nonce 永不复活(全矩阵实测)。

### CommitLaunch 送达未知 ⇒ Uncertain(RT-LAUNCH-06/08 尾部)

- 崩溃恰好落在「commit 文件已 rename、`commit_sent_at` 未记录」窗口时, 重启方无法区分
  「未发送」与「已发送未记录」。实测两条分支:
  - Agent 探测到(identity 文件 + `{pid, lstart, pgid, command}` 完整身份匹配) → finalize Running;
  - Agent 不可证实(被杀) → Attempt **Uncertain**、intent **保持 Authorized**(不 Aborted)、
    slot lease 保留、不自动 retry(实测无 replacement 进程)。
- 反向分支同样实测: commit 文件**缺失** ⇒ 确定未发送 ⇒ Authorized→Aborted 合法, 干净 Failed。

### inert bootstrap(RT-LAUNCH-02/04/06, 真实子进程单测)

- receipt 先于任何授权原子写入, 含 `{pid, pgid, lstart, argvHash}`, 与存活进程 `ps` 身份一致。
- 最多接受一次正确 nonce+argvHash 的 CommitLaunch; 错 nonce 拒绝(`commit-nonce-mismatch`)且不 exec。
- Daemon 消失(ppid→1)后 grace 窗口内自超时(`daemon-gone-timeout`); AbortLaunch 到达即退出;
  三种未授权出路都**绝不 exec**。

### 事务原子性(RT-LAUNCH-01, 注入唯一约束冲突实测)

- command 事务中途失败: 无幂等记录、Task 不被翻转、无 Attempt。
- launch 事务中途失败: Attempt 保持 Queued, 无 intent / lease / session 残留。

## 证据与复现

- 原型代码: [`packages/daemon/src/prototypes/r0-07-at-most-once-launch/`](../../packages/daemon/src/prototypes/r0-07-at-most-once-launch/README.md)
  (`coordinator.ts` 协议步骤 + `reconcile.ts` 新进程 Reconciliation + `children/` 真实子进程
  + `driver.ts` 崩溃注入驱动 + `evidence.ts` 证据 CLI)。
- 证据: [`r0-07/evidence-at-most-once-launch.json`](r0-07/evidence-at-most-once-launch.json)
  (30 场景脱敏实测, 含每场景的 reconcile actions / DB dump / 进程身份 / 检查项)。
- 结构化 fixture: [`packages/testing/src/fixtures/at-most-once-launch.ts`](../../packages/testing/src/fixtures/at-most-once-launch.ts)
  (实测/推断标注, 供 R1 Session Runtime 消费)。
- 测试: `crash-matrix.test.ts`(30 场景)、`coordinator.test.ts`、`reconcile.test.ts`、
  `bootstrap.test.ts`(共 46 例, 三连跑稳定)。
- 复现: `pnpm prototype:r0-07`(重跑全矩阵并重新生成证据)与 `pnpm test`。

## 边界与后续(本次未覆盖)

- **真实 Agent 经 node-pty 启动(R0-09 / R1)**: 本原型的 Agent 是纯 node fake agent;
  「Daemon 观察到 Agent」经 identity 文件 + `ps` 判定。真实 Agent 经 PTY 启动后该判定
  要改由 PTY/进程事实完成(推断: 方向一致, 需 R1 复核)。repo 的 node-pty guard(D8)未被触碰。
- **RT-LAUNCH-07 / per-Session supervisor 归属**: 只验证了 inert bootstrap 的短生命周期
  握手, 未涉及 Session 托管模型。
- **SQLite 事务与 chunk store / stream 持久化的交互(R0-14)**: 本原型只有 lifecycle 状态,
  无 Session stream。
- **Worktree 生命周期(RT-WORKTREE-03/05)**: facts.json 只是 RT-CMD-16 绑定事实的替身;
  真实 Worktree Planned→Ready 与 launch 事务的复合未实测。
- **scheduler 多 slot 并发**: 单 slot 模型; 并发 launch 的 lease 竞争未实测。
- **Host 重启(RT-REC-08)**: 只崩 coordinator 进程; 整机重启后 receipt/commit 文件与
  SQLite 的一致性未实测(文件均在磁盘, 推断可恢复, 但未验证)。
- 单 Host 单次采样; `SupportedPlatformMatrix`(R0-15)冻结后需在矩阵最低 macOS / 最低硬件上
  复测同一 fixture。
