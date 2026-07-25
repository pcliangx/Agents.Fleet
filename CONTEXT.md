# Agents.Fleet

本地优先的 AI Agent 舰队工作台的领域语言：把异构 CLI Agent 在独立 Git Worktree 中**可靠地并行执行、观察与恢复**，UI 只是投影，不拥有进程或状态。

> 术语用英文（与代码标识符一致），释义用中文。只收录本项目特有的领域概念，不含通用编程概念。

## Language

### 舰队与执行

**Fleet**:
当前在多个 Worktree 中并行推进的 Task 集合；也是本产品的统称。
_Avoid_: pool, swarm, batch, 舰队池

**Host**:
Agent 实际运行所在的机器。v1 仅为本机 Mac；SSH Host 为后续阶段。
_Avoid_: server, node, machine（用 Host）

**Supported Platform Matrix**:
一个带版本的发布与验收基线，固定最低 macOS、最低 Apple Silicon 硬件，以及 Electron、native runtime、terminal、Keychain、签名和公证兼容性。性能、安全和分发结果必须声明所使用的 matrix version，不能把旧矩阵结论沿用到变更后的支持范围。
_Avoid_: supported machines list, latest macOS

**Runtime Limit Profile**:
一个带版本的全局资源边界，统一 Control / stream、IPC、Task / Profile、Adapter、Observation / Artifact、Notification、Snapshot、Renderer 与 Terminal Surface 的大小、数量、速率和内存上限。各组件必须声明并执行同一 profile version，不能各自保留漂移的默认值。
_Avoid_: magic limits, per-component defaults

**Repository**:
用户打开以进行工作的一个 Git 仓库。
_Avoid_: project（歧义，项目作用域用 Workspace）

**Workspace**:
项目作用域：把一个 Repository 与默认值（Agent、base branch、权限档）绑定在一起。
_Avoid_: project, workspace-config

**Worktree**:
为分离 Task checkout 与 Fleet 调度而创建的 Git worktree。Fleet 管理的一个 Worktree 同一时刻只归属一个 Task；一个 Task 可保留多个历史 Worktree，但至多一个处于 active。它不限制外部 Agent 访问其他 Worktree 或 Host 路径，因此不是安全 sandbox。
_Avoid_: checkout, working copy, branch

**Task**:
一个用户意图单元——交给 Agent 的一个目标。
_Avoid_: job, run, request

**Execution Attempt**(Attempt):
Task 的一次执行尝试。首次执行、重试以及进程丢失后的恢复执行都产生新的 Attempt，绝不覆盖历史。
_Avoid_: run, execution（用 Attempt）

**Interrupted**:
Attempt 的终态，表示进程已确定停止，但没有得到权威完成结果。继续执行必须创建新的 Attempt。
_Avoid_: paused, resumable

**Uncertain**:
Attempt 的终态，表示无法确定最后执行结果或副作用是否发生。它要求用户处理，不能被自动当作成功、失败或可安全重试。
_Avoid_: unknown（过于宽泛）, maybe failed

**Process Disposition**:
Uncertain Attempt 对遗留进程事实的独立记录：正在探测、确认不存在、发现孤儿、用户选择保留、已请求停止或确认停止。它不改写 Attempt 终态，但决定并发 slot 是否仍被占用以及是否允许 replacement。
_Avoid_: uncertain status（它不是另一份 Attempt 状态）, orphan flag

**Terminal Session**(Session):
一个可 attach 的 PTY 生命周期，由 Host Runtime 拥有，跨 UI 关闭或重开存活。一个 Attempt 可有多个 Session（Agent、shell、test runner）；每个 Session 在创建时保存 role 与 completion policy，新的 PTY 生命周期必须使用新的 Session 身份。
_Avoid_: terminal, pty, connection

**Client Attachment**(Attachment):
某个客户端对 Session 的视图。attach 默认只观察；写入必须显式取得 Control Lease。Attachment 具有 Active / Closed / Invalidated 生命周期；control 断开或 Attachment 关闭后的重连创建新 Attachment，单独恢复 stream transport 则不替换仍 Active 的 Attachment、Session 或它的 owner。
_Avoid_: view, pane, tab

**Session Availability**:
Session 的可用性事实：**Alive** 表示权威 owner 与进程仍可确认，**Exited** 表示已观察到正常或异常退出，**Lost** 表示预期中的 owner 已无法确认。
_Avoid_: task status, restored

**Restored View**:
从持久化 Observation 重放出的 Session 画面，不代表进程仍然 Alive，也不允许继续输入。
_Avoid_: resumed session, live view

### Agent

**Agent**:
被引用接入的外部 CLI 编码 Agent（Claude Code、Codex、Kimi、PI、Qoder），绝不重新实现其推理与工具循环。
_Avoid_: model, assistant, bot

**Agent Adapter**(Adapter):
接入一个 Agent 的模块，封装该 Agent 的发现、启动、Observation 归一化与恢复差异。新增 Agent 只能增加 Adapter，不能扩展中央 switch。
_Avoid_: integration, connector, plugin（用 Adapter）

**Adapter Capability**:
Adapter 能可靠提供的一项独立能力，例如 Hook、Transcript、Resume 或 Permission Mapping。核心流程按 Capability 判断行为，不按 Agent 名称分支。
_Avoid_: optional method, agent special case

**Adapter Tier**:
对 Adapter Capability 的展示性汇总：**Full** 表示满足完整观察与恢复基线，**Launch-level** 表示仅保证启动与 Session 观察。Tier 不作为核心流程的行为开关。
_Avoid_: mode, level

**Agent Profile**:
一份版本化的保存选择：Agent、账号 reference、模型或模式、Permission Mode 与 secret reference。Attempt 保存不可变快照，Profile 本身不保存 secret value。
_Avoid_: config, preset

