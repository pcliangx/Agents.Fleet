---
status: accepted
---
# Agent 经独立 Adapter 接入，核心流程按 Capability 运行

异构 CLI Agent 的 Hook、Transcript、Resume 和权限能力并不整齐，新增或升级某个 Agent 也不应触碰共享大文件。决定：每个 Agent 由一个独立、可单独测试的 `AgentAdapter` Module 接入，对核心流程提供小而稳定的发现、准备、启动与观察 Interface，并返回显式 Capability 集合。核心流程只按 Capability 决策，不按 Agent 名称或 Tier 分支；Full / Launch-level 仅作为 UI 汇总标签。Adapter 与应用一同发布和升级，必须声明并验证所支持的 Agent CLI 版本范围，未知或不兼容版本不得静默按已支持版本运行。

发现分为两个阶段：Repository Trust 首次确认前只读取应用安装信息与文件系统 identity 等 Host 级元数据，形成 candidate executable，不执行 Agent、Git、shell 初始化或 Repository 内容，也不声称已经得到实际 Capability / Permission Mapping。PendingValidation 只运行受限 Git 验证；Trust 变为 Active 后，Host Environment 才在应用拥有的中立目录、清理后的环境和显式可执行路径下执行版本与 Capability probe，Adapter 根据已验证 entry、interpreter、package / runtime closure identity 与 coverage 生成实际 Permission Mapping；不能产生完整 coverage 时该版本不受支持。Adapter `prepare` 只把已验证 metadata 归一化为结构化 launch specification，不执行 Agent / shell / Repository 文件，也不把配置拼成 executable payload。其他声明过的 Repository 只读查询与真正启动 Agent 是后续独立步骤，只有实际 `CommitLaunch` 才进入目标 Worktree。每次启动、retry 或 resume 都用独立 Launch Confirmation 固定 launch closure identity、版本、argv、Environment Snapshot、Permission Mapping、Worktree target binding 与 `baseCommitSha`；challenge 由 Daemon 生成，receipt 只能由 Electron Main 的原生确认签发，Repository Trust 或 Renderer 自绘 UI 都不能代替这次确认。

## Considered Options
- 集中式 switch / normalizer——否，局部性差，新增或升级 Agent 都要改共享大文件。
- 固定 Full / Launch-level 方法集合——否，能力组合并非只有两种，最终会泄漏 optional method 和 Agent 特例。
- 动态加载第三方 Adapter——v1 不做；没有第二种部署方式时，动态装载 Seam 只是额外负担。

## Consequences
R1 的首个真实 Adapter 只能形成候选 Interface，R2 的第二个真实 Adapter 才验证这个 Seam。每个真实 Adapter 必须通过同一套契约 fixture，并报告 executable identity、CLI 版本、支持范围和 Capability。Hook 与 Transcript 是观察增强：缺失、超时或解析失败时不得阻断或改写 Agent 生命周期，只能降级为 inferred Observation；缺少 Resume 时不得提供恢复操作。
