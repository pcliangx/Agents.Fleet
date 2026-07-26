# R0-17 原生确认面:challenge → 原生确认 → receipt

Issue: [#40](https://github.com/pcliangx/Agents.Fleet/issues/40)

## Question

能否在 R0 证明三类原生确认(Repository Trust / Launch Confirmation /
destructive SideEffect Confirmation)的核心链路:Daemon 从权威 preview 生成
一次性、按 hash 绑定事实的 challenge;Electron Main 只展示 challenge 的
固定字段、取得真实用户手势后用共享 capability token 签发 receipt;Daemon
恰好接受一次,且伪造 / 改写 / 重放 / 过期 / 跨命令复用 / 事实漂移全部
fail closed —— 而 Renderer 自始至终拿不到签发材料?

## Canonical contracts

- `docs/specs/security-v1.md`:SV1-TRUST-09 / SV1-TRUST-10、SV1-AUTH-10、
  SV1-ELECTRON-07;测试目标 SV1-T-28 / SV1-T-29 的原生确认半侧
- `docs/specs/runtime-contracts-v1.md`:RT-REPO-06、RT-CMD-16 / RT-CMD-17 /
  RT-CMD-18、RT-T-36、RT-T-41 的 receipt 半侧

## Implementation

- `packages/contracts/src/protocol/confirmation.ts` — 三类
  `ConfirmationKind`、`ConfirmationChallenge`(payloadHash + bindingHashes +
  impactSummaryHash + expiresAt)、`ConfirmationReceipt`、`ConsumeFailure`
  六类失败原因;纯逻辑(过期判定、receipt transcript 字段序,与 RT-HS-04
  的 buildProofTranscript 同一纪律)。
- `packages/transport/src/confirmation-proof.ts` — receipt MAC:domain-
  separated(`agents-fleet/confirmation-receipt/v1`)HMAC-SHA256,复用
  RT-HS-04 的 length-prefix framing 与同一 capability token;token 不上
  transport,Renderer 永远不接触(SV1-AUTH-03/08)。
- `packages/transport/src/confirmation-broker.ts` — Main 侧确认流核心
  (seam 化:`fetchChallenge` / `showDialog` / `sign`):调用方只能提供
  challenge ID;challenge 未知、无手势、输入非字符串一律返回 null;dialog
  只收到 `challenge.display`。
- `packages/daemon/src/confirmation/challenge-issuer.ts` — Daemon 签发与
  一次性消费:确定性 canonicalization(排序键 JSON)+ sha256 绑定;
  consume 按序检查 unknown → already-consumed → expired → kind-mismatch →
  binding-drift → invalid-proof;open challenge 数量有界(RT-CMD-17 速率
  限制形状)。
- `apps/desktop/src/main/confirmation-dialog.ts` — 生产 dialog 适配器:
  原生 `dialog.showMessageBox` 只绘制 display 固定字段,默认按钮为 Cancel
  (确认绝不成为误触选项);R1 接入类型化 IPC 通道。

## TDD evidence

四条预确认 seams:

1. **S1 issuer 签发** — hash 确定性、漂移即变、ID 唯一、容量有界
   (`challenge-issuer.test.ts`,3 tests)。
2. **S2 consume 状态机** — 一次有效 + 七类 fail-closed(unknown /
   consumed / expired / kind / drift / 无 token / MAC 错配)
   (同文件,7 tests)。
3. **S3 Main 攻击面** — 伪造 ID / 非字符串输入 / 无手势 / display 来源
   唯一 / 一次手势一张 receipt(`confirmation-broker.test.ts`,5 tests)。
4. **S4 端到端** — 真实 token + dialog spy 全链:一次手势一张可用
   receipt、重放拒绝、cancel 无物、attacker token 拒、漂移拒
   (`confirmation-e2e.test.ts`,4 tests)。

`pnpm prototype:r0-17` 复跑 10 例(3 类 kind happy path + 7 例攻击表),
verdict PASS,机器可读证据:`docs/probes/r0-17/evidence.json`。

Full repository verification:

- `pnpm test`:61 files / 486 tests PASS
- `pnpm typecheck`: PASS
- `pnpm lint`:本 slice 文件全净(仓库既有 notice 未动)

## Verdict

R0 原生确认面 **PASS**:challenge → 原生手势 → capability-token receipt →
一次性消费的完整链路可证明,Renderer 在结构上无法签发、改写或重放;
SV1-ELECTRON-07 / SV1-TRUST-09/10 的机制层(R0 形态)成立。

## Non-guarantees

本 slice 不证明:

- **challenge fetch 的 socket 通道与 Control Dispatcher 命令路由** — 通道
  本身已由 R0-12 证明,命令路由属 R1(#1 stub);
- **consumed 集合的 SQLite 持久化** — R0 为内存实现;Daemon 重启后已消费
  challenge 的防重放属 R1 持久化切片;
- **签名锁定的独立 native ConfirmationBroker 二进制**(SV1-AUTH-10 的
  发布形态)与 asar 打包后行为 — R5;
- **IPC channel 注册与 Renderer 端 preload 方法** — handleTrustedIpc 机制
  已由 R0-11 证明,`af:request-confirmation` 的注册属 R1 命令路由;
- **RT-CMD-14 的完整绑定事实集**(executable identity / Environment
  Snapshot / Permission Mapping 等)— R0 用代表性字段证明机制,完整绑定
  属 R1 LaunchIntent;
- **TTL 与容量数值冻结** — R0 取 60 s / 64(原型参数),是否进
  RuntimeLimitProfile 是后续决策。
