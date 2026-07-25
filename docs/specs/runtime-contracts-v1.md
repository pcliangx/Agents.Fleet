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
- **RT-INV-08**：xterm.js 的 parser、buffer 与任一绘制路径都不是 Session 或 Attempt 的生命周期权威；Renderer 故障只能影响 Attachment 视图。
- **RT-INV-09**：一个 Session frame 只有在 Durable Stream Cursor 已覆盖它之后才可发布；Snapshot 只能覆盖已持久化且处于终端安全 checkpoint 的 frame。

## 2. Deep Modules and Seams

| ID | Module | Interface 对调用者承诺 | Implementation 内部隐藏 |
| --- | --- | --- | --- |
| RT-MOD-01 | Control Dispatcher | 版本协商、鉴权、命令幂等、错误与路由 | transport、schema 校验、确认凭证 |
| RT-MOD-02 | Task Orchestrator | 创建、排队、启动、停止、取消、重试与 resume 的一致结果 | 状态转换、并发配额、Reconciliation 决策 |
| RT-MOD-03 | Session Runtime | attach、读取、输入、resize、terminate Session | ProcessSupervisor、ByteJournal、SnapshotCoordinator、StreamBroker、LeaseManager |
| RT-MOD-04 | Worktree Manager | provision、inspect、dispose 的安全结果 | Git 命令、路径约束、脏状态与分支保护 |
| RT-MOD-05 | Agent Adapter | 发现、准备、启动、Observation 与 Capability | Agent CLI 参数、Hook、Transcript、resume 差异 |
| RT-MOD-06 | Fleet Projection | 可订阅的 Task、Fleet、时间线和结果视图 | 查询、聚合、inferred 标记与 UI 读模型 |
| RT-MOD-08 | Terminal Surface | 应用 Snapshot / delta、采集输入、resize、selection / copy、渲染与销毁 | xterm.js instance、官方 addon、IME、WebGL2 / DOM、绘制调度 |
| RT-MOD-10 | Desktop Bridge | Renderer 可调用的类型化 control、stream、原生确认与通知激活 | Electron Main、preload、MessagePort、sender / frame 校验 |
| RT-MOD-11 | Notification Gateway | 投递 Notification Intent、报告结果与处理点击路由 | macOS notification API、签名 helper、去重与重试 |
| RT-MOD-12 | Host Environment | 中立环境探测和可复现的启动环境快照 | executable identity、显式 PATH、环境清理与版本探测 |
| RT-MOD-14 | Evidence Recorder | 记录有 provenance 的 Artifact、GitObservation、test result 与 data gap | content store、hash、Agent claim 解析与证据归一化 |

**RT-MOD-07**：Control Dispatcher 只处理横切契约，不包含 Task、Session、Git 或 Agent 领域规则。SQLite 和本地文件系统是可在测试中直接启动的本地依赖，保持为上述 Module 的内部 Seam，不额外暴露仅供 mock 的公共 Repository Interface。

**RT-MOD-09**：Terminal Surface 对 Renderer 只暴露一个 Interface。xterm.js 的 WebGL2 与 DOM 是其内部绘制路径；业务 UI、Session Runtime 和测试不得依赖 xterm.js 类型，或按绘制路径复制终端语义与输入规则。

**RT-MOD-13**：`ProcessSupervisor`、`ByteJournal`、`SnapshotCoordinator`、`StreamBroker` 与 `LeaseManager` 是 Session Runtime 的私有 Implementation，不是公共 Seam。它们可以独立测试，但不得让 node-pty、chunk 文件、xterm.js 类型或 Electron transport 泄漏到 Session Runtime Interface。

**RT-MOD-15**：Worktree Manager、Session Runtime、Agent Adapter 与 test runner 只向 Evidence Recorder 提交带 producer identity 的候选证据；Evidence Recorder 决定 schema、provenance、confidence、content hash 与 data-gap 记录。Fleet Projection 只读取这些记录，不从 Renderer 或 Agent 展示文本反向制造 authoritative evidence。

### 2.1 Runtime limits

```text
RuntimeLimitProfile = {
  profileVersion,
  controlLineBytes,
  commandPayloadBytes,
  streamHeaderBytes,
  streamFramePayloadBytes,
  streamFramesPerSecond,
  attachmentQueueBytes,
  attachmentQueueFrames,
  inputIntentBytes,
  taskFieldBytes,
  taskSpecBytes,
  profileBytes,
  pathBytes,
  adapterObservationBytes,
  adapterObservationsPerSecond,
  challengeBytes,
  artifactMetadataBytes,
  artifactContentStreamChunkBytes,
  notificationPayloadBytes,
  snapshotBytes,
  fileTreeEntries,
  diffBytes,
  fingerprintFiles,
  fingerprintBytes,
  fingerprintDurationMs,
  controlRequestsPerSecond,
  rendererMemoryBytes,
  snapshotWorkerMemoryBytes,
  terminal: {
    scrollbackLines,
    glyphs,
    imagePlaceholderBytes,
    webglTextureBytes,
    domNodes,
    pendingWriteBytes,
    pendingInputBytes,
    paintQueueItems,
    effectPayloadBytes,
    effectsPerSecond
  }
}
```

- **RT-LIMIT-01**：R0 必须冻结一个 versioned `RuntimeLimitProfile`，覆盖所有 Control / stream、IPC、Task / Profile、Adapter、Observation / Artifact、Notification、Snapshot、Renderer queue 与 Terminal Surface 的“有界”或“硬上限”要求。各协议 schema 只能收紧单项限制，不能拥有一份未版本化的冲突默认值。
- **RT-LIMIT-02**：Daemon、Electron Main、Renderer 与 worker 必须在解析、分配内存、持久化或转发前按同一 `profileVersion` 检查相关 limit；超过上限返回 `InvalidRequest` / `StoragePressure` 或明确的截断 metadata，且不产生部分命令、副作用、跨 Session 影响或无界 diagnostic payload。来源不可信的长度字段不能决定预分配大小。
- **RT-LIMIT-03**：`RuntimeLimitProfile` 与 `SupportedPlatformMatrix` 一同进入签名 release manifest；每个安全、terminal 与性能结果记录 `profileVersion`。更改任一 limit 都生成新 version，并重跑对应 boundary、资源耗尽、恢复与性能 fixture，不能沿用旧版本结果。

## 3. Ownership and Cardinality

- **RT-OWN-01**：一个 Workspace 绑定一个 Repository 和一组默认选择。
- **RT-OWN-02**：一个 Task 属于一个 Workspace。
- **RT-OWN-03**：一个 Task 可以保留多个历史 Worktree，但最多一个 Worktree 为 active。
- **RT-OWN-04**：一个 Worktree 同一时刻不能被两个 Task 共享。
- **RT-OWN-05**：一个 Attempt 绑定一个 Task、一个 Worktree target、一个 `baseCommitSha`、一个 Task specification 快照、一个 Agent Profile 快照、一个 Environment Snapshot、一个 Adapter Capability / Permission Mapping snapshot 和对应 Launch Confirmation reference；这些绑定与快照在 Attempt 创建后不可改写。Planned Worktree Ready 后新增实际 filesystem identity 是 RT-WORKTREE-10 定义的 target resolution，不改写已确认的 Planned binding。
- **RT-OWN-06**：到达 Running 的 Attempt 恰有一个 primary Agent Session，也可以有 shell 或 test runner Session；在 Agent owner 建立前启动失败的 Attempt 可以没有 Session。
- **RT-OWN-07**：一个 Session 可以有多个观察 Attachment，但同一时刻最多一个有效 Control Lease。
- **RT-OWN-08**：一个 Task 同一时刻最多有一个非终态 Attempt；retry / resume 只有在前一 Attempt 终止后才能创建。

**RT-OWN-09**：重新基线不会原地改写历史 Worktree 或 Attempt。它创建新的 Worktree 记录和新的 Attempt，旧记录继续可审计。

- **RT-OWN-10**：Session 创建时固化 `role = PrimaryAgent | Shell | TestRunner` 和 `completionPolicy = BlocksAttemptCompletion | DoesNotBlockAttemptCompletion`；二者不得随 UI attach、进程退出或 Reconciliation 改写。
- **RT-OWN-11**：Attempt 只有在 primary outcome 已确定且所有 `BlocksAttemptCompletion` Session 均不再 Alive 后才能进入终态。仍 Alive 的非 blocking Session 必须继续可见，并阻止 Worktree dispose、Daemon 替换与卸载。

### 3.1 Repository onboarding, Task, Profile, and Worktree

```text
RepositoryTrustState =
  Untrusted | PendingValidation | Active | Revoked

WorktreeState =
  Planned | Ready | Failed | Orphaned | Disposed

WorktreeRole =
  Pending | Active | Historical

WorktreeMode =
  CreateFromBase | ContinueCurrentWorktree | Rebaseline | FromCommit

WorktreeTargetBinding =
  ExistingWorktree {
    worktreeId, filesystemIdentity
  } |
  PlannedWorktree {
    worktreeId, canonicalPath, repositoryIdentity, branchStrategy
  }
```

- **RT-REPO-01**：Repository Trust 前，用户选择的路径只形成 `RepositoryCandidate{canonicalRoot, filesystemIdentity}`；它不是可执行 Workspace，不调用 Git，也不读取 Repository 配置或内容。用户首次确认后只把 Trust 置为 PendingValidation。
- **RT-REPO-02**：PendingValidation 期间，Worktree Manager 只能通过 SV1-FILE-06 定义的受限 Git Interface 验证 candidate。v1 支持本地、non-bare、`HEAD` 可解析为 commit 的 working tree；selected root 可以是主 working tree 或 linked worktree，但必须恰好是 Git 返回的 working-tree root，并解析稳定的 common Repository identity。bare、unborn / 无 commit、损坏、root 不一致或 identity 无法证明的 Repository 返回稳定的 `UnsupportedRepository` / `RepositoryInvalid`，不得创建可执行 Workspace。
- **RT-REPO-03**：只有 RT-REPO-02 成功后，系统才在一个 transaction 中把 Trust 置为 Active，并创建 Workspace 与 Repository binding。验证失败或 Daemon 崩溃不得留下 Active Trust 或 Runnable Workspace；重新提交相同 candidate 使用命令幂等结果。
- **RT-REPO-04**：Repository inspection 返回 `currentCommitSha`、`currentBranch?`、`defaultBaseRef?`、各 ref 解析出的 SHA、common Repository identity 和 `observedAt`。detached HEAD 可以导入，但 `currentBranch` 为 null；无法可靠判断 default branch 时 `defaultBaseRef` 为 null，不能猜测。
- **RT-REPO-05**：`RepositoryTrustState` 初始为 Untrusted，只允许 `Untrusted -> PendingValidation -> Active`；用户撤销或已绑定 identity 漂移使 PendingValidation / Active 转为 Revoked。验证失败保留 PendingValidation 及失败结果，允许幂等重试同一 candidate 或显式撤销；Revoked 是该 Trust version 的终态，重新授予必须创建新的 version，不能复活旧绑定。
- **RT-REPO-06**：Daemon 从 `RepositoryCandidate` 生成一次性的 `RepositoryTrustChallenge{challengeId, userIdentity, canonicalRoot, filesystemIdentity, plannedAgent, dataLocation, validationPlan, validationPlanHash, hostPermissionUpperBound, expiresAt}`；`validationPlan` 是有界的结构化 Git 操作清单，不是 shell 文本。Electron Main 只在原生 UI 展示这些 Daemon 字段并取得真实用户手势后签发 `repositoryTrustReceipt`；Renderer 不能改写或签发。进入 PendingValidation 的命令必须绑定未过期 challenge、当前 user identity、candidate identity 与 receipt，执行前重新 canonicalize / stat；漂移、重放或 payload 不同返回 `ConfirmationRequired`，且不调用 Git。

