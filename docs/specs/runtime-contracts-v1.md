# Agents.Fleet v1 Runtime Contracts

> Status: Draft
>
> 本文件定义 v1 的运行时接口、不变量、状态机、故障语义与验收方法。产品范围见 [`v1.md`](./v1.md)，信任与安全保证见 [`security-v1.md`](./security-v1.md)。
>
> `RT-*` 是稳定 requirement ID。issue 与测试必须引用这些 ID；已发布 ID 不得重编号或复用于另一语义。

## 1. Core Invariants

- **RT-INV-01**：UI 不拥有 Agent 进程、Session 或权威生命周期状态。
- **RT-INV-02**：Task 表达用户意图；每次首次执行、重试或中断后 resume 都创建新的 Attempt。
- **RT-INV-03**：每个 PTY 生命周期都有新的 Session ID；旧 Session ID 永不指向新进程。
- **RT-INV-04**：Fleet 管理的 Worktree 同一时刻只归属一个 Task；Attempt 必须绑定一个 Worktree 和不可变的 `baseCommitSha`。
- **RT-INV-05**：Restored View 只表示历史画面可读，不表示 Session Alive，也不能取得 Control Lease。
- **RT-INV-06**：无法确认进程或副作用时必须显示 Uncertain；不得猜测成功，也不得静默重新执行。
- **RT-INV-07**：生命周期状态、幂等命令结果和对应领域事件原子提交；Session 字节流不得成为第二份生命周期权威。

## 2. Deep Modules and Seams

| ID | Module | Interface 对调用者承诺 | Implementation 内部隐藏 |
| --- | --- | --- | --- |
| RT-MOD-01 | Control Dispatcher | 版本协商、鉴权、命令幂等、错误与路由 | transport、schema 校验、确认凭证 |
| RT-MOD-02 | Task Orchestrator | 创建、排队、启动、停止、取消、重试与 resume 的一致结果 | 状态转换、并发配额、Reconciliation 决策 |
| RT-MOD-03 | Session Runtime | attach、读取、输入、resize、stop | PTY、进程组、chunk、Snapshot、背压、Control Lease |
| RT-MOD-04 | Worktree Manager | provision、inspect、dispose 的安全结果 | Git 命令、路径约束、脏状态与分支保护 |
| RT-MOD-05 | Agent Adapter | 发现、准备、启动、Observation 与 Capability | Agent CLI 参数、Hook、Transcript、resume 差异 |
| RT-MOD-06 | Fleet Projection | 可订阅的 Task、Fleet、时间线和结果视图 | 查询、聚合、inferred 标记与 UI 读模型 |

**RT-MOD-07**：Control Dispatcher 只处理横切契约，不包含 Task、Session、Git 或 Agent 领域规则。SQLite 和本地文件系统是可在测试中直接启动的本地依赖，保持为上述模块的内部 seam，不额外暴露仅供 mock 的公共 Repository interface。

## 3. Ownership and Cardinality

- **RT-OWN-01**：一个 Workspace 绑定一个 Repository 和一组默认选择。
- **RT-OWN-02**：一个 Task 属于一个 Workspace。
- **RT-OWN-03**：一个 Task 可以保留多个历史 Worktree，但最多一个 Worktree 为 active。
- **RT-OWN-04**：一个 Worktree 同一时刻不能被两个 Task 共享。
- **RT-OWN-05**：一个 Attempt 绑定一个 Task、一个 Worktree、一个 `baseCommitSha` 和一个 Agent Profile 快照。
- **RT-OWN-06**：到达 Running 的 Attempt 恰有一个 primary Agent Session，也可以有 shell 或 test runner Session；在 Agent owner 建立前启动失败的 Attempt 可以没有 Session。
- **RT-OWN-07**：一个 Session 可以有多个观察 Attachment，但同一时刻最多一个有效 Control Lease。
- **RT-OWN-08**：一个 Task 同一时刻最多有一个非终态 Attempt；retry / resume 只有在前一 Attempt 终止后才能创建。

**RT-OWN-09**：重新基线不会原地改写历史 Worktree 或 Attempt。它创建新的 Worktree 记录和新的 Attempt，旧记录继续可审计。

## 4. State Model

### 4.1 Stored state

