---
status: accepted
---
# v1 使用显式 Repository Trust，但不宣称隔离外部 Agent

Agents.Fleet 会启动用户选择的外部 CLI Agent，而这些进程默认继承当前用户在 Host 上的权限；仅靠 Worktree 路径校验无法限制它们访问其他目录或发起网络副作用。决定：Repository 在用户明确授予 Repository Trust 前不得启动代码、脚本或 Agent；Daemon 以当前用户身份运行；v1 只保证 Fleet 自己的文件、Git 与控制命令遵守路径和 Side-effect Class 策略，不宣称 sandbox、拦截或回滚 Agent 内部工具行为。

## Considered Options
- 把 Worktree 路径校验描述为 Agent sandbox——否，这会形成无法兑现的安全承诺。
- v1 引入 VM 或完整 OS sandbox——否，会显著扩大平台、Agent 兼容性和分发范围。
- 显式信任 + 能力披露 + Fleet 自身最小权限——是，承诺范围可验证且与本地优先定位一致。

## Consequences
Permission Mode 必须按 Adapter Capability 展示实际映射和缺口，不能暗示跨 Agent 等价。PTY 与 Transcript 可能包含 Agent 主动输出的秘密，脱敏只能是纵深防御而非绝对保证。若未来要限制 Agent 的文件或网络权限，必须新增 sandbox ADR 和独立安全验收。
