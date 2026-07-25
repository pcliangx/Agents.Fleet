---
status: accepted
---
# Agent 经独立 Adapter 接入，核心流程按 Capability 运行

异构 CLI Agent 的 Hook、Transcript、Resume 和权限能力并不整齐，新增或升级某个 Agent 也不应触碰共享大文件。决定：每个 Agent 由一个独立、可单独测试的 `AgentAdapter` 模块接入，对核心流程提供小而稳定的发现、准备、启动与观察 interface，并返回显式 Capability 集合。核心流程只按 Capability 决策，不按 Agent 名称或 Tier 分支；Full / Launch-level 仅作为 UI 汇总标签。Adapter 与应用一同发布和升级，兼容性目标是声明并验证所支持的 Agent CLI 版本范围。

## Considered Options
- 集中式 switch / normalizer——否，局部性差，新增或升级 Agent 都要改共享大文件。
- 固定 Full / Launch-level 方法集合——否，能力组合并非只有两种，最终会泄漏 optional method 和 Agent 特例。
- 动态加载第三方 Adapter——v1 不做；没有第二种部署方式时，动态装载 seam 只是额外负担。

## Consequences
R1 的首个真实 Adapter 只能形成候选 interface，R2 的第二个真实 Adapter 才验证这个 seam。每个真实 Adapter 必须通过同一套契约 fixture，并在发现阶段报告 CLI 版本和 Capability。缺少权威 Hook 或 Transcript 时产生的状态必须标记 inferred；缺少 Resume 时不得提供恢复操作。