- **RT-TASK-01**：Task specification 是有界、版本化的 `{goal, context, constraints, acceptanceCriteria}`；`goal` 非空，每个字段 UTF-8 大小不超过 512 KiB、合计不超过 1 MiB。创建或修改 Draft Task 都增加 `taskSpecVersion`，不得把这些字段拼成 shell 命令。
- **RT-TASK-02**：创建 Attempt 时保存当时完整 Task specification 与 `taskSpecVersion` 的不可变快照。后续编辑 Task 只影响未来 Attempt，不改写历史。
- **RT-TASK-03**：Task、Attempt 或 Workspace 的取消与删除是不同操作；`CancelTask` 只改变生命周期和未来执行意图，不删除 Task specification、Artifact、Worktree 或 Observation。

- **RT-PROFILE-01**：Agent Profile 是有界、版本化的 `{agentId, accountRef?, model?, mode?, permissionMode, secretRefs[]}`；只保存 Keychain / Agent-owned credential reference，不保存 secret value。
- **RT-PROFILE-02**：Attempt 的 Profile snapshot 保存 `profileVersion`、非秘密字段、secret reference identity、Adapter Capability 与 Permission Mapping hash；Profile 后续编辑或删除不改写历史快照。
- **RT-PROFILE-03**：进入 launch transaction 前重新解析所需 secret reference。缺失、权限变化或 identity 不匹配使 Queued Attempt 转为 Failed，并返回 `CapabilityUnavailable` / `ConfirmationRequired`；不得创建 LaunchIntent，也不得回退到明文 Profile、ambient environment 或另一账号。

- **RT-WORKTREE-01**：每个首次执行、retry 或 resume 都绑定显式、属于该 Repository 且对象类型为 commit 的 `baseCommitSha`；ref 名只用于预览，执行时必须使用已经展示并确认的 SHA。
- **RT-WORKTREE-02**：首次 start 的 `WorktreeMode` 必须是 `CreateFromBase`；retry / resume 只能是 `ContinueCurrentWorktree | Rebaseline | FromCommit`。预览必须返回 mode、`WorktreeTargetBinding`、branch 策略、`baseCommitSha`、dirty / untracked 处理和阻塞原因。复用模式返回已重新观察的 `ExistingWorktree` filesystem identity；新建模式只返回预分配 ID、计划 canonical path、Repository identity 与 branch 策略，不得伪造尚不存在的 filesystem identity。
- **RT-WORKTREE-03**：`ContinueCurrentWorktree` 复用当前 active Worktree 及其 dirty / untracked 内容，只在 identity 匹配、没有 Alive Session、没有未决 Process Disposition、没有其他非终态 Attempt，且 Worktree 未被外部占用时允许；它不创建新 Worktree。
- **RT-WORKTREE-04**：`CreateFromBase`、`Rebaseline` 与 `FromCommit` 创建新的 Fleet-managed Worktree。CreateFromBase 使用首次 start 选择并确认的 `baseCommitSha`；Rebaseline 使用预览时解析并在确认中固定的 base ref SHA；FromCommit 使用用户指定并验证的 commit SHA。三者都不得隐式复制旧 Worktree 的 staged、unstaged 或 untracked 内容。
- **RT-WORKTREE-05**：需要新 Worktree 的 start / retry / resume 在一个 SQLite transaction 中创建 Queued Attempt、Planned Worktree record、不可变快照和命令幂等记录；随后 Worktree Manager 执行结构化 Git provision。Ready transaction 重新验证身份、Task / Attempt 仍允许执行，并原子把原 active Worktree（若有）改为 historical、把新 Worktree 改为 active；只有此后 scheduler 才能把 Attempt 转为 Starting。若 Task / Attempt 在 provision 期间已取消或终止，但结果仍完整匹配 managed plan，则把新 Worktree 接纳为 `Ready + Historical`，不切换 active、不创建 LaunchIntent；只有能够证明没有遗留 Worktree / branch side effect 的明确 provision 失败，才把 record 置为 Failed，并在 Attempt 仍为 Queued 时把它置为 Failed。存在部分结果、identity / collision / invariant 冲突或归属无法证明时，把 record 置为 Orphaned，并在适用时把 Queued Attempt 置为 Failed。任何失败 / 取消分支都不得创建 Agent，旧 Worktree 及其 dirty 内容保持不变。
- **RT-WORKTREE-06**：Git provision 成功但 Ready transaction 尚未提交时，Daemon 崩溃或命令重试不会直接判定 provision 失败。Reconciliation 使用 Repository / Worktree identity、预定 path、branch 和 commit SHA 接纳同一个 Worktree：原 Attempt 仍为 Queued 且全部不变量成立时提交 `Ready + Active` 并继续原命令；Attempt 已终止但结果完整匹配 managed plan 时提交 `Ready + Historical` 且不继续启动；只有 identity / plan / ownership 无法证明时才记录为 `Orphaned + Pending`，等待用户处理。绝不创建第二个 Worktree、覆盖外部目录或删除无法证明归属的路径。
- **RT-WORKTREE-07**：Worktree inspection 返回 canonical path / identity、branch 或 detached 状态、HEAD / base SHA、staged / unstaged / untracked、这些本地 Git 事实的 canonical `stateFingerprint`、Alive Session、Process Disposition、`integrationTargetSha`、local-ref freshness 与 dispose blockers；每个事实带 `observedAt`。fingerprint 用于检测两次观察之间的变化，不宣称阻止外部进程在观察后修改文件。
- **RT-WORKTREE-08**：“未合并 commit”必须相对预览中显式选择并解析为 SHA 的 `integrationTargetSha` 计算；target 缺失、漂移或无法解析时 dispose fail closed，不能默认使用 remote、当前 branch 或猜测的默认 branch。
- **RT-WORKTREE-09**：Worktree dispose 继续受 SV1-FILE-04..05 和 SV1-FILE-09..10 约束；保留 managed branch，且不会因为卸载或“完整清理”绕过 dirty、identity、Alive Session、Process Disposition 或 unmerged commit blocker。
- **RT-WORKTREE-10**：新 record 以 `Planned + Pending` 开始；provision 只允许 `Planned -> Ready | Failed | Orphaned`，人工确认后的 Reconciliation 只允许 `Orphaned -> Ready | Failed`，安全 dispose 只允许 `Ready -> Disposed`。Failed 与 Disposed 是终态。正常 Ready transaction 重新验证 Planned binding 的 path、Repository、branch 与 `baseCommitSha`，记录实际 filesystem identity；Attempt 仍为 Queued 时把新 record 置为 `Ready + Active`，并在同一 transaction 中把旧 Active 改为 Historical，Attempt 已终止时只可置为 `Ready + Historical`。孤儿只能在重新验证 identity、path、branch、SHA 和归属后接纳为 `Ready + Historical`，不能自动替换 active Worktree。Planned / Orphaned 只能是 Pending，Failed 不能是 Active，Disposed 只能是 Historical，且任何时刻继续满足 RT-OWN-03。
- **RT-WORKTREE-11**：Worktree provision 必须遵守 SV1-FILE-11 的 no-external-program checkout。Repository hook、smudge / clean / process filter、external diff、textconv、fsmonitor、submodule recursion、pager 或 credential helper 都不能在 materialize Worktree 时执行；若受支持 Git 版本无法证明已禁用，或 Repository 需要外部 filter 才能得到正确 checkout，provision 返回 `CapabilityUnavailable`。仅在证明未留下 side effect 时进入 Failed，否则按 RT-WORKTREE-05 进入 Orphaned；不得用“不完整但可启动”的 Worktree 继续 LaunchIntent。

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

ProcessDisposition =
  Probing | ConfirmedAbsent | OrphanFound |
  KeepRequested | StopRequested | ConfirmedStopped

AttachmentMode =
  Live | Restored

AttachmentStatus =
  Active | Closed | Invalidated

DaemonOperatingMode =
  Normal | Draining | ReadOnlyRecovery