```text
TaskLifecycle =
  Draft | Runnable | Cancelled

AttemptStatus =
  Queued | Starting | Running | Waiting | Stopping |
  Succeeded | Failed | Cancelled | Interrupted | Uncertain

SessionAvailability =
  Alive | Exited | Lost

AttachmentMode =
  Live | Restored

AttachmentStatus =
  Active | Closed | Invalidated
```

- **RT-STATE-01**：`TaskLifecycle` 是 Task 自身保存的用户意图。`Runnable` 明确表示允许创建新 Attempt，不表示当前正在运行。
- **RT-STATE-02**：`AttemptStatus` 是一次执行的权威生命周期状态。
- **RT-STATE-03**：`SessionAvailability` 只陈述进程与 owner 是否可确认，不代替 AttemptStatus。
- **RT-STATE-04**：`AttachmentMode` 是客户端投影，不写回 Session 生命周期；Live 只用于 Alive Session，Exited / Lost Session 只能产生 Restored Attachment。Session 从 Alive 转为 Exited / Lost 时，同一 Active Attachment 的 mode 立即重投影为 Restored，身份不变，但 Lease 被撤销且所有控制命令失败。
- **RT-STATE-19**：`AttachmentStatus` 描述一个 Attachment 身份是否仍可使用。attach 创建 Active Attachment；客户端显式 detach 或 control 连接断开时转为 Closed；认证撤销、generation 变化或 Daemon 主动废止时转为 Invalidated。Closed / Invalidated 都是终态，control 重连必须创建新的 Attachment；stream-only 重连可以继续绑定同一 Active Attachment。

### 4.2 Task view projection

**RT-STATE-15**：`TaskLifecycle` 只允许 `Draft -> Runnable -> Cancelled`，不得回退。start 命令把 Draft Task 改为 Runnable 时，必须在同一 transaction 中创建 Queued Attempt；因此不存在“Runnable 但从未有 Attempt”的稳定状态。

用户看到的 `TaskView.status` 由 `TaskLifecycle` 和当前 Attempt 投影，不另存一份可漂移状态。非终态 Attempt 优先于 Cancelled，避免遮蔽仍然 Alive 或正在停止的执行：

**RT-STATE-16**：TaskView 按下表投影：

| 条件 | TaskView.status |
| --- | --- |
| current Attempt = Queued | Queued |
| current Attempt = Starting / Running | Running |
| current Attempt = Waiting / Stopping | Waiting |
| lifecycle = Cancelled，且没有非终态 Attempt | Cancelled |
| lifecycle = Draft，且没有 Attempt | Draft |
| lifecycle != Cancelled，且 current Attempt = Succeeded | Succeeded |
| lifecycle != Cancelled，且 current Attempt = Failed | Failed |
| lifecycle != Cancelled，且 current Attempt = Cancelled | Cancelled |
| lifecycle != Cancelled，且 current Attempt = Interrupted | Interrupted |
| lifecycle != Cancelled，且 current Attempt = Uncertain | Uncertain |

**RT-STATE-17**：当 lifecycle 已是 Cancelled、但当前 Attempt 尚未终止时，TaskView 额外返回 `noFurtherAttempts = true` 和 `cancellationRequested = true`。

**RT-STATE-20**：上表按从上到下的顺序匹配，且 `TaskView.lastAttemptStatus` 始终单独返回当前 Attempt 的原始状态。因此 Task 取消后的顶层状态确定为 Cancelled，但不会遮蔽最后一次 Attempt 的 Succeeded / Failed / Interrupted / Uncertain 事实。

### 4.3 Attempt transitions

**RT-STATE-18**：Attempt 只允许下表转换：

| From | Allowed next status |
| --- | --- |
| Queued | Starting, Cancelled |
| Starting | Running, Waiting, Failed, Cancelled, Interrupted, Uncertain |
| Running | Waiting, Stopping, Succeeded, Failed, Interrupted, Uncertain |
| Waiting | Starting, Running, Stopping, Succeeded, Failed, Interrupted, Uncertain |
| Stopping | Waiting, Succeeded, Failed, Cancelled, Interrupted, Uncertain |

规则：