**Permission Mode**:
用户期望授予 Agent 的自主程度：**Manual**、**Balanced** 或 **YOLO**，默认 Balanced。实际可兑现能力由对应 Adapter Capability 决定，不能把不同 Agent 宣称为等价保证。
_Avoid_: trust level, access level

### 观察与产物

**Observation**:
关于 Agent 做了什么的证据：Session 字节、Hook 事件或 Transcript 条目。推断得来的 Observation 必须标注为 inferred。
_Avoid_: log, telemetry, trace

**Artifact**:
一个 Attempt 的持久证据记录，例如 diff、commit、截图或测试结果；带 producer、source、confidence、观察时间、content hash 和 data-gap 状态。Agent 自述不能覆盖随后观察到的 Git、process 或测试事实。
_Avoid_: output, result, deliverable

**Notification Intent**:
Daemon 从权威状态或领域事件持久化的桌面通知意图，具有稳定 dedupe key、目标 Task / Attempt 和投递状态。操作系统是否实际展示通知不改变 Attempt 事实。
_Avoid_: toast event, transient notification

**Input Intent**:
用户或自动化对一个 Session 的一次输入意图，在 bytes 写入 PTY 前 durable 记录来源、目标和敏感内容引用。PTY owner 接受 bytes 后产生 **Dispatched** Observation；这不表示 Agent 已读取或执行。两者之间崩溃时为 Uncertain，绝不自动重放。
_Avoid_: delivered input, command echo

**Safe Snapshot Checkpoint**:
一个同时满足 terminal parser 处于 ground state 且 UTF-8 decoder 没有跨 frame 残留的 Durable Stream Cursor。Snapshot 只能覆盖此类 checkpoint；之后 durable 的原始 bytes 仍以 delta 交付。
_Avoid_: write callback checkpoint, rendered cursor

**Environment Snapshot**:
在启动 Agent 进程前固化的 Host 执行环境事实：entry executable、interpreter 与 package / runtime closure identity 及 coverage、版本、argv hash、cwd 的 Worktree target binding、显式 PATH、允许继承的变量和 secret reference。复用 Worktree 时 binding 含实际 filesystem identity；新建 Worktree 时只绑定预分配 ID、计划 path、Repository identity 与 branch 策略，Ready 后再固化实际 cwd identity。它使授权后的启动不依赖可变 shell 配置，也不伪造尚不存在的文件系统事实。
_Avoid_: ambient environment, shell profile

**Transcript**:
Agent 原生的对话或会话记录；Agent 自己拥有，Agents.Fleet 只读取。它是 AI 会话历史的主要事实源。
_Avoid_: history, chat log

**Hook**:
Agent 向 Agents.Fleet 发出的状态 Observation（working / waiting / done）。Hook **fail open**：坏掉的 Hook 绝不阻塞 Agent。
_Avoid_: callback, webhook, event（用 Hook 指 Agent 发出的状态）

### 信任与控制

**Repository Trust**:
用户对一个 Repository candidate 的显式授权。Daemon 生成绑定 candidate identity 与验证计划的 challenge，Electron Main 用原生 UI 展示并在真实用户手势后签发 receipt；Renderer 不能签发。首次确认后状态为 **PendingValidation**，只允许受限 Git 验证；验证成功并绑定 common Repository identity 后才成为 **Active**，允许中立 Agent probe 与准确启动预览。Trust 本身不创建 Attempt、运行 Agent 或代替逐次 Launch Confirmation。
_Avoid_: Trusted Project, safe repo, allowed project

**Launch Confirmation**:
Repository Trust 变为 Active 后、每次首次启动、retry 或 resume 前的独立确认。Daemon 生成权威 challenge，Electron Main 用原生 UI 展示并在真实用户手势后签发一次性 receipt；Renderer 不能签发。它绑定已验证的 executable identity / 版本、Environment Snapshot、Permission Mapping、结构化 argv、Worktree target binding、`baseCommitSha` 与影响摘要；任一已经绑定的事实漂移都使旧确认失效。
_Avoid_: repository trust（它不是 Repository 的长期信任）, generic approval

**Side-effect Class**:
Fleet 自己发起的一项操作的风险类别：read / reversible / destructive / external，用来驱动确认与策略。
_Avoid_: risk level, severity

**Control Lease**:
一个 Attachment 对 Session 执行 `WriteSessionInput`、`ResizeSession` 或 `TerminateSession` 的当前独占权。观察和 `RequestAttemptStop` 不需要 Control Lease，失效的 Lease 不能继续改变 Session。
_Avoid_: ownership, lock, writer mode

**Durable Stream Cursor**:
Daemon 已完成 chunk、目录与索引持久化，可以在崩溃后继续提供的最大 Session stream cursor。Renderer 已应用 cursor 和 Snapshot safe checkpoint 都不得被当作比它更持久的事实。
_Avoid_: rendered cursor, latest seq

**StoragePressure**:
Session Observation 达到持久化容量限制而无法继续安全接收字节的等待原因。它必须可见，不能通过静默丢弃历史来解除。
_Avoid_: log overflow, dropped output

**Daemon**(Host Runtime):
拥有 Agent 进程与权威生命周期状态的 Host Runtime，独立于任何 UI。Electron 桌面只是它的一个客户端；Daemon 不等同于其中任一 Session。
_Avoid_: service（歧义）, backend, server process（用 Daemon 或 Host Runtime）

**Reconciliation**:
Daemon 启动时把持久化记录与 Host、Session 的可观察事实进行对账，并把不一致显式归类为 Interrupted 或 Uncertain。它绝不把 Restored View 当作 Alive，也不静默重放可能具有副作用的执行。
_Avoid_: recovery（用 Reconciliation 指启动时的状态对账）, resync
