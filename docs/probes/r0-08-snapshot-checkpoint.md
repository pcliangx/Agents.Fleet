# R0-08 — Snapshot 安全 checkpoint 证明

> Branch: `worktree-r0-08-snapshot-checkpoint`。验证 RT-ORDER-08 / RT-TERM-12 / RT-TERM-13 / RT-T-22：锁定 xterm 包能否证明 Snapshot 的 `parserGround && utf8DecoderEmpty` 安全 checkpoint。
> 实测于 2026-07-26，xterm 6.0.0（`@xterm/headless` 6.0.0，RT-TERM-01 锁定集）。

## 问题

Snapshot 的 `coversThroughSeq` 必须落在「parser 不在 CSI/OSC/DCS/escape 中」且「UTF-8 decoder 没有跨 frame 残留」的 checkpoint（RT-ORDER-08）。xterm.js `write` 的 completion callback 只表示本次写入处理完成，**不能单独证明**这两个条件。R0 必须确认锁定包上能否可验证地证明二者；若上游公开 API 不能，按 RT-TERM-13 验证一个最小下游 patch。

## 结论

**在锁定 xterm 6.0.0 上，两个状态都可通过 `_core` 逃生口检测，byte-split fixture 证明分类正确且切分透明。但该路径是内部逃生口、非稳定公开 API，因此 RT-TERM-13 的 minimal patch 是「稳定保证」的退出条件——在 patch 落地前 Snapshot 不得越过最后已证明 checkpoint。**

可检测路径（实测）：

- **parserGround** = `_core._inputHandler._parser.currentState === 0`。实测：纯文本 / 完成序列后 `0`（GROUND）；mid-CSI `4`；mid-OSC `8`；mid-escape 非 0。任一非 0 = unsafe。
- **utf8DecoderEmpty** = `_core._inputHandler._utf8Decoder.interim[0] === 0`。实测：半字节时 `interim` 为 `[228,0,0]`/`[240,159,0]`（pending lead+cont），完成后 `[0,0,0]`。有效 UTF-8 的 lead 字节恒 ≥ 0xC0，故无残留时 `interim[0] === 0`。该判据是**充分**的安全条件（防御性：若 slot 0 出现 stray continuation 字节，`!= 0` 仍判 unsafe，绝不会把不安全误判为安全）。
- **safeCheckpoint** = parserGround && utf8DecoderEmpty。

`HeadlessTerminalSurface.isSnapshotSafeCheckpoint()` 实现该检测（`packages/terminal/src/headless-surface.ts`）。

## RT-T-22 byte-split fixture（证据）

`packages/terminal/src/__tests__/snapshot-checkpoint.test.ts` 对两类 fixture 各在**每个 byte 边界** `i` 切分 `[0:i] + [i:]`：

1. **UTF-8 + CSI + OSC**：`"AB" | 人 | ESC[2;3H | ESC]0;Hi BEL | "Z"`（safe 边界 `{1,2,5,11,18}`）。
2. **DCS**：`ESC P z hi ST`（未注册 final `z` → no-op，ST 终止；内部每个偏移均 mid-DCS/mid-ST → unsafe，仅完整 ST 后 safe）。

每条断言：(a) 检测器对每边界返回 safe 当且仅当它结束于完整序列；(b) 切分回放 `[0:i]+[i:]` 的最终 **grid / cursor / title / checkpoint** == 不切分回放。覆盖 RT-T-22 列出的 UTF-8 / CSI / OSC / DCS 四类 + grid / cursor / title 三个观测量。

> 「parser state」一致性：fixture 比对的是 `parserGround && utf8DecoderEmpty` 这个 boolean + 可观测的 grid/cursor/title。更深的 parser mode / alt-screen 等逐字段比较属于 Snapshot 序列化（addon-serialize）切片；本 probe 的 parser-state 证据是「同一 boolean 在切分/不切分下一致 + 检测器分类正确」。

## RT-TERM-13：minimal patch（稳定性退出条件）

`_core` 是 xterm.js 的内部逃生口（上游明确「may change」），**不是稳定公开 API**。因此 RT-TERM-12「以受支持 package set 可验证的状态」在「稳定公开 API」意义上尚未满足。R0-08 的处理（满足 RT-TERM-13 的 artifact 集合）：

- **R0 验证（detectability）**：已由 `_core` 运行时访问 + byte-split 回归 fixture 证明——两状态在锁定 6.0.0 上**正确可检测**。源码级 patch 会读**同一组内部字段**，故 `_core` 访问是更小的等价验证形式。
- **Owner**：Agents.Fleet（直到上游暴露稳定 API）。
- **「Patch」形态与 hash**：当下**无源码 diff**——「patch」以「锁定包 + `_core` 运行时访问契约」的形态存在，而非修改 xterm 源（xterm 6 产物是 bundled/minified，源码 patch 脆弱、维护重，是更重的退出路径）。其完整性由 **xterm 包的 lockfile integrity hash**（RT-TERM-01 pin 强制）保证；这与 RT-TERM-13「patch hash」的完整性意图等价。若将来产出真正的源码 patch（上游 PR 或 fork），届时记录其 patch hash。
- **回归 fixture**：`snapshot-checkpoint.test.ts`（RT-T-22，32 测试）。
- **升级预算**：每次 xterm package set 升级（RT-TERM-10）重跑 byte-split fixture；若 `currentState` / `interim` 路径漂移，检测器测试即红、阻止升级。
- **删除条件**：上游公开稳定 API（或在某次升级中 `_core` 路径不可用而被迫 fork）后，切换到该 API / fork 并移除 `_core` 访问。

在稳定公开 API（或带 hash 的源码 patch）落地前，Snapshot 实现不得越过 `isSnapshotSafeCheckpoint()` 返回真的最后 checkpoint；不得以 addon-serialize「看起来正确」降低保证（RT-TERM-13）。

## 边界与后续

- **本 probe 不产出 Snapshot 序列化**（addon-serialize 的 app-owned 非 HTML Snapshot 属 RT-TERM-07/11 实现切片）。此处只证明 checkpoint 可检测 + 状态一致性。
- **DCS / title 已覆盖**：byte-split fixture 现含 DCS（`ESC P z hi ST`）逐边界切分；title 经 `HeadlessTerminalSurface.getTitle()` 在切分/不切分间比较。检测器另单测 mid-DCS（`ESC P 1 q` 无 ST → unsafe）。
- **`_core` 访问的脆弱性**：依赖锁定 6.0.0 的内部字段名（`_parser.currentState` / `_utf8Decoder.interim` / `_windowTitle`）；升级预算 + 回归 fixture 是缓解，最终靠稳定公开 API / patch 落地。

## 证据与复现

- 检测器 + byte-split fixture：`packages/terminal/src/__tests__/snapshot-checkpoint.test.ts`（32 测试：8 检测器 + 18 UTF-8/CSI/OSC 边界 + 6 DCS 边界）。
- 实现：`packages/terminal/src/headless-surface.ts` `isSnapshotSafeCheckpoint()` / `getTitle()`。
- 复现：`pnpm vitest run packages/terminal/src/__tests__/snapshot-checkpoint.test.ts`。
