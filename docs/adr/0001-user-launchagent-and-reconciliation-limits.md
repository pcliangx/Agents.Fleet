---
status: accepted
---
# 执行器使用用户级 OS Daemon，并限定进程存活承诺

长任务需要跨 UI 关闭或崩溃继续运行，但当前进程和 PTY 不能被描述为跨 Daemon 崩溃或 Host 重启存活。决定：使用当前登录用户身份运行的 macOS LaunchAgent 作为 Daemon，拥有 PTY、子进程与权威生命周期状态；Electron 只是客户端。所有领域命令经过单一 Control Dispatcher，Electron Main 只作为 transport adapter，不复制领域 handler。执行 Agent 的 Daemon 永不以 root 身份运行。

## Considered Options
- 嵌入 Electron 主进程——否，关闭 app 或主进程崩溃会终止整个 Fleet。
- App 派生的 detached 子进程——否，缺少统一权威状态、自动启动和 Reconciliation。
- 用户级 LaunchAgent——是，既脱离 UI 生命周期，又保持最小用户权限和正确的用户环境。
- 系统级 root LaunchDaemon——否，权限过大，也不适合读取用户的 Agent 配置与凭据。

## Consequences
这个决定只保证 Session 跨 UI 生命周期存活，不宣称进程跨 Daemon 崩溃或 Host 重启存活。Daemon 或 Host 丢失后必须执行 Reconciliation：确定已终止的 Attempt 标记为 Interrupted，无法判断副作用的标记为 Uncertain；任何 resume 都创建新的 Attempt 与 Session，且需要用户显式确认。v1 不引入 per-Session supervisor；若未来要求跨 Daemon 崩溃保持同一 PTY，必须另立 ADR。升级或卸载在存在 Alive Session 时必须阻止或先显式 drain。
