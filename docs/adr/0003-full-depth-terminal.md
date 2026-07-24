---
status: accepted
---
# 终端采用全深度渲染,接受补丁维护成本

核心场景是持续观察 CLI Agent,终端体验本身就是产品卖点,不是可后期打磨的边角。决定:终端用全深度渲染——对 xterm.js 与 node-pty 的定制、75ms 按键延迟预算、WebGL 加速、Unicode/emoji 宽度处理、golden 回归截图——叠加完整流式架构(snapshot + 有序 delta + seq + generation + fencing token + 背压)。控制与高频流走分离通道。

## Considered Options
- 完整流式架构 + 上游未打补丁的渲染——否,放弃全深度等于放弃核心卖点的体验差异化。
- 最小化(spawn + tail)——否,关窗/崩溃无法重连同一会话,招牌承诺做不到。

## Consequences
必须持续维护对 xterm.js / node-pty 的定制:跟踪上游版本、重新施打补丁、扩大平台回归矩阵。需指定 owner 与定期升级预算,避免补丁成为隐性技术债。
