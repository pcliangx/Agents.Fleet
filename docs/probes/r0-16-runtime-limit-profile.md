# R0-16 RuntimeLimitProfile freeze（含性能预算）

Issue: [#15](https://github.com/pcliangx/Agents.Fleet/issues/15)

## Question

Can Agents.Fleet freeze a versioned `RuntimeLimitProfile` covering every
"bounded / hard limit" requirement (RT-LIMIT-01) plus the quantitative
performance budgets RT-PERF-10 requires before R1 — and prove the pure
boundary guard that every component will share (RT-LIMIT-02), with the
`SupportedPlatformMatrix` bumping to a new version per RT-DIST-08?

## Canonical contracts

- `docs/specs/runtime-contracts-v1.md`: §2.1 `RuntimeLimitProfile` schema,
  RT-LIMIT-01..03, §12 RT-PERF-01..11, RT-T-46
- `docs/specs/v1.md`: R0 exit — 冻结 `RuntimeLimitProfile`（统一全部硬上限）
  与定量性能预算，未冻结不进 R1
- `docs/specs/security-v1.md`: SV1-AUTH-06（transport 输入按
  `RuntimeLimitProfile` 执行 schema / 大小 / 速率限制）、SV1-TERM-04

## Frozen profile（profileVersion 1）

`packages/contracts/src/frozen-runtime-limit-profile.ts` 冻结 27 个顶层字段 +
10 个 terminal 字段。数值来源分三类（逐字段 rationale 见模块注释）：

| 来源 | 字段 |
| --- | --- |
| spec 原值 | `taskFieldBytes` 512 KiB / `taskSpecBytes` 1 MiB（RT-TASK-01）；`terminal.scrollbackLines` 10,000（RT-PERF-03 参考负载） |
| R0-06 实测 | `attachmentQueueBytes` 1 MiB / `attachmentQueueFrames` 32（byte cap 边界 1,048,577、frame cap 边界 33 实测）；`streamFramePayloadBytes` 64 KiB（实测 ~65,537 B/frame） |
| a-priori 目标 | 其余全部字段（工程边界，rationale 在模块注释；R4 在矩阵最低硬件 fixture 上验证）。`streamFramesPerSecond` 240 归此类：实测 80 fps × 3 headroom，是 measurement-derived 而非 measured |

不变量（S1 测试钉住）：`taskFieldBytes ≤ taskSpecBytes ≤ commandPayloadBytes ≤
controlLineBytes`；`attachmentQueueBytes ≥ streamFramePayloadBytes`；
`terminal.pendingInputBytes ≤ inputIntentBytes`。

## Frozen performance budget（budgetVersion 1）

`packages/contracts/src/frozen-performance-budget.ts`：

- 延迟门槛 = spec 原值：输入 median 75 / p99 300 ms（RT-PERF-01）；输出 p95
  100 / p99 300 ms（RT-PERF-02）；restore p95 1000 ms（RT-PERF-03）；
  presentation p95 150 / p99 500 ms（RT-PERF-09）——presentation 按
  `RendererPath` 分轨冻结（WebGL2 与 DOM 各自携带同一门槛，验收分别测量）。
- 固定负载 = RT-PERF-08：10 Alive Session、热 producer 5 MiB/s、60 秒。
- 三类负载预算（RT-PERF-10）：activeVisible / activeHidden / electronClosed
  × { Renderer / Main / Daemon RSS、Renderer / Main / Daemon CPU、
  paint latency、durable lag、snapshot latency }。RSS / CPU / paint / lag 为
  a-priori 目标值（唯一校准点：R0-06 固定负载下 Daemon RSS 增长 ~19 MB、
  event-loop p95 ≈ 11 ms），**R4 必须在矩阵最低硬件（M1 / 8 GiB）fixture
  上验证**——本机 M5 Pro / 48 GiB 高于地板。
- `electronClosed` 的 Renderer / Main 预算为 0（进程不存在）；`activeHidden`
  预算严格低于 `activeVisible`（RT-BP-06 虚拟化必须真正省钱）。

## Implementation

- `packages/contracts/src/frozen-runtime-limit-profile.ts` —
  `FROZEN_RUNTIME_LIMIT_PROFILE` + `RUNTIME_LIMIT_PROFILE_VERSION`（= 1）。
  类型仍在 `limits.ts`。
- `packages/contracts/src/frozen-performance-budget.ts` —
  `FROZEN_PERFORMANCE_BUDGET`（= 1），引用 matrix v4 / profile v1。
- `packages/contracts/src/limit-guard.ts` — 纯、Node-free 边界守卫
  `checkLimit` / `checkTerminalLimit`：cap 为闭区间（limit - 1 / limit 通过、
  limit + 1 违规）；NaN / Infinity / 负数 fail closed（不可信长度字段绝不
  决定预分配）。违规由调用方按表面映射为 `InvalidRequest` /
  `StoragePressure`（RT-LIMIT-02）。
- `packages/contracts/src/frozen-platform-matrix.ts` — 按 RT-DIST-08 升
  `matrixVersion = 4`（R0-16 时 v2；#57→v3 Electron 43；#59→v4 Node 24/pnpm 11；`runtimeLimitProfileVersion = 1` 不变）。
- 版本握手全链路从 placeholder 0 切换到冻结常量：Daemon config
  （`packages/daemon/src/version.ts`）、Electron Main `ClientHello`
  （`apps/desktop/src/main/daemon-client.ts`）、capability-proof transcript
  与各握手测试；`PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION` 已删除。
- `packages/transport/src/prototypes/r0-06-binary-stream/` — provenance 从
  `matrix-frozen-limit-profile-pending` 推进为 `matrix-and-profile-frozen`；
  结果仍不可用作发布验收（需在矩阵最低硬件重跑）。
- `packages/transport/src/prototypes/r0-16-runtime-limit-profile/evidence.ts`
  — `pnpm prototype:r0-16`：对独立来源（RT-TASK-01、RT-PERF gates、R0-06
  实测 caps）交叉核对冻结值，重放边界探针，写
  `docs/probes/r0-16/evidence.json`。

## TDD evidence

四条预确认 seams，全部通过公开接口测试：

1. **S1 冻结 profile 完整性** — `frozen-runtime-limit-profile.test.ts`
   （7 tests）：version、全字段正整数、spec / R0-06 锚点、跨字段不变量、
   matrix 引用。
2. **S2 limit guard** — `limit-guard.test.ts`（13 tests）：limit - 1 /
   limit / limit + 1、0、恶意溢出、NaN / Infinity / 负数 fail closed，
   profile 与 terminal 两个作用域。
3. **S3 握手版本一致性** — matrix v4 / profile v1 贯通既有握手、e2e、
   capability-proof、daemon config 与 R0-06 provenance 测试（这些测试即
   验收：版本不匹配时握手 fatal）。
4. **S4 性能预算冻结** — `frozen-performance-budget.test.ts`（7 tests）：
   spec 延迟门槛原值、RT-PERF-08 固定负载、三负载类完整性与
   electronClosed / hidden 语义。

机器可读核对结果：`docs/probes/r0-16/evidence.json`（`pnpm prototype:r0-16`
→ verdict PASS）。

Full repository verification:

- `pnpm typecheck`: PASS
- `pnpm test`: PASS — 51 files / 388 tests
- `pnpm prototype:r0-16`: PASS
- `pnpm lint`: PASS（仅既有 notice）

## Verdict

The R0-16 freeze is **PASS**: a versioned `RuntimeLimitProfile` (v1) and
performance budget (v1) are frozen with documented provenance; the matrix
bumped per RT-DIST-08 (v2 at R0-16; →v3 via #57 Electron 43; →v4 via #59 Node 24/pnpm 11; profile v1 unchanged); the handshake, capability proof, daemon config
and R0-06 provenance carry the frozen versions instead of a placeholder; and
the shared pure limit guard proves the RT-LIMIT-02 boundary semantics.

## Non-guarantees

This slice does not prove:

- 各组件（Daemon / Main / Renderer / worker）在真实解析 / 分配 / 持久化 /
  转发路径上的 limit 接入（RT-LIMIT-02 的系统侧与 RT-T-46 全矩阵）— R1+；
- a-priori 字段与 RSS / CPU / paint / lag 预算在矩阵最低硬件（M1 / 8 GiB）
  上的验证 — R4（RT-PERF-10 的验收口径）；
- R0-06 结果作为发布性能验收复用 — 同上，需在最低硬件 fixture 重跑；
- 性能预算与 profile 进入签名 release manifest — R5（RT-DIST-01 /
  SV1-SUPPLY-01）。