- **RT-STATE-05**：`Succeeded`、`Failed`、`Cancelled`、`Interrupted`、`Uncertain` 是该 Attempt 的终态，不得改写。
- **RT-STATE-06**：Hook 只能提供 Observation，不能单独越过进程退出事实把 Attempt 标为 Succeeded。
- **RT-STATE-07**：Daemon / Host continuity failure 后确认进程已不存在、没有权威退出结果且没有副作用证据缺口时使用 Interrupted；已观察到的 Agent 异常退出按 RT-REC-06 处理。
- **RT-STATE-08**：无法确定进程、最后命令或 external 副作用是否完成时使用 Uncertain。
- **RT-STATE-09**：retry 和 resume 都创建新的 Attempt；旧 Attempt 状态不回退。
- **RT-STATE-10**：stop 只请求停止当前 Attempt；cancel 把 TaskLifecycle 改为 Cancelled，并阻止创建后续 Attempt。若仍有非终态 Attempt，cancel 必须同时请求 stop，TaskView 在 Attempt 终止前继续显示其执行状态。
- **RT-STATE-21**：进入 Waiting 时必须保存 `waitingReason` 与 `resumeStatus`；`resumeStatus` 只能是进入 Waiting 前的 Starting / Running / Stopping。解除等待只能回到该状态，且必须重新验证原状态所需事实。

### 4.4 Session transitions

- **RT-STATE-11**：Session 创建时必须已经观察到可识别的 PTY owner 和进程，因此初始 Availability 只能是 Alive。
- **RT-STATE-12**：Alive 只允许转换为 Exited 或 Lost；Exited / Lost 不得回到 Alive。
- **RT-STATE-13**：观察到进程退出使用 Exited；预期 owner 消失但没有权威退出 Observation 时使用 Lost。
- **RT-STATE-14**：任何重新 spawn 都创建新 Session，不允许通过改变 Availability 复活旧 Session。

### 4.5 Queue and concurrency

- **RT-SCHED-01**：每个 Attempt 在启动前取得一个 Host slot 和对应 Agent slot；任一上限为 0 或已满时保持 Queued。
- **RT-SCHED-02**：同一优先级按持久化 `queuedAt` 排序，再以 Attempt ID 稳定破同；v1 不提供用户优先级，因此默认全为同一优先级。
- **RT-SCHED-03**：slot lease 与 `Queued -> Starting` 在同一 transaction 中提交。没有有效 slot lease 的 Attempt 不得创建 LaunchIntent。
- **RT-SCHED-04**：Starting / Running / Waiting / Stopping Attempt 占用 slot；终态 Attempt 释放 slot。Uncertain 在确认没有孤儿进程前继续占用，防止 replacement 超额运行。
- **RT-SCHED-05**：Queued Attempt 被 cancel 后立即释放排队位置，不能短暂进入 Starting。
- **RT-SCHED-06**：Reconciliation 从持久化 Attempt 和进程事实重建 slot；不得只相信崩溃前的内存计数。

## 5. Failure and Reconciliation Matrix

| ID / 事件 | Session | Attempt | 系统动作 |
| --- | --- | --- | --- |
| RT-REC-01 Renderer 重载 | 保持 Alive | 不变 | 原 Attachment 关闭；新建 Attachment，从 cursor 续传 |
| RT-REC-02 Electron 关闭或崩溃 | 保持 Alive | 不变 | Daemon 继续运行；关闭其 Attachment 并撤销 Lease，通知仍由 Daemon 产生 |
| RT-REC-03 control 连接断开 | 保持 Alive | 不变 | 关闭 Attachment 并立即撤销其 Control Lease；重连创建新 Attachment |
| RT-REC-04 仅 stream 连接断开 | 保持 Alive | 不变 | Control Lease 由 TTL 决定是否继续；重新建立 stream 并从 cursor 续传 |
| RT-REC-05 Agent 正常退出 | Exited | 按退出码与权威 Observation 决定 Succeeded / Failed | 持久化最终 Snapshot 与 Artifact |
| RT-REC-06 Agent 异常退出或启动失败 | Exited 或尚未创建 Session | 退出与副作用证据完整时 Failed；存在证据缺口时 Uncertain | 保留 Observation；只允许用户显式 retry，Uncertain 时先披露重复副作用风险 |
| RT-REC-07 Daemon 崩溃 | Lost | Interrupted 或 Uncertain | LaunchAgent 拉起 Daemon；不得自动 spawn replacement |
| RT-REC-08 Host 重启 | Lost | Interrupted；存在证据缺口时 Uncertain | 自动启动 Daemon 并执行 Reconciliation；只提供显式 resume |
| RT-REC-09 Snapshot 损坏但 chunk 完整 | 不改变可用性 | 不变 | 重建 Snapshot 并记录诊断 Observation |
| RT-REC-10 chunk 缺失或 checksum 失败 | 不伪造历史 | 生命周期证据完整时保留原终态并附 `dataGap`；否则 Uncertain | 显式展示缺口，禁止声称“完整历史” |
| RT-REC-11 磁盘达到硬上限 | 保持当前事实 | Waiting，reason = StoragePressure | 在内存缓冲耗尽前暂停进程组并通知用户，不静默丢字节 |

