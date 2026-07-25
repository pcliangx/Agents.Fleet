---
status: accepted
---
# 终端以全深度体验为目标，上游补丁须经过证据闸门

持续观察和控制 CLI Agent 是核心场景，终端体验不是可后期打磨的边角；但在没有已测量缺口、owner 或升级预算时，不应预先接受永久下游补丁。决定：v1 先使用上游 xterm.js 与 node-pty 实现全深度体验，并由独立的 control / stream channel、Snapshot、有序 delta、seq、generation、fencing token 与背压组成完整流式契约。只有某项可复现行为或性能验收无法通过，并且已有最小补丁、owner、升级预算及回归测试时，才允许维护下游补丁。

## Considered Options
- 从第一版开始维护下游补丁——否，当前没有已测量的上游缺口或明确 owner。
- 上游版本 + 完整流式架构——是，先用验收数据决定是否需要补丁。
- 最小化 spawn + tail——否，无法可靠 attach 同一个 Session，也无法提供 Restored View。

## Consequences
流协议、持久化和 Session 正确性不能依赖 Renderer 实现。输入延迟、WebGL 回退和 Unicode / emoji 行为必须通过运行时契约验收；golden 截图只补充关键视觉回归。若启用下游补丁，必须把具体缺口、维护责任和退出条件补入本 ADR 的后续 superseding decision。
