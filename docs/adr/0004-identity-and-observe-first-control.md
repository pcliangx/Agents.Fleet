---
status: accepted
---
# Task、Attempt、Session 与 Attachment 分层，控制权显式取得

恢复、重试、审计和并发观察要求任务、执行、会话与视图不能互相代指。决定：Task、Attempt、Session 与 Attachment 是四种显式身份——UI 窗口关闭不等于 Task 取消，Task retry / resume 创建新 Attempt，新 PTY 生命周期创建新 Session，一个 Attempt 可以拥有 Agent、shell 或 test runner 等多个 Session。Worktree ID 只用于归属检索，不能替代 Session 身份；只有完整 Session ID 能 attach。

attach 只创建观察用的 Active Attachment，不返回 fencing token。客户端必须另行调用 `AcquireControl`，成功后才取得带 fencing token 的 Control Lease；同一 Session 可以有多个观察 Attachment，但同一时刻最多一个 writer。

## Considered Options
- 用 Worktree ID 幂等推导 Session ID——否，Worktree 与 Session 是不同生命周期，retry 和多个 Session 也无法表达。
- 每次 attach 自动取得 Control Lease——否，只读窗口会抢占 writer，多个观察者无法自然共存。
- attach 返回 token、首次写入时再隐式激活——否，权限边界隐蔽，授予与审计时间不清晰。
- 显式身份 + observe-first + `AcquireControl`——是，生命周期与读写意图都清晰。

## Consequences
Attachment 具有 Active / Closed / Invalidated 生命周期；Attachment 关闭、失效或 control 重连都不能复用旧 identity，stream transport 单独恢复可以继续绑定仍 Active 的 Attachment。Control Lease 只授予 Alive Session 的 Active Live Attachment；关闭、认证撤销、generation 变化或 TTL 到期必须撤销 Lease。Snapshot 必须声明 `coversThroughSeq`；旧 generation、Attachment 或 fencing token 不得 input、resize 或 stop。
