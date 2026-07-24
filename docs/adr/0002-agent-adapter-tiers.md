---
status: accepted
---
# Agent 经版本化 Adapter 接入,分 Full / Launch-level 两档

要支持 5 个异构 CLI Agent,且新增或升级某个 Agent 不能触碰共享大文件。决定:每个 Agent 一个独立、版本化、可单独测试的 `AgentAdapter`,声明发现、启动、Hook、状态归一化、resume 能力。v1 中 Claude Code / Codex / Kimi 做 **Full** 档(Hook + 状态 + transcript + resume),PI / Qoder 做 **Launch-level** 档(仅 spawn + 终端 + 推断状态),Launch-level 以后按优先级升级 Full。

## Considered Options
- 集中式 switch / normalizer——否,局部性差,新增或升级 Agent 都要改共享大文件。
- 全部 Full——否,v1 范围过大,且首个 Adapter 无法被第二个验证接口是否成立。

## Consequences
Adapter 接口是契约边界,改动需考虑向后兼容;Launch-level Agent 的状态是 inferred,UI 必须如实标注。