```

Process Disposition 只在 Reconciliation 需要记录遗留进程事实时存在；普通 Attempt 不以缺少该记录表示 Unknown。

- **RT-STATE-01**：`TaskLifecycle` 是 Task 自身保存的用户意图。`Runnable` 明确表示允许创建新 Attempt，不表示当前正在运行。
- **RT-STATE-02**：`AttemptStatus` 是一次执行的权威生命周期状态。
- **RT-STATE-03**：`SessionAvailability` 只陈述进程与 owner 是否可确认，不代替 AttemptStatus。
- **RT-STATE-04**：`AttachmentMode` 是客户端投影，不写回 Session 生命周期；Live 只用于 Alive Session，Exited / Lost Session 只能产生 Restored Attachment。Session 从 Alive 转为 Exited / Lost 时，同一 Active Attachment 的 mode 立即重投影为 Restored，身份不变，但 Lease 被撤销且所有控制命令失败。
- **RT-STATE-19**：`AttachmentStatus` 描述一个 Attachment 身份是否仍可使用。attach 创建 Active Attachment；客户端显式 detach 或 control 连接断开时转为 Closed；认证撤销、generation 变化或 Daemon 主动废止时转为 Invalidated。Closed / Invalidated 都是终态，control 重连必须创建新的 Attachment；stream-only 重连可以继续绑定同一 Active Attachment。

### 4.2 Task view projection

**RT-STATE-15**：`TaskLifecycle` 只允许 `Draft -> Runnable | Cancelled` 与 `Runnable -> Cancelled`，不得回退，Cancelled 是终态。start 命令把 Draft Task 改为 Runnable 时，必须按 RT-WORKTREE-05 在同一 transaction 中创建 Queued Attempt、不可变快照和必要的 Planned Worktree；因此不存在“Runnable 但从未有 Attempt”的稳定状态。取消尚未执行的 Draft Task 可以产生“Cancelled 且没有 Attempt”的稳定状态。

`currentAttempt` 是该 Task 唯一的非终态 Attempt；不存在非终态 Attempt 时为 null。`lastAttempt` 是按持久化 Attempt sequence 最新的一次 Attempt，可以是终态，也可以与 currentAttempt 相同；尚未执行时为 null。

用户看到的 `TaskView.status` 由 `TaskLifecycle`、currentAttempt 和 lastAttempt 投影，不另存一份可漂移状态。非终态 Attempt 优先于 Cancelled，避免遮蔽仍然 Alive 或正在停止的执行：

**RT-STATE-16**：TaskView 按下表投影：

| 条件 | TaskView.status |
| --- | --- |
| current Attempt = Queued | Queued |
| current Attempt = Starting / Running | Running |
| current Attempt = Waiting / Stopping | Waiting |
| lifecycle = Cancelled，且没有非终态 Attempt | Cancelled |
| lifecycle = Draft，且没有 Attempt | Draft |
| lifecycle != Cancelled，且没有 current Attempt，last Attempt = Succeeded | Succeeded |
| lifecycle != Cancelled，且没有 current Attempt，last Attempt = Failed | Failed |
| lifecycle != Cancelled，且没有 current Attempt，last Attempt = Cancelled | Cancelled |
| lifecycle != Cancelled，且没有 current Attempt，last Attempt = Interrupted | Interrupted |
| lifecycle != Cancelled，且没有 current Attempt，last Attempt = Uncertain | Uncertain |

**RT-STATE-17**：当 lifecycle 已是 Cancelled、但当前 Attempt 尚未终止时，TaskView 额外返回 `noFurtherAttempts = true` 和 `cancellationRequested = true`。

**RT-STATE-20**：上表按从上到下的顺序匹配。`TaskView.currentAttemptStatus` 只在 currentAttempt 存在时返回其原始非终态状态；`TaskView.lastAttemptStatus` 在 lastAttempt 存在时始终返回其原始状态。因此 Task 取消后的顶层状态确定为 Cancelled，但不会遮蔽最后一次 Attempt 的 Succeeded / Failed / Interrupted / Uncertain 事实，也不会把历史 Attempt 伪装成当前执行。

**RT-STATE-24**：`TaskView.phase` 独立返回 `Starting | Stopping | null`。当 current Attempt 为 Starting 或 Stopping 时必须显示对应 phase，不能只以 Running / Waiting 标签遮蔽正在启动或停止。

### 4.3 Attempt transitions

**RT-STATE-18**：Attempt 只允许下表转换：

| From | Allowed next status |
| --- | --- |
| Queued | Starting, Failed, Cancelled |
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
- **RT-STATE-10**：`RequestAttemptStop` 只请求停止目标 Attempt；`CancelTask` 把 TaskLifecycle 改为 Cancelled，并阻止创建后续 Attempt。若仍有非终态 Attempt，`CancelTask` 必须按同一确认影响摘要级联 `RequestAttemptStop`，TaskView 在 Attempt 终止前继续显示其执行状态。
- **RT-STATE-21**：进入 Waiting 时必须保存 `waitingReason` 与 `resumeStatus`；`resumeStatus` 只能是进入 Waiting 前的 Starting / Running / Stopping。解除等待只能回到该状态，且必须重新验证原状态所需事实。
- **RT-STATE-22**：Attempt 的 Uncertain 仍是不可改写的终态；Reconciliation 对遗留进程事实另存 Process Disposition。进程探测、保留或停止结果只能推进 Process Disposition，不能回写 AttemptStatus。
- **RT-STATE-23**：Process Disposition 为 Probing、OrphanFound、KeepRequested 或 StopRequested 时视为仍可能有进程；必须占用原 slot、禁止 replacement，并阻止 Worktree dispose。只有 ConfirmedAbsent 或 ConfirmedStopped 才释放这些约束。
- **RT-STATE-25**：primary Session 退出只决定 primary outcome，不自动终结 Attempt；Task Orchestrator 必须按 RT-OWN-11 等待所有 blocking Session 不再 Alive，并为未结束的非 blocking Session 保留独立可见状态。
- **RT-STATE-26**：除启动前失败且未创建 Session 的情形外，任何到 Succeeded、Failed、Cancelled、Interrupted 或 Uncertain 的转换都必须先满足 RT-OWN-11；primary outcome 已记录但仍有 blocking Session 时 Attempt 保持非终态并展示等待原因。
- **RT-STATE-27**：Daemon 初始为 Normal；升级 / 卸载 drain 只允许 `Normal -> Draining -> Normal`，成功 handoff 会终止旧 Daemon，而不是创建第四种 mode。Draining 禁止新 Attempt / LaunchIntent，但允许观察、attach 和显式停止既有 Session。integrity、migration 或 recovery 验证失败使 Normal / Draining 进入 ReadOnlyRecovery；该 mode 只允许有界诊断、导出与用户确认的已验证 backup restore，其他状态变更和进程启动返回 `RecoveryRequired`。只有 restore / schema / integrity 全部验证成功并增加 daemon generation 后才回到 Normal。

### 4.4 Session transitions

- **RT-STATE-11**：Session 创建时必须已经观察到可识别的 PTY owner 和进程，因此初始 Availability 只能是 Alive。
- **RT-STATE-12**：Alive 只允许转换为 Exited 或 Lost；Exited / Lost 不得回到 Alive。
- **RT-STATE-13**：观察到进程退出使用 Exited；预期 owner 消失但没有权威退出 Observation 时使用 Lost。
- **RT-STATE-14**：任何重新 spawn 都创建新 Session，不允许通过改变 Availability 复活旧 Session。

### 4.5 Queue and concurrency

- **RT-SCHED-01**：每个 Attempt 只有在其 Worktree 为 Ready 后才能取得一个 Host slot 和对应 Agent slot；Worktree 仍为 Planned、任一上限为 0 或已满时保持 Queued。
- **RT-SCHED-02**：同一优先级按持久化 `queuedAt` 排序，再以 Attempt ID 稳定破同；v1 不提供用户优先级，因此默认全为同一优先级。
- **RT-SCHED-03**：slot lease 与 `Queued -> Starting` 在同一 transaction 中提交。没有有效 slot lease 的 Attempt 不得创建 LaunchIntent。
- **RT-SCHED-04**：Starting / Running / Waiting / Stopping Attempt 占用 slot。普通终态 Attempt 释放 slot；Uncertain 是否释放由 Process Disposition 决定，不能只按 AttemptStatus 计数。Probing、OrphanFound、KeepRequested 与 StopRequested 继续占用，只有 ConfirmedAbsent 或 ConfirmedStopped 才释放。
- **RT-SCHED-05**：Queued Attempt 被 `CancelTask` 取消后立即释放排队位置，不能短暂进入 Starting。
- **RT-SCHED-06**：Reconciliation 从持久化 Attempt 和进程事实重建 slot；不得只相信崩溃前的内存计数。

## 5. Failure and Reconciliation Matrix

| ID / 事件 | Session | Attempt | 系统动作 |
| --- | --- | --- | --- |
| RT-REC-01 Renderer 重载 | 保持 Alive | 不变 | 原 Attachment 关闭；新建 Attachment，从 cursor 续传 |
| RT-REC-02 Electron 关闭或崩溃 | 保持 Alive | 不变 | Daemon 继续运行；关闭其 Attachment 并撤销 Lease，通知仍由 Daemon 产生 |
| RT-REC-03 control 连接断开 | 保持 Alive | 不变 | 关闭 Attachment 并立即撤销其 Control Lease；重连创建新 Attachment |
| RT-REC-04 仅 stream 连接断开 | 保持 Alive | 不变 | Control Lease 由 TTL 决定是否继续；重新建立 stream 并从 cursor 续传 |
| RT-REC-05 Agent 正常退出 | primary Session = Exited | 记录 primary outcome；满足 RT-OWN-11 后才转 Succeeded / Failed | 持久化 final Snapshot 与 Artifact，并等待 blocking Session |
| RT-REC-06 Agent 异常退出或启动失败 | Exited 或尚未创建 Session | 记录 Failed / Uncertain primary outcome；满足 RT-OWN-11 后才转终态 | 保留 Observation；只允许用户显式 retry，Uncertain 时先披露重复副作用风险 |
| RT-REC-07 Daemon 崩溃 | Lost | Interrupted 或 Uncertain | LaunchAgent 拉起 Daemon；不得自动 spawn replacement |
| RT-REC-08 Host 重启 | Lost | Interrupted；存在证据缺口时 Uncertain | 自动启动 Daemon 并执行 Reconciliation；只提供显式 resume |
| RT-REC-09 Snapshot 损坏但 chunk 完整 | 不改变可用性 | 不变 | 重建 Snapshot 并记录诊断 Observation |
| RT-REC-10 chunk 缺失或 checksum 失败 | 不伪造历史 | 生命周期证据完整时保留原终态并附 `dataGap`；否则 Uncertain | 显式展示缺口，禁止声称“完整历史” |
| RT-REC-11 磁盘达到硬上限 | 保持当前事实 | Waiting，reason = StoragePressure | 在内存缓冲耗尽前暂停进程组并通知用户，不静默丢字节 |

**RT-REC-12**：Daemon 崩溃后可能存在仍运行但已不可 attach 的孤儿进程。Reconciliation 必须先按 Session 启动时记录的完整进程身份进行探测；不能只比较 PID。探测开始时写入 Process Disposition = Probing；发现孤儿时把 Attempt 标为 Uncertain、Disposition 标为 OrphanFound，不得同时启动 replacement，并允许用户显式停止或保留。

## 6. Control Interface

### 6.1 Handshake

**RT-HS-01**：客户端连接后先发送：

```text
ClientHello = {
  protocolVersions,
  expectedPlatformMatrixVersion,
  expectedRuntimeLimitProfileVersion,
  clientInstanceId,
  clientKind,
  clientNonce
}
```

**RT-HS-02**：Daemon 选择共同 protocol 后返回：

```text
DaemonChallenge = {
  selectedProtocolVersion,
  daemonId,
  daemonGeneration,
  platformMatrixVersion,
  runtimeLimitProfileVersion,
  daemonNonce,
  daemonProof
}
```

**RT-HS-03**：没有共同版本时连接失败，并返回可显示的升级方向；不得尝试“尽力解析”未知命令。

**RT-HS-04**：`daemonProof` 与随后客户端发送的 `ClientAuth{clientProof}` 分别是受 Keychain capability token 保护、覆盖两个 nonce 和完整协商 transcript 的 domain-separated MAC；token 不在 transport 中发送。双方以 constant-time 比较 proof，nonce 在 daemon generation 内不得复用，失败 / 超时连接立即关闭且不能创建 Attachment 或执行命令。

**RT-HS-05**：mutual proof 成功且 platform / limit version 匹配后，Daemon 才返回：

```text
DaemonHello = {
  selectedProtocolVersion,
  daemonId,
  daemonGeneration,
  platformMatrixVersion,
  runtimeLimitProfileVersion,
  capabilities
}
```

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
  repositoryTrustReceipt?,
  launchConfirmationReceipt?,
  payload
}
```

规则：

