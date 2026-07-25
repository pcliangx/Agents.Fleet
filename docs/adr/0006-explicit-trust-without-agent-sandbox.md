---
status: accepted
---
# v1 使用显式 Repository Trust，但不宣称隔离外部 Agent

Agents.Fleet 会启动用户选择的外部 CLI Agent，而这些进程默认继承当前用户在 Host 上的权限；仅靠 Worktree 路径校验无法限制它们访问其他目录或发起网络副作用。决定：Repository Trust 首次确认前不得启动代码、Git CLI、shell 初始化、Repository 二进制、脚本或 Agent；Daemon 以当前用户身份运行。首次 Trust challenge 由 Daemon 生成，receipt 只能由 Electron Main 的原生确认签发；确认后只进入 PendingValidation，并仅允许受限 Git 验证，验证成功后 Trust 才变为 Active。Active Trust 仍不等于启动授权：Host Environment probe 在应用拥有的中立目录和清理后的环境中执行，每次实际启动还需要绑定准确 executable、Permission Mapping、环境、Worktree target binding 与 `baseCommitSha` 的 Launch Confirmation；其 challenge 同样由 Daemon 生成、由 Main 原生确认签发。只有 `CommitLaunch` 才进入目标 Worktree。v1 只保证 Fleet 自己的文件、Git 与控制命令遵守路径和 Side-effect Class 策略，不宣称 sandbox、拦截或回滚 Agent 内部工具行为。

Fleet 文件操作由私有 FileBroker Implementation 完成：每个命令声明一个已验证的 Repository、Worktree 或 app-data root，并相对该 root 的同一 directory fd 解析与打开目标；平台 `openat` 类能力或等价 native primitive 将检查和打开绑定到同一目录身份，普通 `realpath` 后再按路径打开不足以兑现 TOCTOU 保证。Worktree provision / inspect / dispose 对 common Repository Git directory 的访问只经过受限、结构化 Git Interface，不把它暴露成 Renderer 可浏览 root。provision 的 checkout 必须禁用 hook、filter、submodule 和其他外部程序入口；无法证明 no-external-program materialization 或 Repository 依赖外部 filter 时 fail closed。v1 只允许移除 Fleet 管理、身份再次匹配且已确认 clean、没有 Alive Session 或未决 Process Disposition、也没有相对显式 `integrationTargetSha` 的未合并 commit 的 Worktree，并保留 branch；强制删除脏 Worktree、reset 与 branch delete 不进入产品 Interface。

## Considered Options
- 把 Worktree 路径校验描述为 Agent sandbox——否，这会形成无法兑现的安全承诺。
- v1 引入 VM 或完整 OS sandbox——否，会显著扩大平台、Agent 兼容性和分发范围。
- 显式信任 + 能力披露 + Fleet 自身最小权限——是，承诺范围可验证且与本地优先定位一致。

## Consequences
Permission Mode 必须按 Adapter Capability 展示实际映射和缺口，不能暗示跨 Agent 等价。PTY、Input Intent、恢复 Snapshot、Transcript 与 Artifact content 都可能包含 Agent 或用户主动提供的秘密；原始恢复数据和 Artifact content 必须被视为敏感本地数据，派生内容的脱敏只能是纵深防御而非绝对保证。

Electron Renderer 同样是不可信边界：发布构建使用私有 app protocol、严格 CSP、sandbox、context isolation、关闭 node integration、最小类型化 preload Interface、sender / frame 校验，并默认拒绝 navigation、new-window 与 permission request；安全相关 Electron fuses 在签名和发布验收中校验。若未来要限制 Agent 的文件或网络权限，必须新增 sandbox ADR 和独立安全验收。
