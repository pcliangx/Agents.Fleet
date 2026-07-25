# R0-06 — Binary Stream 吞吐与背压原型

> Branch: `R0-06`. Risk prototype for issue #6.
>
> Contracts: `RT-LIMIT-01..03`, `RT-STREAM-02..06`, `RT-ORDER-01..09`,
> `RT-BP-01..06`, `RT-PERF-04..11`, `RT-T-15`, `RT-T-33..34`, `RT-T-46`,
> `SV1-TERM-04`, `SV1-T-15`.

## Question

在 `RT-PERF-08` 的 10 个 Alive Session 固定负载中，一个 Session 持续产生
5 MiB/s，另一个 Session 的 Renderer 明显慢于 producer，第三个 Session 在运行中
隐藏再恢复。按 Attachment 设置 byte/frame 双重硬上限，是否能够保持 Session identity
隔离、避免 Renderer queue 无界增长，并让慢或隐藏消费者进入显式 Snapshot + delta
resync，而不阻塞健康 Session？

## Verdict

**PASS，且原型修正了一个初始设计错误。**

首轮驱动在每次 QueueLimit 后立即 resync，60 秒产生了 59 次恢复，形成 resync storm。
修正后的策略是：第一次超过 queue limit 时清空不再连续的 live queue，设置
`resyncRequired`，随后只推进 durable head、停止向该 Attachment enqueue；等消费者
明确恢复时只执行一次 Snapshot resync。隐藏 Attachment 使用相同恢复原则。

这个结果支持把以下规则带入后续 StreamBroker / Desktop Bridge 设计：

1. Attachment live queue 同时执行 byte 与 frame cap。
2. 超限不是 silent drop；它是一个显式的 live-continuity break。
3. continuity break 后不做 eager resync，不反复填满同一个慢消费者的 queue。
4. durable ingestion 与其他 Attachment 的 delivery 继续；消费者恢复时从
   Snapshot safe checkpoint + durable delta 重建。
5. 如果压力来自 durable storage 而不是 Renderer queue，仍必须走 `RT-BP-04` /
   `RT-BP-07` 的 producer process-group pause；本原型不能替代该机制。

## Fixed-load result

实测于 2026-07-25，Node v26.4.0，Apple M5 Pro / arm64，运行 60.0047 秒。

| Metric | Result |
| --- | ---: |
| Session count | 10 |
| Hot producer | 5 MiB/s |
| Additional slow producer / consumer | 1 MiB/s / 16 KiB/s |
| Background producers | 8 × 64 KiB/s |
| Payload processed | 408,289,280 bytes |
| Binary frames decoded | 6,230 |
| Achieved aggregate payload rate | 6,804,288 bytes/s |
| Cross-Session / identity / sequence errors | 0 / 0 / 0 |
| Queue limit violations | 0 |
| Slow Attachment peak queue | 984,561 bytes / 15 frames |
| Configured queue cap | 1,048,576 bytes / 32 frames |
| Slow / hidden resync count | 1 / 1 |
| Healthy Sessions caught up to durable head | yes |
| RSS growth, start to measured peak | 39,124,992 bytes |
| Event-loop delay p95 / p99 / max | 11.387 / 11.452 / 16.597 ms |

所有 machine-readable acceptance 字段为 `true`。完整原始结果见
[`r0-06/evidence.json`](./r0-06/evidence.json)。

## Prototype layout

- `packages/transport/src/prototypes/r0-06-binary-stream/model.ts`：可移植的纯状态模型。
- `packages/transport/src/prototypes/r0-06-binary-stream/tui.ts`：手动推动状态的 throwaway TUI。
- `packages/transport/src/prototypes/r0-06-binary-stream/benchmark.ts`：真实 binary
  encode/decode 的固定负载驱动。

运行：

```sh
pnpm prototype:r0-06
pnpm prototype:r0-06:benchmark
```

## Boundaries

本结果不证明：

- chunk checksum / fsync / rename / SQLite cursor / publish 的崩溃边界，即 R0-14；
- `publishedButUnrecoverableFrameCount = 0` 或 durable range 的
  `missingByteCount = 0`；
- xterm.js WebGL2 / DOM 绘制、Snapshot parser checkpoint 或 Renderer
  presentation latency，即 R0-08 / R0-09；
- `RuntimeLimitProfile` 的正式数值或 release performance budget，即 R0-16；
- Electron Main MessagePort、真实 socket rate limit 或恶意长度字段的端到端资源上限。

因此本 probe 是背压策略和 framing 吞吐的 R0 风险证据，不是 `SESSION-6` 或
`RT-T-15` 的完整产品验收。