- **RT-CMD-01**：`commandId` 由客户端生成并全局唯一。
- **RT-CMD-02**：Daemon 持久化命令 payload hash 与结果。相同 `commandId` + 相同 payload 返回原结果；相同 ID + 不同 payload 返回 `IdempotencyConflict`。
- **RT-CMD-03**：start、`RequestAttemptStop`、`CancelTask`、`TerminateSession`、retry、resume、Worktree dispose 等命令都必须幂等。
- **RT-CMD-04**：`WriteSessionInput`、`ResizeSession` 与 `TerminateSession` 必须携带当前 Attachment、generation 和 fencing token。
- **RT-CMD-05**：Side-effect Class 由 Daemon 根据命令类型决定，不能信任客户端自报。
- **RT-CMD-06**：destructive / external 命令需要未过期且与 payload hash 绑定的 `confirmationReceipt`。
- **RT-CMD-07**：命令幂等记录至少保留 30 天；会创建 Task、Attempt、Session 或 Worktree 的记录在目标存在期间不得删除，目标删除后仍保留 30 天 tombstone。
- **RT-CMD-08**：Daemon 在持有目标写锁后重新计算 Side-effect Class 与影响摘要。目标 state version、风险类别或影响范围与确认时不一致时返回 `ConfirmationRequired`，不能沿用旧确认。
- **RT-CMD-10**：`RequestAttemptStop` 的权威目标是 `attemptId`，不要求 Attachment 或 Control Lease；它对该 Attempt 当前所有 Alive Session 请求停止，属于 destructive，必须携带绑定 Attempt state version、相关 Alive Session 集合与影响摘要的确认凭证。
- **RT-CMD-11**：`CancelTask` 的权威目标是 `taskId`。没有非终态 Attempt 时只固化“不再创建 Attempt”的用户意图；需要级联停止时属于 destructive，确认摘要必须覆盖目标 Attempt 与其相关 Alive Session。
- **RT-CMD-12**：`TerminateSession` 的权威目标是 `sessionId + generation`，只终止该 Session；它同时要求有效 Control Lease 与 destructive confirmation，不能暗中取消 Task 或终结其他 Session。
- **RT-CMD-13**：resume 必须同时验证 Adapter 的 Resume Capability、旧 Attempt 为 Interrupted / Uncertain、RT-STATE-23 已允许 replacement、目标 Worktree mode 与新的 Launch Confirmation。任一条件不满足时返回稳定的 `CapabilityUnavailable` / `Conflict` / `ConfirmationRequired`，不得创建 Attempt、Worktree 或 Session。
- **RT-CMD-14**：start、retry 与 resume 都必须携带一次性的 `launchConfirmationReceipt`，绑定当前 user identity、Active Repository Trust version、Repository identity、RT-WORKTREE-02 的 `WorktreeTargetBinding`、Task / Profile snapshot version、`baseCommitSha`、Existing target 的 `stateFingerprint` 或 Planned target 的预期 clean / HEAD 状态、Environment Snapshot hash、Permission Mapping hash、argv hash、命令类型、影响摘要和过期时间。Existing binding 的 filesystem identity / fingerprint 漂移，或 Planned binding 的 ID、path、Repository、branch 策略、`baseCommitSha` / clean 状态与 Ready 结果不一致时，不得创建或继续 LaunchIntent；Ready 后实际 filesystem identity 或 state fingerprint 再发生变化同样 fail closed。它与 destructive `confirmationReceipt` 作用不同，不能互换。
- **RT-CMD-15**：`RequestAttemptStop`、`CancelTask` 级联停止与 `TerminateSession` 只作用于进程生命周期，不调用 Git reset / clean / checkout、Worktree dispose 或 branch delete。影响预览必须说明 Agent 可能在停止竞态中留下部分 staged / unstaged / untracked 内容；停止完成后重新观察 Git 状态，不能把修改描述为已保存、已回滚或已丢弃。
- **RT-CMD-16**：`launchConfirmationReceipt` 在命令接收时必须未过期，并按 `commandId` 一次性消费；相同幂等命令可以取得原结果，不能用于新命令。排队本身不使已接受的 receipt 失效，但 Worktree Ready、LaunchIntent 与 `CommitLaunch` 前都重新验证 RT-CMD-14 的绑定事实；检测到漂移时不得启动 Agent，未创建 Attempt 前直接返回 `ConfirmationRequired`，已创建的 Queued / Starting Attempt 则转为 Failed 并记录 reason，用户只能用新 receipt 显式 retry。最后一次观察之后外部进程仍可能改写 Worktree，系统必须记录 `observedAt`，不能把 fingerprint 描述成文件锁或 sandbox。
- **RT-CMD-17**：Daemon 根据规范化 start / retry / resume preview 创建有界 `LaunchConfirmationChallenge{challengeId, commandType, display, payloadHash, bindingHashes, impactSummaryHash, expiresAt}`。`display` 至少含 executable identity / version、Permission Mapping、脱敏 argv、Environment Snapshot summary、Repository identity、Worktree target / observed state、`baseCommitSha`、Task / Profile version 与影响摘要；它是结构化数据，不含 secret，所有字符串只作为 inert text 绘制且绝不成为实际 executable payload。Electron Main 通过受鉴权 Control Interface 取得 challenge，使用原生 UI 展示这些 Daemon 字段，并只在用户手势后签发 `launchConfirmationReceipt`；Renderer 只能请求打开 challenge，不能提供替代展示文本、改写 hash、取得签发密钥或自行签发。challenge 一经事实漂移、过期或签发即失效，Main / Daemon 都执行有界去重与速率限制。
- **RT-CMD-18**：强制 Control takeover 及其他 destructive / external 命令的 Daemon preview 生成 `SideEffectConfirmationChallenge{challengeId, commandType, sideEffectClass, targetIdentities, expectedStateVersions, display, payloadHash, impactSummaryHash, expiresAt}`；`display` 是有界、结构化且不含 secret 的权威影响摘要，所有字符串只作为 inert text 绘制且绝不成为命令 payload。ConfirmationBroker 只展示该 challenge，Main 只在真实用户手势后签发 `confirmationReceipt`；Renderer 不能提供替代文本或签发。执行前 RT-CMD-08 重新计算 target、class 与 impact，任一漂移、过期、签发后重放或跨命令复用均返回 `ConfirmationRequired`。

### 6.3 Error contract

**RT-ERR-02**：错误 code 至少区分：

```text
InvalidRequest | UnsupportedVersion | Unauthorized | Forbidden |
NotFound | Conflict | IdempotencyConflict | StaleGeneration | StaleControlLease |
ConfirmationRequired | CapabilityUnavailable | StoragePressure |
UnsupportedRepository | RepositoryInvalid | UnsupportedPlatform |
RecoveryRequired | DataIntegrityFailure | InternalFailure
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
- **RT-LEASE-07**：fencing token 的作用域是 `{sessionId, generation, attachmentId}`，但计数器在一个 Session 内始终单调；Daemon 必须在执行 `WriteSessionInput`、`ResizeSession`、`TerminateSession` 之前重新校验。
- **RT-LEASE-08**：stream 连接单独断开不撤销 Lease；holder 仍需按 control channel 的 TTL 规则 renew。
- **RT-LEASE-10**：AcquireControl 成功时才返回 ControlLease；attach 本身不增加 fencing counter，也不隐式取得写权限。Attachment 变为 Closed / Invalidated 后，旧 identity 和 token 都不能重连或续租。
- **RT-LEASE-11**：Electron Main 只能在绑定该 Attachment 的 Renderer control MessagePort 仍存活时替其 renew；MessagePort 关闭、Renderer frame 被销毁或 sender identity 改变时立即停止 renew 并释放 Lease。续租调度运行在 Main，不依赖可能被后台节流的 Renderer timer。

### 6.5 Input Observation

`node-pty` 只能确认 Fleet 已把 bytes 交给 PTY owner，不能证明子进程已经消费。输入状态使用下列记录，禁止使用 `Delivered` 命名：

```text
InputIntent = {
  inputIntentId,
  commandId,
  sessionId,
  generation,
  attachmentId,
  fencingToken,
  source: Keyboard | IME | Paste | Mouse | Automation,
  byteLength,
  contentRef,
  createdAt,
  status: Prepared | Dispatched | Uncertain
}
```

- **RT-INPUT-01**：`WriteSessionInput` 在调用 node-pty 前先持久化 `InputIntent{status=Prepared}`；`contentRef` 指向按敏感本地数据保护的原始 bytes，普通日志与默认时间线只保留 redacted preview、hash 和 byteLength。
- **RT-INPUT-02**：PTY owner 接受完整 bytes 后，在持久化同一 Input Intent 的 `Dispatched` Observation 之后才向客户端返回成功。`Dispatched` 只陈述交付给 PTY owner，不陈述 Agent 已读取或执行。
- **RT-INPUT-03**：Prepared 与 Dispatched 之间 Daemon 崩溃时，Reconciliation 把 Input Intent 标为 Uncertain；相同 commandId 重试返回该状态，绝不自动重放 bytes。
- **RT-INPUT-04**：已为同一 commandId 持久化 Dispatched 时，重复命令返回原结果，不再次写 PTY。
- **RT-INPUT-05**：输入 provenance、原始 bytes、redacted preview 与生命周期 Observation 必须可关联，但 redacted bytes 不能用作 PTY 输入、Snapshot 或恢复数据。
- **RT-INPUT-06**：`ResizeSession` 不宣称子进程已经处理窗口变化；成功只表示新的尺寸已由 PTY owner 接受，并按命令幂等契约保存。

## 7. Session Stream Interface

### 7.1 Channels and framing

- **RT-STREAM-01**：control channel 使用 UTF-8 NDJSON，一行一个完整对象。
- **RT-STREAM-02**：stream channel 使用 length-prefixed binary frame；PTY 原始字节保留在 binary payload 中，不经过字符串解码或 JSON 转义。
- **RT-STREAM-03**：两个 channel 分别建立连接和背压，但通过 `attachmentId` 关联；stream channel 必须重复执行认证，不能只信任 attachmentId。
- **RT-STREAM-05**：frame header、payload 与速率都使用 protocol version 对应的 `RuntimeLimitProfile` 硬上限；Daemon、Main 与 Renderer 必须在按 payloadLength 分配内存前验证 frameType、identity、长度和速率。
- **RT-STREAM-06**：Desktop Bridge 通过绑定 `{attachmentId, sessionId, generation, rendererFrameIdentity}` 的 MessagePort 向 Renderer 转发 binary frame。端口不能改绑到另一 Attachment，Renderer 也不能提交任意 socket 或 Host stream。

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
- **RT-ORDER-07**：Durable Stream Cursor 是 SQLite 中每个 `{sessionId, generation}` 已完成 chunk durability protocol 的最大连续 seq；不能越过缺失、未索引或 checksum 未验证的 frame。
- **RT-ORDER-08**：Snapshot 的 `coversThroughSeq` 必须同时不晚于 Durable Stream Cursor，并位于 `parserGround && utf8DecoderEmpty` 的安全 checkpoint；xterm.js write completion callback 不能单独证明该条件。
- **RT-ORDER-09**：Durable Stream Cursor 之后的 frame 不可发布；Durable Stream Cursor 之内、Snapshot 安全 checkpoint 之后的原始 frame 保留为 delta，不得为了推进 Snapshot 而丢弃或替换。

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

### 7.4 Projection and evidence

- **RT-PROJ-01**：Task projection 必须分别返回 `taskLifecycle`、`TaskView.status`、`phase`、`currentAttemptId?` / `currentAttemptStatus?`、`lastAttemptId?` / `lastAttemptStatus?`、`waitingReason?`、`terminalReason?` 与各字段的 authoritative / inferred 来源；reason 必须标明所属 Attempt。current 只指非终态 Attempt，last 指 sequence 最新 Attempt。不得把一个合成 badge 当作唯一状态事实，也不得把 last identity 填入 current 字段。
- **RT-PROJ-02**：Fleet projection 的每一行至少包含 Task identity、TaskView 状态、独立的 `currentAttempt?` 与 `lastAttempt?` summary、queue / waiting reason、最近 Observation、需要用户处理的项目和 `observedAt`；每个 Attempt summary 自带 identity、原始状态、Agent / Profile snapshot 与 Worktree identity。没有 current Attempt 时该字段必须为 null，同时仍可返回 terminal last Attempt；不能把 last summary 复制到 current 伪装当前执行。
- **RT-PROJ-03**：Projection 可以缓存，但必须携带基于的 state version / cursor 与生成时间；发现落后、data gap 或来源仅为 inferred 时 UI 明示 freshness / confidence，不能用客户端本地时间或旧 Renderer 内存覆盖权威状态。

```text
ArtifactRecord = {
  artifactId,
  attemptId,
  kind,
  producer,
  source,
  confidence: authoritative | inferred,
  observedAt,
  contentRef?,
  contentHash?,
  commandId?,
  exitCode?,
  dataGap?
}

