---
status: accepted
---
# Task、Attempt、Session 与 Attachment 分层，控制权显式取得

恢复、重试、审计和并发观察要求任务、执行、会话与视图不能互相代指。决定：Task、Attempt、Session 与 Attachment 是四种显式身份——UI 窗口关闭不等于 Task 取消，Task retry / resume 创建新 Attempt，新 PTY 生命周期创建新 Session，一个 Attempt 可以拥有 Agent、shell 或 test runner 等多个 Session。每个 Session 创建时固化 `role` 与 `completionPolicy`；Attempt 只有在主结果已确定且所有 blocking Session 都不再 Alive 后才能进入终态。非 blocking Session 即使不阻止 Attempt 终态，仍必须可见，并阻止 Worktree dispose 与运行时替换。Worktree ID 只用于归属检索，不能替代 Session 身份；只有完整 Session ID 能 attach。

attach 只创建观察用的 Active Attachment，不返回 fencing token。客户端必须另行调用 `AcquireControl`，成功后才取得带 fencing token 的 Control Lease；同一 Session 可以有多个观察 Attachment，但同一时刻最多一个 writer。`WriteSessionInput`、`ResizeSession` 与 `TerminateSession` 需要 Session 的有效 Control Lease，其中 `TerminateSession` 还需要 destructive confirmation。`RequestAttemptStop` 以 Attempt 为目标，不依赖任一 Attachment Lease，并对当前所有 Alive Session 请求停止；它需要 destructive confirmation。`CancelTask` 以 Task 为目标，并按显式策略级联请求停止其非终态 Attempt。所有 destructive confirmation 都展示 Daemon 生成的目标、state version 与影响 challenge，并只由 Electron Main 的原生确认签发；Renderer 文本不能成为 receipt。

## Considered Options
- 用 Worktree ID 幂等推导 Session ID——否，Worktree 与 Session 是不同生命周期，retry 和多个 Session 也无法表达。
- 每次 attach 自动取得 Control Lease——否，只读窗口会抢占 writer，多个观察者无法自然共存。
- attach 返回 token、首次写入时再隐式激活——否，权限边界隐蔽，授予与审计时间不清晰。
- 显式身份 + observe-first + `AcquireControl`——是，生命周期与读写意图都清晰。

## Consequences
Attachment 具有 Active / Closed / Invalidated 生命周期；Attachment 关闭、失效或 control 重连都不能复用旧 identity，stream transport 单独恢复可以继续绑定仍 Active 的 Attachment。Control Lease 只授予 Alive Session 的 Active Live Attachment；关闭、认证撤销、generation 变化或 TTL 到期必须撤销 Lease。Snapshot 必须声明 `coversThroughSeq`；旧 generation、Attachment 或 fencing token 不得 `WriteSessionInput`、`ResizeSession` 或 `TerminateSession`。

Attempt 的 Uncertain 是不可回写的终态；进程是否仍存在由独立的 Process Disposition 记录。Uncertain Attempt 在遗留进程尚未确认不存在或停止前继续占用调度 slot，也不能启动 replacement；确认不存在、用户选择保留或确认停止只更新 Process Disposition，不改写 Attempt 的历史终态。`KeepRequested` 仍表示进程可能存在，因此继续占用 slot 并阻止 replacement。