**RT-REC-12**：Daemon 崩溃后可能存在仍运行但已不可 attach 的孤儿进程。Reconciliation 必须先按 Session 启动时记录的进程身份进行探测；不能只比较 PID。确认到孤儿时不得同时启动 replacement，必须标为 Uncertain，并允许用户显式停止或保留。

## 6. Control Interface

### 6.1 Handshake

**RT-HS-01**：客户端连接后先发送：

```text
ClientHello = {
  protocolVersions,
  clientInstanceId,
  clientKind
}
```

**RT-HS-02**：Daemon 返回：

```text
DaemonHello = {
  selectedProtocolVersion,
  daemonId,
  daemonGeneration,
  capabilities
}
```

**RT-HS-03**：没有共同版本时连接失败，并返回可显示的升级方向；不得尝试“尽力解析”未知命令。

### 6.2 Command envelope

**RT-CMD-09**：所有命令使用以下 envelope；各命令 schema 决定哪些 optional identity 必填：

```text
CommandEnvelope = {
  commandId,
  schemaVersion,
  workspaceId?,
  taskId?,
  attemptId?,
  sessionId?,
  expectedStateVersion?,
  expectedGeneration?,
  attachmentId?,
  fencingToken?,
  confirmationReceipt?,
  payload
}
```

规则：

- **RT-CMD-01**：`commandId` 由客户端生成并全局唯一。
- **RT-CMD-02**：Daemon 持久化命令 payload hash 与结果。相同 `commandId` + 相同 payload 返回原结果；相同 ID + 不同 payload 返回 `IdempotencyConflict`。
- **RT-CMD-03**：start、stop、cancel、retry、resume、Worktree dispose 等命令都必须幂等。
- **RT-CMD-04**：Session 输入、resize、stop 必须携带当前 Attachment、generation 和 fencing token。
- **RT-CMD-05**：Side-effect Class 由 Daemon 根据命令类型决定，不能信任客户端自报。
- **RT-CMD-06**：destructive / external 命令需要未过期且与 payload hash 绑定的 `confirmationReceipt`。
- **RT-CMD-07**：命令幂等记录至少保留 30 天；会创建 Task、Attempt、Session 或 Worktree 的记录在目标存在期间不得删除，目标删除后仍保留 30 天 tombstone。
- **RT-CMD-08**：Daemon 在持有目标写锁后重新计算 Side-effect Class 与影响摘要。目标 state version、风险类别或影响范围与确认时不一致时返回 `ConfirmationRequired`，不能沿用旧确认。

### 6.3 Error contract

**RT-ERR-02**：错误 code 至少区分：

```text
InvalidRequest | UnsupportedVersion | Unauthorized | Forbidden |
NotFound | Conflict | StaleGeneration | StaleControlLease |
ConfirmationRequired | CapabilityUnavailable | StoragePressure |
InternalFailure
```

**RT-ERR-01**：错误必须包含稳定 code、用户可读 message、是否可 retry，以及关联的 `commandId`；不得把内部路径、环境变量或秘密直接放入错误。

### 6.4 Attachment and Control Lease

依据 [ADR-0004](../adr/0004-identity-and-observe-first-control.md)，attach 与取得控制权是两个动作。

**RT-LEASE-09**：attach 默认只创建 Active 的观察 Attachment，并返回以下 shape：