GitObservation = {
  worktreeId,
  worktreeIdentity,
  headSha,
  baseSha?,
  comparisonRef?,
  comparisonSha?,
  stateFingerprint,
  observedAt,
  refSource: LocalOnly,
  refFreshness: LocalObservationOnly,
  staged,
  unstaged,
  untracked
}
```

- **RT-EVIDENCE-01**：Artifact 是不可原地改写的 Attempt 证据记录；内容变化创建新 record。存在内容时保存 content hash 与受保护的 content reference，缺失、损坏或被清理时保留 metadata 并标记 `dataGap`。
- **RT-EVIDENCE-02**：只有 Fleet 实际启动或直接观察到的测试，才能记录为 authoritative test result；至少保存结构化命令 identity / hash、cwd / Environment Snapshot reference、开始与结束时间、exit code 和有界输出 reference。Agent 或 Transcript 自述“测试通过”只能是 inferred claim。
- **RT-EVIDENCE-03**：status、diff、ahead / behind 与 branch 来源必须产生绑定 Worktree identity、HEAD、base / comparison SHA、canonical `stateFingerprint`、`observedAt` 与 `refFreshness = LocalObservationOnly` 的 GitObservation。fingerprint 至少覆盖 HEAD、index、staged / unstaged diff，以及 untracked path、类型与流式 content hash；无法完整读取任一项或超过 `RuntimeLimitProfile` fingerprint budget 时返回 blocker，不能签发声称覆盖完整状态的 fingerprint。它用于比较已观察状态但不充当外部文件锁；ahead / behind 只基于本地 refs，不得暗示已经 fetch 或代表当前 remote。
- **RT-EVIDENCE-04**：结果页必须把 authoritative evidence、inferred claim、尚未运行的验收项和 data gap 分开展示；缺少测试证据不能被转换成“测试通过”，但也不自行改写由进程与 Adapter contract 决定的 Attempt outcome。
- **RT-EVIDENCE-05**：Artifact、GitObservation 与测试结果都必须可追溯到 Attempt 和生成它的命令 / Observation；从 Agent 文本解析出的文件名、commit 或测试声明不能覆盖随后观察到的 Git / process 事实。
- **RT-EVIDENCE-06**：读取 Artifact 内容和 Worktree Git 状态继续受 Repository Trust、SV1-FILE、SV1-DATA 与有界 payload 约束；Renderer 只取得展示所需的有界派生数据或经鉴权的 content stream。
- **RT-EVIDENCE-07**：存在 Artifact / test output 内容时，Evidence Recorder 先按 checksum、文件 fsync、原子 rename、目录 fsync 完成 content object，再在 SQLite transaction 中创建引用 content identity 的 immutable record。无 record 的 object 可校验后接纳到原命令或隔离，有 record 但 object 缺失 / 损坏时保留 metadata 并标记 data gap；不能以派生摘要、Agent 文本或空内容替代。

### 7.5 Backpressure and retention

- **RT-BP-01**：Daemon 的 append-only chunk store 吸收 Renderer 暂停或断连期间的输出。
- **RT-BP-02**：Renderer 队列有硬上限，可以合并“需要重绘”信号，但不能跳过持久化字节 cursor。
- **RT-BP-03**：v1 默认每个 Session 最多保留 1 GiB 原始 chunk，所有 Session 合计最多 10 GiB；设置页允许用户调整上限，并在降低前预览影响。
- **RT-BP-04**：达到软阈值时通知用户；达到硬阈值时，在内存缓冲耗尽前暂停所有仍 Alive 且可能继续向受压存储写入的相关 Session 进程组，并按 RT-STATE-21 把 Starting / Running / Stopping Attempt 转为 Waiting / StoragePressure。暂停集合与结果形成 Observation；用户释放空间并重新验证全部相关进程后才可显式恢复到保存的 `resumeStatus`，不得静默删除、覆盖或只暂停一个 producer 后继续接收其他无界输出。
- **RT-BP-05**：v1 不自动删除仍关联 Task 的 Observation。用户删除 Task、清理 Workspace 或卸载时必须看到预计回收空间。
- **RT-BP-06**：隐藏或离屏终端不维持无界 Renderer frame 队列。Terminal Surface 可以释放其 xterm.js / WebGL / DOM 资源，只保留持久化 cursor；重新可见时由 Snapshot + delta 恢复。该虚拟化不关闭 Attachment、撤销 Control Lease 或改变 Session。
- **RT-BP-07**：Daemon 在 app-data 同一 volume 上维持已预分配并验证的 64 MiB emergency metadata reserve；无法建立 reserve 时不启动新 Attempt。storage hard threshold 必须同时早于用户 quota、filesystem 可用空间减去 reserve，以及最大在途 chunk / SQLite transaction 预算。遇到意外 ENOSPC 时先暂停 RT-BP-04 的全部 producer，再释放 reserve、fsync 目录并提交 Waiting / StoragePressure 与诊断 Observation；恢复执行前必须重新建立 reserve。reserve 不能被当作可写 chunk 空间，也不能通过删除已持久化 Observation 腾出。

### 7.6 Terminal Surface

依据 [ADR-0003](../adr/0003-upstream-first-terminal.md)：

- **RT-TERM-01**：终端 package allowlist 仅包含随签名安装包发布的精确版本 `@xterm/xterm`、`@xterm/headless`、`@xterm/addon-webgl`、`@xterm/addon-serialize` 与 `@xterm/addon-unicode11`。`@xterm/addon-unicode11` 提供 Unicode 11 宽度 / 字素表，使 emoji 等取得正确 East Asian Width（核心默认表把部分 emoji 标为 width 1）；live Terminal 与 headless Snapshot Worker 必须加载同一版本，否则两者的 grid / cursor 不一致。构建清单必须记录 package 版本、lockfile / package integrity、任何 patch-set hash 和 `terminalSchemaVersion`；运行时不得从 CDN、网络、未锁定 prerelease 或未列入 allowlist 的 addon 加载终端代码。
  > _Changelog (R0-09, [ADR-0007](../adr/0007-terminal-allowlist-unicode11-addon.md))_：allowlist 由 4 包扩为 5 包（+`@xterm/addon-unicode11`，修正 emoji / CJK 宽度）。`terminalSchemaVersion` / patch-set hash / SBOM 由构建与 release manifest 任务（RT-DIST-01 / SV1-SUPPLY-01）产出，本 slice 仅锁版本 + lockfile integrity，属 partial。
- **RT-TERM-02**：Terminal Surface 严格按 `{sessionId, generation, seq}` 把 PTY binary payload 以 `Uint8Array` 喂给 xterm.js；每次 `write` 必须以 completion callback 确认解析完成后才能推进 Renderer 已应用 cursor，缺失 seq 时不得继续解析。该 callback 不得用于推进 Snapshot 安全 checkpoint。
- **RT-TERM-03**：每个 Active Attachment 最多有一个 xterm.js `Terminal` instance。WebGL2 / DOM 切换复用同一 parser 与 buffer，不创建第二个 instance，也不重放已应用的 seq。
- **RT-TERM-04**：官方 WebGL addon 是首选 WebGL2 绘制路径。WebGL2 不可用、初始化失败或 context lost 时，Terminal Surface 必须释放该 addon，并让同一个 `Terminal` instance 原位使用 DOM renderer；Session、Attachment、generation、cursor 和 Control Lease 均不改变。
- **RT-TERM-05**：WebGL2 与 DOM 只绘制同一个 xterm.js buffer，不拥有 PTY 字节、终端模式或生命周期状态；绘制失败不能生成 `WriteSessionInput`、`RequestAttemptStop`、retry 或 resume。
- **RT-TERM-06**：Terminal Surface 消费 xterm.js 的 `onData` 与 `onBinary` 输入：键盘、IME composition、paste 和 mouse 的 `onData` 按协商的 UTF-8 编码，`onBinary` 按单字节值无损转换；两者都只能通过持有 Control Lease 的输入命令发送，Renderer 不能绕过 Control Interface 直接写 PTY。
- **RT-TERM-07**：Snapshot 使用 Agents.Fleet 自有的版本化 schema，并携带 terminal package-set identity、`coversThroughSeq`、安全 checkpoint 证明和截断元数据。不得持久化或恢复 xterm.js 私有 buffer、DOM、texture 或 HTML serialization；schema 或 package set 不兼容时从已校验 chunk 重建。
- **RT-TERM-08**：`node-pty` 只加载在用户级 Daemon 的 `ProcessSupervisor`，以 `encoding: null` 接收原始 `Buffer`，并由 Session Runtime 独占 PTY fd 与子进程 identity。Electron Main、Renderer 和 Snapshot Worker 不得加载 node-pty、继承 PTY fd 或直接 spawn Agent；ProcessSupervisor 不与 Snapshot Worker 共享 worker thread。
- **RT-TERM-09**：Terminal Surface、headless Snapshot Worker 和整个 Renderer 按 `RuntimeLimitProfile` 对 scrollback、glyph / image、pending write / input、WebGL texture、DOM node、worker memory 和绘制队列设置硬上限；超限必须降级、拒绝或请求重新 Snapshot，不得使 Renderer 或 Daemon 无界增长。
- **RT-TERM-10**：升级 xterm.js package set、官方 addon、patch set、终端 CSS 或 Snapshot schema 前，必须通过相同的终端语义、输入、恢复、双绘制路径与性能 fixture。
- **RT-TERM-11**：Snapshot 的生成不依赖 Electron 或 Active Attachment。Session Runtime 按需启动兼容版本的 `@xterm/headless` 与 `@xterm/addon-serialize` Snapshot Worker，严格按 seq 回放已校验 chunk，只在 RT-ORDER-08 的安全 checkpoint 写出 app-owned、非 HTML Snapshot 并销毁；Worker 不得取得 PTY fd、Control Lease 或发送 input。（Worker 必须加载与 live Terminal 同一版本的 unicode 宽度 addon，见 RT-TERM-01 与 [ADR-0007](../adr/0007-terminal-allowlist-unicode11-addon.md)。）
- **RT-TERM-12**：`parserGround` 表示 xterm parser 不在 CSI、OSC、DCS 或其他未闭合控制序列中；`utf8DecoderEmpty` 表示没有跨 frame 保留的部分 UTF-8 code unit。SnapshotCoordinator 必须以受支持 package set 可验证的状态同时证明两者。
- **RT-TERM-13**：若上游公开 API 无法证明 RT-TERM-12，R0 必须验证一个最小下游 patch，明确 owner、patch hash、升级预算、回归 fixture 与删除条件。在该验证通过前，Snapshot 不得越过最后一个已证明 checkpoint；不能以序列化“看起来正确”降低保证。
- **RT-TERM-14**：v1 不加载 `addon-image`。image protocol 被忽略或按有界占位符显示；terminal title、OSC 8、clipboard、bell 与其他 effect 由私有 `TerminalEffectPolicy` Implementation 统一决定，escape sequence 不能直接打开 URL / 文件、读写 clipboard、发送通知或调用 Host Interface。
- **RT-TERM-15**：Snapshot 达到 scrollback / size 上限时必须记录 `truncated = true`、`truncatedBeforeSeq` 与保留范围；原始 chunk 的 retention 不因 Snapshot 截断而改变，Restored View 必须明确提示可见历史已截断。
- **RT-TERM-16**：invalid UTF-8、跨 frame multibyte sequence 与任意 binary byte 必须按锁定 package set 的已记录策略处理，原始 chunk 始终逐字节保留；Renderer 或 Snapshot 的 replacement character 不能回写原始流。

## 8. Persistence Contract

依据 [ADR-0005](../adr/0005-lifecycle-and-session-storage.md)：

- **RT-STO-01**：一次生命周期转换在同一 SQLite transaction 中写入新状态、命令幂等进度或结果，以及对应领域事件。
- **RT-STO-02**：PTY 数据先写临时 chunk，依次完成 checksum、文件 fsync、原子 rename 和目录 fsync，再在一个 SQLite transaction 中写入 chunk index 并推进连续的 Durable Stream Cursor；该 transaction 提交前不得发布受影响 frame。
- **RT-STO-03**：崩溃后存在文件但没有索引的 chunk 视为 orphan，由 Reconciliation 校验后接纳或隔离；有索引但缺文件或 checksum 失败视为 `dataGap`，对应内容读取返回 `DataIntegrityFailure`，不能用空 bytes 或旧 Snapshot 伪装成功。
- **RT-STO-04**：Snapshot 可由 chunk 重建，不能作为判定 Attempt 或 Session 状态的依据。
- **RT-STO-05**：schema migration 必须支持从上一已发布版本升级；迁移失败时进入 `ReadOnlyRecovery`，不启动新 Attempt。
- **RT-STO-06**：生命周期数据库使用 WAL 与 `synchronous=FULL`。Daemon 启动和 migration 后执行 integrity check；失败时保留损坏原件、禁止写入，并只允许用户从已验证 backup 恢复或导出诊断。
- **RT-STO-07**：每次 migration 前创建并验证 backup；数据库有变化时至少每 24 小时创建一次滚动 backup，保留最近 3 份。恢复必须由用户确认，不能覆盖唯一损坏样本。
- **RT-STO-08**：stream publish、attach delta、SnapshotCoordinator 与 final Snapshot 只能读取 Durable Stream Cursor 已覆盖的 frame；内存中已读取但未 durable 的 PTY bytes 不可被描述为可恢复。
- **RT-STO-09**：原始 PTY chunk、Input Intent bytes 与用于恢复的 Snapshot 不做内容替换式 redaction，并全部按敏感本地数据保护。redaction 只产生派生的时间线、索引、诊断日志与默认导出；派生数据不能替代恢复源。
- **RT-STO-10**：Snapshot 的 `coversThroughSeq` 同时受 Durable Stream Cursor、连续 seq 和 RT-ORDER-08 安全 checkpoint 约束；任何条件不满足时保留旧 Snapshot，并把后续 durable frame 作为 delta。
- **RT-STO-11**：Input Intent 原始 bytes 先写临时 content object，完成 checksum、文件 fsync、原子 rename 与目录 fsync 后，才在 SQLite transaction 中创建引用该 checksum / identity 的 Prepared record；此前不得调用 node-pty。崩溃后无 record 的 object 是待隔离 / 回收 orphan，有 Prepared record 但 object 缺失或 checksum 错误时标记 data gap、返回 `DataIntegrityFailure` 且绝不写 PTY；redacted preview 不能替代 object。

### 8.1 At-most-once Agent launch

**RT-LAUNCH-07**：OS spawn 无法和 SQLite transaction 原子提交。为避免“Agent 已启动，但 start 命令未提交，于是 retry 又启动一个 Agent”，Session Runtime 使用短生命周期的 inert bootstrap；它只完成启动握手，不在 Daemon 崩溃后托管 Session，因此不属于 per-Session supervisor。

```text
LaunchIntentStatus =
  Prepared | Authorized | Aborted
