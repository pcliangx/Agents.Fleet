# Agents.Fleet

本地优先的 AI Agent 舰队工作台的领域语言:把异构 CLI Agent 在独立 Git Worktree 中**可靠地并行执行、观察与恢复**,UI 只是投影,不拥有进程或状态。

> 术语用英文(与代码标识符一致),释义用中文。只收录本项目特有的领域概念,不含通用编程概念。

## Language

### 舰队与执行

**Fleet**:
当前在多个 Worktree 中并行运行的 Task 集合;也是本产品的统称。
_Avoid_: pool, swarm, batch, 舰队池

**Host**:
Agent 实际运行所在的机器。v1 仅为本机 Mac;SSH 主机为后续阶段。
_Avoid_: server, node, machine(用 Host)

**Repository**:
用户打开以进行工作的一个 Git 仓库。
_Avoid_: project(歧义,项目作用域用 Workspace)

**Workspace**:
项目作用域:把一个 Repository 与默认值(Agent、base branch、权限档)绑定在一起。
_Avoid_: project, workspace-config

**Worktree**:
为隔离一次 Task 的修改而创建的 Git worktree;并行执行与写入隔离的基本单元。一个 Worktree 挂在一个分支上,但本身不是分支。
_Avoid_: checkout, working copy, branch

**Task**:
一个用户意图单元——交给 Agent 的一个目标。
_Avoid_: job, run, request

**Execution Attempt**(Attempt):
Task 的一次执行尝试;每次运行或重试都产生新的 Attempt,绝不覆盖历史。
_Avoid_: run, execution(用 Attempt)

**Terminal Session**(Session):
一个可 attach 的 PTY 生命周期,由 Daemon 拥有,跨 UI 关闭/重开存活。一个 Attempt 可有多个 Session(Agent、shell、test runner)。
_Avoid_: terminal, pty, connection

**Client Attachment**(Attachment):
某个客户端对 Session 的实时视图;重连只替换 Attachment,不替换 Session 的 owner。
_Avoid_: view, pane, tab

### Agent

**Agent**:
被引用接入的外部 CLI 编码 Agent(Claude Code、Codex、Kimi、PI、Qoder),绝不重新实现其推理与工具循环。
_Avoid_: model, assistant, bot

**Agent Adapter**(Adapter):
接入一个 Agent 的模块,声明发现、启动、Hook、状态归一化、resume 能力。新增 Agent 只能加 Adapter,不能扩展中央 switch。
_Avoid_: integration, connector, plugin(用 Adapter)

**Adapter Tier**:
Adapter 的能力档次——**Full**(Hook + 状态 + transcript + resume)或 **Launch-level**(仅 spawn + 终端 + 推断状态)。
_Avoid_: mode, level

**Agent Profile**:
一份保存的配置:Agent + 账号 + 模型/模式 + 权限档。
_Avoid_: config, preset

**Permission Mode**:
授予 Agent 的自主程度——**Manual**、**Balanced** 或 **YOLO**。默认 Balanced。
_Avoid_: trust level, access level

### 观察与产物

**Observation**:
关于 Agent 做了什么的证据——终端字节、Hook 事件、transcript 条目。推断得来的 Observation 必须标注为 inferred。
_Avoid_: log, telemetry, trace

**Artifact**:
一个 Attempt 的持久产出——diff、commit、截图、测试结果。
_Avoid_: output, result, deliverable

**Transcript**:
Agent 原生的对话/会话日志(Agent 自己拥有;Agents.Fleet 只读取)。AI 会话历史的主要事实源。
_Avoid_: history, chat log

**Hook**:
Agent 向 Agents.Fleet 发出的状态事件(working / waiting / done)。Hook **fail open**:坏掉的 Hook 绝不阻塞 Agent。
_Avoid_: callback, webhook,event(用 Hook 指 Agent 发出的状态)

### 信任与控制

**Trusted Project**:
用户在首次打开时显式信任的 Repository,允许其代码与脚本被执行。
_Avoid_: safe repo, allowed project

**Side-effect Class**:
一个操作的风险类别——read / reversible / destructive / external——驱动确认与审批策略。
_Avoid_: risk level, severity

**Daemon**(Host Runtime):
拥有运行中的 Agent 进程与权威状态的 OS 级服务;独立于任何 UI,跨 UI 关闭/崩溃/重启存活。Electron 桌面只是它的一个客户端。
_Avoid_: service(歧义), backend, server process(用 Daemon 或 Host Runtime)

**Reconciliation**:
Daemon 启动时的恢复过程:扫描 running Attempt,按 Host/Session 的权威状态决定恢复、重派或标记 uncertain;绝不静默重试可能有外部副作用的操作。
_Avoid_: recovery(用 Reconciliation 指启动时的状态对账), resync
