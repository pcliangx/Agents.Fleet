# Agents.Fleet

Agents.Fleet 是一个本地优先的 macOS AI Agent 舰队工作台：它让异构 CLI Agent 在 Fleet 独占分配的 Git Worktree 中可靠地并行执行，并提供可恢复、可观察且不夸大进程状态的统一视图；Worktree 只提供 checkout 与调度分离，不是 Agent sandbox。

> Status: design draft. 当前仓库尚无产品实现。

## v1 Promise

- UI 只是投影；用户级 Daemon 拥有 Agent 进程与权威生命周期状态。
- 每次执行、retry 或中断后 resume 都创建新的 Attempt，历史不被覆盖。
- UI 关闭或崩溃不终止 Alive Session。
- Daemon 或 Host 重启后执行 Reconciliation，如实显示 Interrupted / Uncertain；不宣称原进程跨机器重启存活。
- Repository 默认 untrusted；Repository Trust 与逐次 Launch Confirmation 分离，v1 不宣称 Fleet 能 sandbox 外部 Agent。
- Electron Renderer 使用精确锁定版本的 xterm.js，以 WebGL2 渲染并强制提供 DOM 回退；node-pty 以原始 Buffer 模式只运行在 Daemon。
- PTY frame 先完成 durable storage 再发布；Snapshot 只覆盖可证明的 terminal 安全 checkpoint，剩余内容作为 delta 恢复。
- 原始 PTY / Input Intent / 恢复 Snapshot / Artifact content 按敏感本地数据保护；只有派生时间线、日志和默认导出做 best-effort redaction。
- v1 仅承诺 Apple Silicon macOS；发布包严格实现 `RT-DIST-01` / `SV1-SUPPLY-01` 的签名 release manifest，不依赖系统 Node。

## Documentation

- [v1 product spec](docs/specs/v1.md)
- [v1 runtime contracts](docs/specs/runtime-contracts-v1.md)
- [v1 security contract](docs/specs/security-v1.md)
- [domain language](CONTEXT.md)
- [architecture decisions](docs/adr/)
- [agent documentation rules](docs/agents/domain.md)

`docs/specs/` 是 PRD 与可执行契约的 canonical source；本 README 只提供非规范性摘要。GitHub Issues 用于跟踪引用 stable requirement ID 的实施切片。