```text
AttachResult = {
  attachmentId,
  mode: Live | Restored,
  sessionId,
  generation,
  snapshot
}

ControlLease = {
  sessionId,
  generation,
  attachmentId,
  fencingToken,
  expiresAt
}
```

- **RT-LEASE-01**：只有 Alive Session 的 Live Attachment 可以调用 `AcquireControl`；Restored Attachment 永远返回 `CapabilityUnavailable`。
- **RT-LEASE-02**：没有有效 Lease 时，首次 `AcquireControl` 原子增加该 Session 的持久化 fencing counter 并授予 Lease。
- **RT-LEASE-03**：已有有效 Lease 时，普通 acquire 返回 `Conflict` 和不含秘密的 holder 摘要；不得同时产生第二个 writer。
- **RT-LEASE-04**：强制 takeover 必须使用与 Session、generation 和 holder 绑定的确认凭证；成功后先增加 fencing counter，再撤销旧 Lease 并发出领域事件。
- **RT-LEASE-05**：Lease TTL 为 15 秒，holder 至少每 5 秒发送一次 renew。renew 必须携带当前 token，只能延长原 Lease，不能产生新 token。
- **RT-LEASE-06**：control 连接断开、TTL 到期、generation 变化或 Session 不再 Alive 时立即撤销 Lease；下次 grant 使用更大的 fencing token。
- **RT-LEASE-07**：fencing token 的作用域是 `{sessionId, generation, attachmentId}`，但计数器在一个 Session 内始终单调；Daemon 必须在执行 input、resize、stop 之前重新校验。
- **RT-LEASE-08**：stream 连接单独断开不撤销 Lease；holder 仍需按 control channel 的 TTL 规则 renew。
- **RT-LEASE-10**：AcquireControl 成功时才返回 ControlLease；attach 本身不增加 fencing counter，也不隐式取得写权限。Attachment 变为 Closed / Invalidated 后，旧 identity 和 token 都不能重连或续租。

## 7. Session Stream Interface

### 7.1 Channels and framing

- **RT-STREAM-01**：control channel 使用 UTF-8 NDJSON，一行一个完整对象。
- **RT-STREAM-02**：stream channel 使用 length-prefixed binary frame；PTY 原始字节保留在 binary payload 中，不经过字符串解码或 JSON 转义。
- **RT-STREAM-03**：两个 channel 分别建立连接和背压，但通过 `attachmentId` 关联；stream channel 必须重复执行认证，不能只信任 attachmentId。

**RT-STREAM-04**：所有 stream frame 与 cursor 使用以下 shape：

```text
StreamFrameHeader = {
  frameType,
  sessionId,
  generation,
  seq,
  payloadLength
}

SessionStreamCursor = {
  sessionId,
  generation,
  seq
}
```

### 7.2 Ordering

- **RT-ORDER-01**：`seq` 只在 `{sessionId, generation}` 内从 1 严格单调递增。
- **RT-ORDER-02**：一个 generation 只有一个权威 producer。
- **RT-ORDER-03**：producer 或 stream namespace 被替换时 generation 单调增加；旧 generation 的 frame 和控制命令全部失效。
- **RT-ORDER-04**：Snapshot 声明 `{sessionId, generation, coversThroughSeq}`。
- **RT-ORDER-05**：attach 时先取得 Snapshot，再请求 `coversThroughSeq + 1` 起的 delta；客户端按 cursor 去重。
- **RT-ORDER-06**：缺失 seq 时客户端停止应用后续 delta 并请求重新 Snapshot，不自行跳过。

### 7.3 Domain events are separate

**RT-EVENT-03**：Task 时间线使用以下低频领域事件，不把每个 PTY frame 写入时间线：

```text
DomainEventEnvelope = {
  eventId,
  schemaVersion,
  taskId,
  attemptId?,
  sessionId?,
  timelineSeq,
  occurredAt,
  observedAt,
  source,
  confidence: authoritative | inferred,
  payload
}
```

- **RT-EVENT-01**：`timelineSeq` 在一个 Task 内单调，用于稳定展示；`occurredAt` 仅表示观察到的业务时间，不承担排序权威。
- **RT-EVENT-02**：每个领域事件必须在写入时标注 authoritative / inferred；后续 Observation 可以新增纠正事件，但不能原地改写历史事件。

