---
status: accepted
supersedes: 0003 (package allowlist enumeration only)
---
# 终端 package allowlist 增加 @xterm/addon-unicode11

ADR-0003 把终端 package allowlist 锁定为 4 个包。R0-09 实测发现 xterm 6 核心默认宽度表把部分 emoji（如 😀 U+1F600）标为 width 1，导致终端列对齐错位，与 v1 终端深度覆盖（RT-T-19 / RT-PERF 列出 emoji）矛盾。决定：allowlist 增加 `@xterm/addon-unicode11`（共 5 个包），它提供 Unicode 11 宽度 / 字素表修正 emoji 与 CJK 宽度。live Terminal 与 headless Snapshot Worker 必须加载同一版本，否则两者的 grid / cursor 不一致，破坏 RT-TERM-01 的 engine identity。

本 ADR **仅 supersede ADR-0003 的 allowlist 枚举部分**（4→5 包）；ADR-0003 的其余内容（xterm.js / node-pty 选型、WebGL2 / DOM 双路径、addon-image 禁用、Snapshot 安全 checkpoint、TerminalEffectPolicy）仍为当前契约。RT-TERM-01 / SV1-TERM-01 的 allowlist 枚举已同步为 5 包，并在 requirement 文末标注 changelog。

## Considered Options
- 接受 width-1 emoji 为 v1 限制——否，与 RT-T-19 / RT-PERF 的 emoji 覆盖意图矛盾，且终端会视觉错位。
- 自维护下游宽度补丁——否，无已测量缺口 / owner / 升级预算；上游官方 addon 已解决。
- 加入 `@xterm/addon-unicode11`（官方 addon，精确锁定 + 随签名应用发布）——是，最小、上游维护、可锁定与签名。

## Consequences
allowlist 从 4 包扩为 5 包；构建清单（RT-TERM-01）/ SBOM（SV1-TERM-01）须多记录一个包的版本与 integrity。该 addon 是 load-bearing：禁用会使 emoji 错位（R0-09 留有对照 fixture，见 `packages/terminal/src/__tests__/headless-surface.test.ts`）。未来若 xterm 核心内置准确宽度表，可经新 ADR 移除该 addon。addon 的生命周期 / 版本握手（卸载、重载、RT-TERM-10 升级）当前为构造期强制加载，待终端 addon 生命周期 slice 细化。
