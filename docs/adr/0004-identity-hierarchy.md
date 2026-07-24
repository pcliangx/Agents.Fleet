---
status: accepted
---
# Task → Attempt → Terminal Session → Client Attachment 显式分层

恢复、重试、审计要清晰,不能让任务、执行、会话、视图互相代指。决定:这四者是不同实体,身份显式分开——UI 窗口关闭 ≠ Task 取消;Task 重试 ≠ 复用旧 Session;一个 Attempt 可有多个 Session(Agent / shell / test runner);客户端重连只替换 Attachment,不替换 Session 的 owner。Worktree ID 只用于归属检索,不能替代 Session 身份:Session ID 是含随机后缀的一等持久身份,只有完整 Session ID 能 attach。

## Considered Options
- 用 Worktree ID 幂等推导 Session ID——否,重连无法稳定定位同一个会话,且 Worktree 与 Session 是不同生命周期。

## Consequences
每次 attach 须返回 fencing token,旧 Attachment 不得继续写输入、resize 或 stop;Snapshot 必须声明 `coversThroughSeq`;generation 变化意味着旧命令与旧事件失效。