### 7.4 Backpressure and retention

- **RT-BP-01**：Daemon 的 append-only chunk store 吸收 Renderer 暂停或断连期间的输出。
- **RT-BP-02**：Renderer 队列有硬上限，可以合并“需要重绘”信号，但不能跳过持久化字节 cursor。
- **RT-BP-03**：v1 默认每个 Session 最多保留 1 GiB 原始 chunk，所有 Session 合计最多 10 GiB；设置页允许用户调整上限，并在降低前预览影响。
- **RT-BP-04**：达到软阈值时通知用户；达到硬阈值时在内存缓冲耗尽前暂停进程组，并按 RT-STATE-21 把 Starting / Running / Stopping Attempt 转为 Waiting / StoragePressure。用户释放空间后才可显式恢复到保存的 `resumeStatus`；不得静默删除或覆盖。
- **RT-BP-05**：v1 不自动删除仍关联 Task 的 Observation。用户删除 Task、清理 Workspace 或卸载时必须看到预计回收空间。

## 8. Persistence Contract

依据 [ADR-0005](../adr/0005-lifecycle-and-session-storage.md)：

- **RT-STO-01**：一次生命周期转换在同一 SQLite transaction 中写入新状态、命令幂等进度或结果，以及对应领域事件。
- **RT-STO-02**：PTY 数据先写临时 chunk，完成 checksum、文件 fsync、原子 rename 和目录 fsync 后，再把索引写入 SQLite。
- **RT-STO-03**：崩溃后存在文件但没有索引的 chunk 视为 orphan，由 Reconciliation 校验后接纳或隔离；有索引但缺文件视为 `dataGap`。
- **RT-STO-04**：Snapshot 可由 chunk 重建，不能作为判定 Attempt 或 Session 状态的依据。
- **RT-STO-05**：schema migration 必须支持从上一已发布版本升级；迁移失败时进入 `ReadOnlyRecovery`，不启动新 Attempt。
- **RT-STO-06**：生命周期数据库使用 WAL 与 `synchronous=FULL`。Daemon 启动和 migration 后执行 integrity check；失败时保留损坏原件、禁止写入，并只允许用户从已验证 backup 恢复或导出诊断。
- **RT-STO-07**：每次 migration 前创建并验证 backup；数据库有变化时至少每 24 小时创建一次滚动 backup，保留最近 3 份。恢复必须由用户确认，不能覆盖唯一损坏样本。

### 8.1 At-most-once Agent launch

**RT-LAUNCH-07**：OS spawn 无法和 SQLite transaction 原子提交。为避免“Agent 已启动，但 start 命令未提交，于是 retry 又启动一个 Agent”，Session Runtime 使用短生命周期的 inert bootstrap；它只完成启动握手，不在 Daemon 崩溃后托管 Session，因此不属于 per-Session supervisor。

1. **RT-LAUNCH-01**：start command transaction 只把 Draft Task 改为 Runnable、创建 Queued Attempt 并写入幂等记录。scheduler 取得可用 slot 后，在一个 launch transaction 中把同一 Attempt 从 Queued 转为 Starting，并创建 slot lease、planned Session ID 与 `LaunchIntent{commandId, launchNonce, argvHash, Prepared}`；此前不得执行 Repository 代码。
2. **RT-LAUNCH-02**：Daemon 启动 inert bootstrap。bootstrap 先以 `launchNonce` 原子写入 durable receipt，回报 pid、process start time 与 process group，然后等待 `CommitLaunch`；在收到授权前不得 exec Agent、shell 或 Repository 内容。
3. **RT-LAUNCH-03**：Daemon 把 bootstrap identity 和 `LaunchIntent=Authorized` 提交到 SQLite 后，才发送绑定 `launchNonce` 的一次性 `CommitLaunch`。
4. **RT-LAUNCH-04**：bootstrap 最多接受一次正确授权并 exec 结构化 argv。Daemon 观察到 Agent 后，在一个 transaction 中创建 Alive Session、把 Attempt 转为 Running、完成幂等结果并写领域事件。
5. **RT-LAUNCH-05**：相同 commandId 看到 Prepared / Authorized intent 时只返回 pending 状态或继续同一 handshake，绝不创建第二个 Attempt、bootstrap 或 Agent。
6. **RT-LAUNCH-06**：bootstrap 在 Daemon 消失且未收到授权时超时退出。若 Authorized 后结果未知，Reconciliation 通过 durable receipt 与完整进程身份探测；无法确认时标为 Uncertain，不启动 replacement。