```

1. **RT-LAUNCH-01**：start / retry / resume command transaction 都创建一个 Queued Attempt、不可变快照和幂等记录；start 还在同一 transaction 中把 Draft Task 改为 Runnable。需要新 Worktree 的 mode 按 RT-WORKTREE-05 同时创建 Planned Worktree，`ContinueCurrentWorktree` 则绑定已经按 RT-WORKTREE-03 重新验证的 Ready Worktree；任一 transaction 失败都不得留下部分 Attempt 或绑定。Worktree Ready 后，scheduler 取得可用 slot，并在一个 launch transaction 中把同一 Attempt 从 Queued 转为 Starting，创建 slot lease、planned Session ID 与 `LaunchIntent{commandId, launchNonce, argvHash, status=Prepared}`；此前不得启动 Agent 或执行 Repository 代码。
2. **RT-LAUNCH-02**：Daemon 启动 inert bootstrap。bootstrap 先以 `launchNonce` 原子写入 durable receipt，回报 pid、process start time 与 process group，然后等待 `CommitLaunch`；在收到授权前不得 exec Agent、shell 或 Repository 内容。
3. **RT-LAUNCH-03**：Daemon 把 bootstrap identity 和 `LaunchIntent.status=Authorized` 提交到 SQLite 后，才发送绑定 `launchNonce` 的一次性 `CommitLaunch`。
4. **RT-LAUNCH-04**：bootstrap 最多接受一次正确授权并 exec 结构化 argv。Daemon 观察到 Agent 后，在一个 transaction 中创建 Alive Session、把 Attempt 转为 Running、完成幂等结果并写领域事件。
5. **RT-LAUNCH-05**：相同 commandId 看到 Prepared / Authorized intent 时只返回 pending 状态或继续同一 handshake，绝不创建第二个 Attempt、bootstrap 或 Agent；看到 Aborted 时只返回原失败结果，不能恢复、替换 nonce 或继续 CommitLaunch。
6. **RT-LAUNCH-06**：bootstrap 在 Daemon 消失且未收到授权时超时退出。若 Authorized 后结果未知，Reconciliation 通过 durable receipt 与完整进程身份探测；无法确认时标为 Uncertain，不启动 replacement。

**RT-LAUNCH-08**：在发送 `CommitLaunch` 前，Daemon 必须完成 RT-CMD-16 的最后一次重新验证。失败时在一个 transaction 中把 LaunchIntent 从 Prepared / Authorized 转为 Aborted、把 Starting Attempt 转为 Failed、释放 slot 并写入幂等结果与领域事件；随后发送 `AbortLaunch` 或让 inert bootstrap 超时退出。Aborted 是终态，对应 nonce 永远不能再被授权或提交。若 `CommitLaunch` 是否已经送达无法确认，则不能使用 Aborted，必须按 RT-LAUNCH-06 进入 Uncertain。

## 9. Environment and Adapter Contract

### 9.1 Host Environment

- **RT-ENV-01**：Repository Trust 首次确认前只能读取 canonical path、文件系统 identity 和应用安装信息等 Host 级元数据；不得启动 Agent、Git CLI、Repository executable、shell 或 shell 初始化文件。PendingValidation 时唯一允许的 Git 调用由 RT-REPO-02 定义，仍不得执行 Agent probe。
- **RT-ENV-02**：只有 Active Repository Trust 才允许环境 probe；它在应用拥有的中立目录、清理后的环境和显式 executable path 下运行，不以 Repository / Worktree 为 cwd，也不使用 login shell。
- **RT-ENV-03**：实际启动前必须生成不可变的 Environment Snapshot，至少包含 executable identity、版本、argv hash、作为 cwd 的 `WorktreeTargetBinding`、显式 PATH、继承变量 allowlist 和 secret reference。Existing binding 保存已观察的 filesystem identity；Planned binding 保存计划 path / Repository / branch，Ready transaction 另行固化实际 cwd identity。启动后不因 Host PATH 或 shell 配置变化而漂移。
- **RT-ENV-04**：Environment Snapshot 与 Permission Mapping、Adapter Capability 和 `baseCommitSha` 一同展示，并通过 RT-CMD-14 的 receipt 绑定 LaunchIntent；identity、版本或任一 hash 在确认与 exec 之间变化时启动失败并要求重新确认。Planned target 在 Ready transaction 首次记录实际 cwd identity 不算改写 receipt，但结果必须匹配已确认计划，且该 identity 从 Ready 到 exec 不得漂移。
- **RT-ENV-05**：环境诊断与错误不得展开 secret value；找不到可执行文件、版本不支持或环境 probe 失败时返回结构化 CapabilityUnavailable，不回退到任意 shell 搜索。
- **RT-ENV-06**：`executableIdentity` 至少包含 canonical entry path、filesystem identity、entry content hash、interpreter identity（若有）、Adapter 声明的 package / runtime closure manifest、code-signing identity（若存在）、`observedAt` 与 `identityCoverage`。Adapter 不能产生其支持版本所需的完整 coverage 时返回 `CapabilityUnavailable`，不得只凭版本字符串签发 Launch Confirmation。bootstrap 在 `CommitLaunch` 前重新验证全部 coverage；可检测漂移时 fail closed，但该观察不宣称锁住随后可能被同用户外部进程改写的文件。

### 9.2 Agent Adapter

- **RT-ADAPTER-01**：每个 Agent Adapter 实现同一稳定 Interface：Host 级 discovery、受信任上下文 prepare、launch specification、Capability / Permission Mapping 和 Observation ingestion。
- **RT-ADAPTER-02**：只有 Active Trust 后的 verified discovery 才返回 executable identity、CLI version、支持的版本范围与 Capability；未知或超出范围的版本默认阻止启动，除非该 Adapter 有明确的兼容策略与 fixture。首次确认前的 candidate discovery 只返回 RT-ADAPTER-06 允许的候选信息。
- **RT-ADAPTER-03**：核心 Module 只按 Capability 决策，不按 Agent 名称、版本字符串或 Full / Launch-level 标签分支。
- **RT-ADAPTER-04**：Hook、Transcript 与其他增强 Observation 缺失、超时或解析失败时只降低 confidence 并记录诊断，不阻断 Agent、伪造终态或改变退出事实。
- **RT-ADAPTER-05**：R1 的首个真实 Adapter 形成候选 Interface；R2 必须以第二个真实 Adapter 和共享契约 fixture 证明新增 Agent 不修改核心 Task Orchestrator、Session Runtime 或 Worktree Manager。
- **RT-ADAPTER-06**：Repository Trust 前的 candidate discovery 不执行 Agent，只能形成基于安装信息的候选 executable。Trust 为 Active 后才由 Host Environment 在中立 cwd 验证 executable identity / 版本，Adapter 随后返回可用于 Launch Confirmation 的 Capability 与 Permission Mapping；实际 Agent 进程只在 CommitLaunch 后进入目标 Worktree。
- **RT-ADAPTER-07**：Adapter `prepare` 只能从有界、已验证的 Task / Profile / Environment / Repository metadata 构造结构化 launch specification；它不得启动 Agent / shell、执行 Repository 文件、展开 secret value、调用未声明的 Git / File Interface，或把 Repository 配置转成 executable payload。需要执行 Agent 才能取得的事实只能来自 RT-ADAPTER-06 的中立 probe，目标 Worktree 中的执行只能发生在 CommitLaunch。

## 10. Notification Contract

```text
NotificationIntent = {
  notificationIntentId,
  dedupeKey,
  taskId,
  attemptId?,
  eventType,
  route,
  contentClass,
  createdAt,
  deliveryState: Pending | Delivered | Failed | Acknowledged,
  lastErrorCode?
}
```

- **RT-NOTIFY-01**：产生用户可见通知的权威状态转换与 Notification Intent 在同一 SQLite transaction 中提交；Daemon 不依赖 Electron Renderer 存活来决定是否通知。
- **RT-NOTIFY-02**：`dedupeKey = {eventType, taskId, attemptId?, authoritativeStateVersion}`。Notification Gateway 重启、重试或 Electron 重开不得重复投递同一 intent。
- **RT-NOTIFY-03**：Notification Gateway 只消费持久化 intent、投递系统通知并回写 delivery state；它不能创建或修改 Task、Attempt、Session、Artifact 或调度状态。
- **RT-NOTIFY-04**：通知点击只携带稳定 route identity，经 Electron Main 鉴权后打开对应 Task / Attempt；通知 payload 不能包含任意 URL、文件路径、argv 或可执行命令。
- **RT-NOTIFY-05**：通知默认不包含 PTY、Input Intent、Transcript、Repository 私密路径或 secret；锁屏可见内容使用最小摘要。
- **RT-NOTIFY-06**：Delivered、Failed 或用户忽略通知都不改变 Attempt 结果。失败按有界退避重试并形成诊断 Observation；超过预算后保持 Failed，不循环唤醒应用。

## 11. Distribution Contract

```text
SupportedPlatformMatrix = {
  matrixVersion,
  architecture: arm64,
  minimumMacOSVersion,
  minimumHardware: {
    machineModel,
    cpuClass,
    gpuClass,
    memoryBytes
  },
  electronVersion,
  nodeRuntimeVersion,
  nodePtyArtifactIdentity,
  terminalPackageSetIdentity,
  runtimeLimitProfileVersion,
  rendererPaths: [WebGL2, DOM],
  keychainPolicyVersion,
  signingAndNotarizationPolicyVersion,
  evidenceRefs
}
```

- **RT-DIST-01**：发布单元精确锁定并签名 Electron、内置 Node runtime、`node-pty` native binary、Daemon、inert bootstrap、Notification Gateway、native FileBroker、native ConfirmationBroker、terminal package set、migration、`SupportedPlatformMatrix` 与 `RuntimeLimitProfile`；构建产出 SBOM 和各 native artifact hash。
- **RT-DIST-02**：LaunchAgent 配置只引用签名应用包内的绝对 executable path，使用最小清理环境且不依赖系统 Node、用户 PATH、login shell 或 Repository 内容。
- **RT-DIST-03**：Electron、Daemon、bootstrap、Notification Gateway、schema、`SupportedPlatformMatrix` 与 `RuntimeLimitProfile` 在启动时执行双向版本握手；不兼容组合 fail closed，并保留只读恢复与诊断路径。
- **RT-DIST-04**：升级先进入 drain：禁止新 Attempt，等待或由用户确认停止 Alive Session 与未决 Process Disposition，验证 backup，再原子切换发布单元并执行 migration；失败时不能留下两个可写 Daemon。
- **RT-DIST-05**：卸载必须展示 Alive Session、非终态 Attempt、未决 Process Disposition、未投递 Notification Intent、Fleet-managed Worktree、本地 Observation 和 Artifact 的处理选择；默认保留数据与 branch，不静默删除。
- **RT-DIST-06**：v1 发布验收针对声明支持的 macOS / Apple Silicon 范围；跨平台的 xterm.js 与 node-pty 选型不构成 Windows 已支持承诺，Windows 需要独立的 Host、安装、PTY 和安全验收。
- **RT-DIST-07**：“完整 app-data 清理”只在全部 Fleet-managed Worktree 已按 SV1-FILE-04..05 和 SV1-FILE-09..10 安全 dispose 后完成。dirty、identity 漂移、Alive Session、未决 Process Disposition 或 unmerged commit 不能被卸载确认越过；此时清理返回 blockers，保留相关 Worktree / branch 与恢复所需 Fleet metadata，并生成不含秘密的人工处理报告。用户可以选择保留数据后卸载应用，但该结果不得标为完整清理。
- **RT-DIST-08**：R0 必须冻结一个 versioned `SupportedPlatformMatrix`，并把它及 `evidenceRefs` 纳入签名 release manifest。每个分发、安全、terminal 与性能结果都记录 `matrixVersion`；最低 macOS、最低硬件、runtime / native / terminal identity 或策略版本变化都会生成新 matrix version，并重新运行受影响 fixture，不能沿用旧结论。
- **RT-DIST-09**：安装、手动升级和直接启动都必须在注册 / 替换 LaunchAgent、写 migration 或启动 Agent 前验证当前 Host 属于 `SupportedPlatformMatrix`。不支持的 OS、architecture、hardware capability 或 native deployment target 返回 `UnsupportedPlatform` 并保持现有数据；不得借助 Rosetta、系统 Node、关闭 DOM fallback 或跳过签名 / Keychain 检查来静默降级。

## 12. Performance Contract

**RT-PERF-08**：发布验收使用 R0 `SupportedPlatformMatrix` 中的最低 macOS 与最低配置 Apple Silicon Mac、10 个 Alive Session、其中一个持续输出 5 MiB/s、持续 60 秒的固定负载；WebGL2 与强制 DOM 两条绘制路径分别运行完整预算。

- **RT-PERF-01**：输入延迟从 Renderer keydown 至 Daemon 确认写入 PTY，median ≤ 75 ms，p99 ≤ 300 ms。
- **RT-PERF-02**：输出延迟从 Daemon 读取 PTY 至 Renderer 应用对应 frame，p95 ≤ 100 ms，p99 ≤ 300 ms。
- **RT-PERF-03**：Session restore 从 attach 至首个 Snapshot 完成渲染并可请求 Control Lease，p95 ≤ 1000 ms，测试 scrollback 为 10,000 行。
- **RT-PERF-04**：Renderer 内存与待处理 frame 数必须满足 `RuntimeLimitProfile` 的硬上限。
- **RT-PERF-05**：`publishedButUnrecoverableFrameCount = 0`，且 Durable Stream Cursor 覆盖范围内的 `missingByteCount = 0`。Daemon 已读取但尚未完成 RT-STO-02 的 bytes 不计为 durable，不能被描述为可恢复；一旦发布或被 cursor 覆盖，崩溃后必须逐字节恢复或显式判定为违反发布门槛。
- **RT-PERF-06**：跨 Session 输入或输出串线数 = 0。
- **RT-PERF-09**：除 RT-PERF-02 的 frame apply 延迟外，必须单独测量从 Daemon 读取 PTY 到受影响 cell 首次完成 presentation 的延迟；WebGL2 与 DOM 各自满足 p95 ≤ 150 ms、p99 ≤ 500 ms。
- **RT-PERF-10**：active / visible、active / hidden、Electron closed 三类负载分别记录 Renderer RSS、Main RSS、Daemon RSS、CPU、paint latency、durable lag 与 Snapshot latency。R0 必须冻结支持硬件上的定量预算，未冻结或超预算不能进入 R1。
- **RT-PERF-11**：hidden Session 不创建持续增长的 Renderer queue；在 RT-PERF-08 负载下隐藏九个 Session 后，其 Renderer 侧增量内存与 CPU 必须保持在 R0 冻结预算内，重新显示时仍满足 RT-PERF-03 且明确呈现 Snapshot 截断。

**RT-PERF-07**：“worst” 不作为发布门槛；所有 percentile 必须记录样本数、`matrixVersion`、硬件、macOS 版本和负载。

## 13. Required Contract Tests

- **RT-T-01**：Renderer 连续重载 10 次，Agent PID 不变，输入输出继续。
- **RT-T-02**：Electron 进程退出后，Agent PID 不变；重新打开可 attach 原 Session。
- **RT-T-03**：control 断连后旧 Attachment 关闭、Lease 撤销且重连得到新 Attachment；stream 单独断连可在同一 Active Attachment 上恢复，二者都不创建重复 Agent，并分别符合 RT-LEASE-06 / RT-LEASE-08。
- **RT-T-04**：重复 start / `RequestAttemptStop` / `CancelTask` / `TerminateSession` / retry / resume / Worktree provision 命令返回同一结果。
- **RT-T-05**：两个 Attachment 并发 acquire、Lease TTL、renew、takeover、MessagePort 关闭与旧 fencing token 均满足 RT-LEASE-01..11。
- **RT-T-06**：旧 generation 或旧 Control Lease 不能 `WriteSessionInput`、`ResizeSession` 或 `TerminateSession`。
- **RT-T-07**：Snapshot + delta 无重复、无缺口；故意删除 seq 时客户端重新取 Snapshot。
- **RT-T-08**：Daemon 强制崩溃后，不把 Restored View 显示为 Alive，也不自动启动 replacement。
- **RT-T-09**：Host 重启模拟后，旧 Attempt 为 Interrupted / Uncertain；只有 RT-CMD-13 的全部条件满足时，显式 resume 才创建一个新 Attempt 和 Session。
- **RT-T-10**：SQLite transaction、chunk rename、chunk index 每个崩溃点都可 Reconciliation。
- **RT-T-11**：对 start、retry 与 resume 分别在 RT-LAUNCH-01..08 每两个步骤之间、最后一次事实验证失败与 `AbortLaunch` / `CommitLaunch` 边界强制崩溃，都不会留下部分 Attempt / Worktree binding、启动重复 Agent 或继续 Aborted nonce。
- **RT-T-12**：SQLite corruption 与 migration 失败按 RT-STATE-27 进入 ReadOnlyRecovery，损坏或不兼容 backup 不能退出该 mode；只有已验证 restore 增加 generation 并回到 Normal。chunk checksum 失败按 RT-STO-03 / RT-REC-10 产生 data gap，不伪造历史。磁盘满分别发生在 Starting / Running / Stopping 时，RT-BP-07 的 reserve 允许先暂停全部相关 producer，并持久化记录 Waiting / StoragePressure，解除后只有 reserve 重建成功才回到保存的 `resumeStatus`。reserve 缺失或无法重建时禁止新 Attempt / resume，且不删除既有 Observation。
- **RT-T-13**：Queued `CancelTask`、Queued Worktree provision failure、Starting failure、Running 正常退出、证据完整/缺失的异常退出和 Stopping 竞态全部遵守 Attempt transition table。
- **RT-T-14**：TaskLifecycle 已 Cancelled 但 Attempt 尚未终止时，TaskView 不遮蔽 currentAttempt；Attempt 终止后 `currentAttemptStatus = null`、顶层为 Cancelled，且 `lastAttemptStatus` 保留该终态。Draft 直接取消、首次终态、retry 与运行中取消 fixture 都分别验证 `taskLifecycle`、`TaskView.status`、`phase`、current / last Attempt identity、status 与 reason 字段。
- **RT-T-15**：10 个并发 Session 在 RT-PERF-08 固定负载和 `SupportedPlatformMatrix` 上满足全部性能预算、`publishedButUnrecoverableFrameCount = 0`、Durable Stream Cursor 内 `missingByteCount = 0` 且无串线。
- **RT-T-16**：Host / Agent 上限竞争、稳定队列顺序、Queued `CancelTask`、Uncertain slot 和 Daemon restart 均满足 RT-SCHED-01..06。
- **RT-T-17**：Alive Session 正常或异常退出后，现有 Active Attachment 保持 identity 但从 Live 重投影为 Restored，旧 Lease 与控制命令立即失效。
- **RT-T-18**：WebGL2 初始化失败和运行中 context lost 都释放 WebGL addon 并切换到 DOM renderer；Agent PID、Session / Attachment identity、Control Lease、cursor、xterm.js parser / buffer 和已渲染终端语义不变。
- **RT-T-19**：同一 PTY byte fixture 在 WebGL2 与 DOM 下产生相同的终端 grid、cursor、selection、输入 bytes 和 Snapshot，覆盖 Unicode / emoji / CJK / IME、alternate screen、reflow、OSC 8 与 mouse mode。
- **RT-T-20**：xterm.js package-set identity 或 Snapshot schema 不兼容、Snapshot 损坏及 Renderer 连续重载时，只从已校验 Snapshot + chunk / delta 重建，不重复或跳过 seq。
- **RT-T-21**：Electron 全程关闭时 Agent 持续输出并退出，Daemon 仍能由 chunk 生成 final Snapshot；重新打开后在 RT-PERF-03 预算内恢复，headless xterm.js Snapshot Worker 从未取得 PTY fd 或产生输入。
- **RT-T-22**：对 UTF-8、CSI、OSC 与 DCS fixture 在每一个 byte 边界切分 frame；Snapshot 只推进到 `parserGround && utf8DecoderEmpty`，Snapshot + delta 的最终 grid、cursor、title 与 parser state 和不切分回放一致。
- **RT-T-23**：在 chunk checksum、文件 fsync、rename、目录 fsync、SQLite index、Durable Stream Cursor commit 与 publish 的每个边界强制崩溃；恢复后不存在已发布但不可恢复的 frame、cursor 跳跃或静默缺口。
- **RT-T-24**：在 Input Intent content checksum、文件 fsync、rename、目录 fsync、Prepared transaction、node-pty write 和 Dispatched commit 每个边界强制崩溃；缺失 / 损坏 object 不写 PTY，重复 commandId 不自动重放，结果只可能是原成功、明确失败或 Uncertain。
- **RT-T-25**：`RequestAttemptStop`、`CancelTask`、`TerminateSession`、`WriteSessionInput`、`ResizeSession`、start、retry 与 resume 的目标、Lease、destructive confirmation 和 Launch Confirmation 组合逐项验证；一种命令、凭证类型或目标的 receipt 不能用于另一命令、类型或目标。Renderer 伪造 Trust / SideEffect / Launch challenge、展示文本、hash、receipt 或重放已签发 challenge 均被拒绝。停止竞态后 staged / unstaged / untracked fixture 均保留并重新观察，未发生隐式 Git cleanup。
- **RT-T-26**：一个 Attempt 同时含 primary、blocking test runner 与 non-blocking shell 时，primary 退出不提前终结 Attempt；blocking Session 退出后可终结，non-blocking Alive Session 仍可见且阻止 Worktree dispose 与升级。
- **RT-T-27**：Uncertain Attempt 在 Probing、OrphanFound、KeepRequested、StopRequested、ConfirmedAbsent 与 ConfirmedStopped 各状态下重启 Daemon，slot 与 replacement 行为均符合 RT-STATE-23。
- **RT-T-28**：Electron 关闭期间产生通知、Notification Gateway 崩溃重启、重复投递、失败重试与点击路由时，intent 不重复、路由不越权且 Attempt 状态不变。
- **RT-T-29**：Repository Trust 首次确认前用恶意 shell rc、Repository executable、Git config 和 PATH fixture 探测环境，均不执行；PendingValidation 只运行 RT-REPO-02 且不能 probe Agent；Active 后中立 probe 与实际 Environment Snapshot 可复现。entry symlink / inode / content、interpreter、package closure 或 signature 在 Launch Confirmation 后、CommitLaunch 前任一漂移都会阻止启动；coverage 不完整不能只凭版本字符串继续。
- **RT-T-30**：首个与第二个真实 Adapter 都通过共享 fixture；首次 Trust 确认前 candidate discovery 不执行 Agent，PendingValidation 不 probe Agent，Active 后中立 probe 才产生 verified version / Capability / Permission Mapping；恶意 Repository config / Task / Profile 进入 prepare 时只作为有界数据，不执行或变成 shell payload。unsupported version 阻止启动，Hook / Transcript 缺失或损坏只产生 inferred / diagnostic Observation。
- **RT-T-31**：在安装、升级、migration、回滚、LaunchAgent 重载与卸载每个故障点验证签名、版本握手、single-writer、RT-STATE-27 mode、drain、backup 和默认数据保留；Draining 不启动新 Attempt，失败可回到 Normal，migration / restore 验证失败进入 ReadOnlyRecovery。完整清理 fixture 只使用可安全 dispose 的 clean Worktree，另一个 dirty / blocked fixture 必须按 RT-DIST-07 保留并报告，不能伪称完整删除。
- **RT-T-32**：node-pty 以 `encoding: null` 接收包含 NUL、invalid UTF-8 和跨 chunk multibyte sequence 的 Buffer；原始 chunk checksum 与输入逐字节一致，Snapshot replacement character 不污染恢复源。
- **RT-T-33**：Renderer frame 销毁、MessagePort 关闭、后台节流与隐藏终端虚拟化都不会让 Main 继续代续 Lease、积累无界队列、改变 Session identity 或串流到错误 Attachment。
- **RT-T-34**：Snapshot 达到 scrollback / size 上限时截断元数据准确、原始 chunk 仍完整、Restored View 明示截断；active / hidden / Electron closed 三类性能报告满足冻结预算。
- **RT-T-35**：package allowlist 拒绝 `addon-image` 和任意额外 addon；OSC、DCS、image、title、link、clipboard 与 bell fixture 只能触发 TerminalEffectPolicy 允许的有界效果，不能直接调用 Host Interface。
- **RT-T-36**：同一 canonical candidate 在首次确认前不调用 Git；只有未过期、identity 匹配且由 Main 原生确认签发的 RT-REPO-06 receipt 能进入 PendingValidation，Renderer 伪造 / 改写 / 重放不能。PendingValidation 只运行受限验证，成功后原子产生 Active Trust 与 Workspace。普通 working tree、linked worktree 与 detached HEAD 可导入；bare、unborn、损坏、root 不一致和 identity 漂移被拒绝。失败、崩溃、重试、撤销与重新授予都遵守 RT-REPO-05，且不留下未经验证的 Active Trust 或 Runnable Workspace。
- **RT-T-37**：Task specification 与 Profile 修改后，新 Attempt 保存新版本快照，旧 Attempt 快照不变；Profile、SQLite、普通日志和命令行均不存在 secret value，缺失 secret reference 不回退到 ambient credential。
- **RT-T-38**：在 Git worktree / branch 创建前后、Ready transaction 前后和 Reconciliation 每个边界强制崩溃，并制造 path / branch collision 及 provision 期间 CancelTask 竞态；所有 record 状态与 role 遵守 RT-WORKTREE-10。已取消 Attempt 的完整匹配结果只成为 Ready + Historical，部分或无法证明的结果成为 Orphaned；相同命令最多接纳一个 identity 匹配的 Worktree，绝不覆盖外部目录、创建重复 branch 或启动 Agent。
- **RT-T-39**：首次 start 只接受 CreateFromBase；含 staged、unstaged 与 untracked 内容的 Worktree 分别执行三种 retry / resume mode：Continue 精确保留并复用，Rebaseline / FromCommit 创建新 Worktree 且不复制；错误 command / mode 组合、Alive Session、未决 Process Disposition、identity 漂移与外部占用会阻止执行。
- **RT-T-40**：Fleet 与 Task projection 在 Queued / Starting / Running / Waiting / Stopping、Task 已取消但 Attempt 未终止、last Attempt 已终止且 current Attempt 为 null、retry 创建新 current Attempt、inferred Observation 与 stale cache 下分别返回 RT-PROJ-01..03 的独立 identity、状态、reason、confidence 和 freshness 字段。
- **RT-T-41**：Adapter 无 Resume Capability、Process Disposition 仍为 Probing / OrphanFound / KeepRequested / StopRequested、Launch Confirmation 缺失 / 过期 / hash 漂移、Existing filesystem identity / `stateFingerprint` 漂移、Planned target binding 与 Ready 结果不一致或 Worktree mode 被阻止时，resume 不创建 LaunchIntent / Session，且在创建 Attempt / 新 Worktree 前发现的失败也不创建二者；start / retry 同样拒绝错误 receipt。fixture 覆盖 receipt 接受后排队、幂等重放、排队期间外部改动与新 command 复用；条件全部满足时只创建一个新 Attempt 与 Session，并按 mode 恰好复用一个现有 Worktree 或创建一个新 Worktree。
- **RT-T-42**：remote-tracking ref 故意保持陈旧并配置可访问 remote 时，status / diff / ahead / behind 不发起网络请求，结果绑定本地 comparison SHA、`observedAt` 与 `refFreshness = LocalObservationOnly`，UI 不显示为当前 remote 事实。
- **RT-T-43**：Agent 自述“测试通过”但 Fleet 未运行测试时只产生 inferred claim；Fleet 运行成功、失败、超时、输出缺失时，以及 Artifact content 在 checksum / fsync / rename / directory fsync / record transaction 各边界崩溃或随后损坏时，结果页分别保留命令、exit code、hash、provenance、confidence 与 data gap，且不互相覆盖。
- **RT-T-44**：dirty / unmerged / identity 漂移 Worktree 下请求完整清理时返回 blockers、保留 Worktree 与 branch 并生成处理报告；全部 Worktree clean 且 safely disposed 时才删除 app-owned data 并报告 complete。
- **RT-T-45**：在 `SupportedPlatformMatrix` 的最低 macOS / 最低硬件 fixture 上验证 Electron WebGL2 与 DOM、node-pty native artifact、Keychain、签名、公证和 LaunchAgent；低于最低版本、Intel、缺少声明 capability 或 native deployment target 不匹配的 fixture 在写 migration 或启动 Agent 前按 RT-DIST-09 拒绝。更改 matrix 任一受约束字段后，旧 `matrixVersion` 的验收结果不能计入新版本。
- **RT-T-46**：对 `RuntimeLimitProfile` 每个字段分别发送 `limit - 1`、`limit`、`limit + 1` 与恶意溢出 / 长度不一致 fixture，并覆盖 Daemon、Main、Renderer、worker 及跨 Session 并发；边界内行为一致，越界在分配或副作用前按 RT-LIMIT-02 失败或产生明示截断，旧 `profileVersion` 的结果不能计入新版本。
