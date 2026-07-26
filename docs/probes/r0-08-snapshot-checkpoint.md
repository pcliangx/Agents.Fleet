# R0-08 — Snapshot 安全 checkpoint 证明

> Branch: `worktree-r0-08-snapshot-checkpoint`。验证 RT-ORDER-08 / RT-TERM-12 / RT-TERM-13 / RT-T-22：锁定 xterm 包能否证明 Snapshot 的 `parserGround && utf8DecoderEmpty` 安全 checkpoint。
> 实测于 2026-07-26，xterm 6.0.0（`@xterm/headless` 6.0.0，RT-TERM-01 锁定集）。

## 问题

Snapshot 的 `coversThroughSeq` 必须落在「parser 不在 CSI/OSC/DCS/escape 中」且「UTF-8 decoder 没有跨 frame 残留」的 checkpoint（RT-ORDER-08）。xterm.js `write` 的 completion callback 只表示本次写入处理完成，**不能单独证明**这两个条件。R0 必须确认锁定包上能否可验证地证明二者；若上游公开 API 不能，按 RT-TERM-13 验证一个最小下游 patch。

## 结论

**在锁定 xterm 6.0.0 上，两个状态都可通过 `_core` 逃生口检测，byte-split fixture 证明分类正确且切分透明。但该路径是内部逃生口、非稳定公开 API，因此 RT-TERM-13 的 minimal patch 是「稳定保证」的退出条件——在 patch 落地前 Snapshot 不得越过最后已证明 checkpoint。**

可检测路径（实测）：

- **parserGround** = `_core._inputHandler._parser.currentState === 0`。实测：纯文本 / 完成序列后 `0`（GROUND）；mid-CSI `4`；mid-OSC `8`；mid-escape 非 0。任一非 0 = unsafe。
- **utf8DecoderEmpty** = `_core._inputHandler._utf8Decoder.interim[0] === 0`。实测：半字节时 `interim` 为 `[228,0,0]`/`[240,159,0]`（pending lead+cont），完成后 `[0,0,0]`。lead 字节恒 ≥ 0xC0，故 `interim[0] === 0` ⟺ 无残留。
- **safeCheckpoint** = parserGround && utf8DecoderEmpty。

`HeadlessTerminalSurface.isSnapshotSafeCheckpoint()` 实现该检测（`packages/terminal/src/headless-surface.ts`）。

## RT-T-22 byte-split fixture（证据）

`packages/terminal/src/__tests__/snapshot-checkpoint.test.ts`：序列 `"AB" | 人 | ESC[2;3H | ESC]0;Hi BEL | "Z"`（UTF-8 / CSI / OSC），在每个 byte 边界 `i` 切分为 `[0:i] + [i:]`：

1. **分类正确**：检测器在每个边界返回 safe 当且仅当该边界结束于一个完整序列（`{1,2,5,11,18}`），其余（mid-multibyte / mid-CSI / mid-OSC）均为 unsafe。
2. **切分透明**：对每个 `i`，先喂 `[0:i]`（seq 1）、再喂 `[i:]`（seq 2），最终 grid/cursor/checkpoint == 不切分回放。

这证明：SnapshotCoordinator 只在 safe checkpoint 推进 `coversThroughSeq`、剩余 durable bytes 作 delta，可逐字节精确重建与不切分一致的状态——满足 RT-T-22「最终 grid、cursor、parser state 和不切分回放一致」。

## RT-TERM-13：minimal patch（稳定性退出条件）

`_core` 是 xterm.js 的内部逃生口（上游明确「may change」），**不是稳定公开 API**。因此 RT-TERM-12「以受支持 package set 可验证的状态」在「稳定保证」意义上尚未满足，按 RT-TERM-13 需要一个 minimal downstream patch：

- **Patch 目标**：把 `parserGround` + `utf8DecoderEmpty` 暴露为稳定公开 API（首选上游 PR：在 `@xterm/headless` Terminal 上暴露一个 `checkpointState`/`isParserGround`+`isUtf8DecoderEmpty` 访问器；或 Agents.Fleet 维护一个有 owner/hash/回归 fixture 的最小下游补丁，读同样的内部字段）。
- **Owner**：Agents.Fleet（直到上游暴露稳定 API）。
- **Patch hash / fixture**：当下无 downstream patch（用 `_core`）；一旦补丁落地，记录 patch hash 并以 `snapshot-checkpoint.test.ts`（RT-T-22）为回归 fixture。
- **升级预算**：每次 xterm package set 升级（RT-TERM-10）重跑 byte-split fixture；若 `currentState`/`interim` 路径漂移，检测器测试即红、阻止升级。
- **删除条件**：上游公开稳定 API 后，切换到该 API 并移除 `_core` 访问 + 本补丁。

在 patch 落地前，Snapshot 实现不得越过 `isSnapshotSafeCheckpoint()` 返回真的最后 checkpoint；不得以 addon-serialize「看起来正确」降低保证（RT-TERM-13）。

## 边界与后续

- **本 probe 不产出 Snapshot 序列化**（addon-serialize 的 app-owned 非 HTML Snapshot 属 RT-TERM-07/11 实现切片）。此处只证明 checkpoint 可检测 + 状态一致性。
- **title**：RT-T-22 列出 title；OSC 0/2 设 title，fixture 的 OSC 边界分类已证明 OSC 处理到完成；title 的逐字节比较随 serialize Snapshot 切片补（需 `getTitle`/serialize 输出）。
- **DCS**：检测器单测覆盖 mid-DCS（`ESC P 1 q` 无 ST → unsafe）；byte-split fixture 聚焦 UTF-8/CSI/OSC，DCS 行为由检测器单测保证。
- **`_core` 访问的脆弱性**：依赖锁定 6.0.0 的内部字段名；升级预算 + 回归 fixture 是缓解，最终靠 patch 落地。

## 证据与复现

- 检测器 + byte-split fixture：`packages/terminal/src/__tests__/snapshot-checkpoint.test.ts`（26 测试：8 检测器 + 18 byte 边界）。
- 实现：`packages/terminal/src/headless-surface.ts` `isSnapshotSafeCheckpoint()`。
- 复现：`pnpm vitest run packages/terminal/src/__tests__/snapshot-checkpoint.test.ts`。