## 9. Performance Contract

**RT-PERF-08**：发布验收使用支持范围内的最低配置 Apple Silicon Mac、10 个 Alive Session、其中一个持续输出 5 MiB/s、持续 60 秒的固定负载。

- **RT-PERF-01**：输入延迟从 Renderer keydown 至 Daemon 确认写入 PTY，median ≤ 75 ms，p99 ≤ 300 ms。
- **RT-PERF-02**：输出延迟从 Daemon 读取 PTY 至 Renderer 应用对应 frame，p95 ≤ 100 ms，p99 ≤ 300 ms。
- **RT-PERF-03**：Session restore 从 attach 至首个 Snapshot 完成渲染并可请求 Control Lease，p95 ≤ 1000 ms，测试 scrollback 为 10,000 行。
- **RT-PERF-04**：Renderer 内存与待处理 frame 数必须有硬上限。
- **RT-PERF-05**：持久化 Session 字节丢失数 = 0。
- **RT-PERF-06**：跨 Session 输入或输出串线数 = 0。

**RT-PERF-07**：“worst” 不作为发布门槛；所有 percentile 必须记录样本数、硬件、macOS 版本和负载。

## 10. Required Contract Tests

- **RT-T-01**：Renderer 连续重载 10 次，Agent PID 不变，输入输出继续。
- **RT-T-02**：Electron 进程退出后，Agent PID 不变；重新打开可 attach 原 Session。
- **RT-T-03**：control 断连后旧 Attachment 关闭、Lease 撤销且重连得到新 Attachment；stream 单独断连可在同一 Active Attachment 上恢复，二者都不创建重复 Agent，并分别符合 RT-LEASE-06 / RT-LEASE-08。
- **RT-T-04**：重复 start / stop / cancel / retry / resume 命令返回同一结果。
- **RT-T-05**：两个 Attachment 并发 acquire、Lease TTL、renew、takeover 和旧 fencing token 均满足 RT-LEASE-01..10。
- **RT-T-06**：旧 generation 或旧 Control Lease 不能 input、resize 或 stop。
- **RT-T-07**：Snapshot + delta 无重复、无缺口；故意删除 seq 时客户端重新取 Snapshot。
- **RT-T-08**：Daemon 强制崩溃后，不把 Restored View 显示为 Alive，也不自动启动 replacement。
- **RT-T-09**：Host 重启模拟后，旧 Attempt 为 Interrupted / Uncertain；显式 resume 创建新 Attempt 和 Session。
- **RT-T-10**：SQLite transaction、chunk rename、chunk index 每个崩溃点都可 Reconciliation。
- **RT-T-11**：在 RT-LAUNCH-01..06 每两个步骤之间强制崩溃，都不会启动重复 Agent。
- **RT-T-12**：SQLite corruption、backup restore、checksum 失败和 migration 失败都有明确、无数据伪造的结果；磁盘满分别发生在 Starting / Running / Stopping 时，解除后只回到保存的 `resumeStatus`。
- **RT-T-13**：Queued cancel、Starting failure、Running 正常退出、证据完整/缺失的异常退出和 Stopping 竞态全部遵守 Attempt transition table。
- **RT-T-14**：TaskLifecycle 已 Cancelled 但 Attempt 尚未终止时，TaskView 不遮蔽当前执行状态；Attempt 终止后顶层为 Cancelled，并通过 `lastAttemptStatus` 保留原始终态。
- **RT-T-15**：10 个并发 Session 满足性能预算且无串线。
- **RT-T-16**：Host / Agent 上限竞争、稳定队列顺序、Queued cancel、Uncertain slot 和 Daemon restart 均满足 RT-SCHED-01..06。
- **RT-T-17**：Alive Session 正常或异常退出后，现有 Active Attachment 保持 identity 但从 Live 重投影为 Restored，旧 Lease 与控制命令立即失效。
