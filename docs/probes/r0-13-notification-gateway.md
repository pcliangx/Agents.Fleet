# R0-13 — Notification Gateway 风险原型

> 分支：`r0-13/notification-gateway`。本次原型针对 `RT-MOD-11`、
> `RT-NOTIFY-01..06`、`RT-T-28`、`SV1-DATA-09`、`SV1-T-23`。
> 2026-07-26 在 macOS 26.5.2 (25F84) / Apple Silicon 上实测；
> probe 由 pnpm 固定的 Node v24.18.0 运行，SQLite 使用
> `node:sqlite`、WAL、`synchronous=FULL`。机器可读证据见
> [`r0-13/evidence.json`](r0-13/evidence.json)。

## 结论

**20 项证据检查全部通过，Notification Gateway 的协议骨架可进入后续生产实现，但
“崩溃后不重复展示”有一个必须保留的外部前提：macOS 适配器必须以持久化 intent 的稳定
`notificationId` 执行 replace/coalesce。**

- 权威 Attempt 状态迁移和 Notification Intent 在同一个真实 SQLite transaction
  中提交。约束冲突注入会同时回滚二者；相同
  `{eventType, taskId, attemptId?, authoritativeStateVersion}` 重放只留下一个 intent。
- Gateway 在没有 Electron 进程参与的 fixture 中读取 Pending intent、投递并只回写
  Notification Intent/Observation。Delivered、三次失败、终态忽略和点击确认均未改变
  Attempt 的 `Succeeded@v5` 事实。
- 失败按 probe 配置在 100 ms、200 ms 后重试，第 3 次失败进入 `Failed`；之后即使时间
  推进到 99,999 ms 也不再投递。每个已知结果都有持久化诊断 Observation。
- 真实子进程在外部通知已持久化、生命周期 SQLite 尚未写入 Delivered 的窗口被
  `SIGKILL`。新进程重放同一个 ID 后，外部 adapter 调用数为 2，可见通知数仍为 1，
  intent 最终收敛为 Delivered。
- 锁屏 payload 为 336 bytes，只由固定 `contentClass` 模板和已认证 activation envelope
  组成。恶意 title、OSC、Transcript、Input、Repository path 与 secret fixture 均未进入
  payload。
- activation 只编码严格的 Task 或 Task+Attempt identity。HMAC 篡改、任意 JSON
  URL/argv、带额外 URL/path/command 字段的 route，以及签名后与持久化 intent
  不一致的 binding 均被拒绝。

## 实测协议

### 1. 原子 outbox 与所有权

`AuthoritativeAttemptWriter` 是产生通知的权威写入方：它在
`BEGIN IMMEDIATE ... COMMIT` 内更新 Attempt 的 `status/stateVersion` 并插入
Notification Intent。dedupe key 使用固定顺序编码：

```text
["AttemptSucceeded", "task-1", "attempt-1", 5]
```

SQLite 同时以 `dedupe_key UNIQUE` 和 Attempt+权威版本唯一索引兜底。原型注入一个未来
版本 intent 冲突，使插入在 Attempt UPDATE 之后失败；最终 Attempt 仍为 `Running@v4`，
证明没有部分提交。

`NotificationGateway` 与该 writer 分离。Gateway 的公开行为只有：

1. 查询到期的持久化 Pending intent；
2. 构造固定且有界的系统 payload；
3. 调用外部 `SystemNotificationCenter`；
4. 更新 intent delivery state 和追加 delivery Observation；
5. 对已由 Electron Main 鉴权的 activation 再做持久化 binding 校验并确认。

Gateway 代码没有 Task/Attempt 的 INSERT、UPDATE 或调度入口，符合 `RT-NOTIFY-03` 的
所有权边界。

### 2. 有界失败与终态

本次使用的非规范 fixture 为 `maxAttempts=3`、`retryBaseMs=100`、
`retryMaxMs=250`、`notificationPayloadBytes=1024`。结果如下：

| 调用时间 | 外部结果 | intent 结果 | 下次到期 |
| ---: | --- | --- | ---: |
| 1,000 ms | `CENTER_UNAVAILABLE` | Pending / RetryScheduled #1 | 1,100 ms |
| 1,099 ms | 未调用 | Pending | 1,100 ms |
| 1,100 ms | `CENTER_UNAVAILABLE` | Pending / RetryScheduled #2 | 1,300 ms |
| 1,300 ms | `CENTER_UNAVAILABLE` | Failed #3 | 终态 |
| 99,999 ms | 未调用 | Failed | 终态 |

外部 adapter 的自由文本错误不会直接落库；只有 allowlist 中的稳定 error code 会保留，
其他值归一化为 `CENTER_ERROR`，避免把路径或动态敏感信息带入诊断字段。

### 3. 崩溃窗口与稳定 identity

崩溃 fixture 使用两个真实、彼此独立的 SQLite 边界：

- lifecycle DB：模拟 Daemon 拥有的 Notification Intent；
- persistent fake notification center：模拟 OS 已接受并显示的外部事实。

子进程在 fake center 提交可见通知后立即自发 `SIGKILL`，所以 lifecycle DB 仍为
Pending。重启进程无法证明第一次调用是否完成，只能使用相同 `notificationId` 重放。
fake center 对该 ID 做 upsert 而不是新建：

| 证据 | 数值 |
| --- | ---: |
| 外部 delivery 调用 | 2 |
| 可见 notification | 1 |
| 单条 notification 的 displayCount | 1 |
| 重启后 intent | Delivered |
| 重启后 Attempt | Succeeded@v5 |

因此，本原型证明的是“稳定 ID + 外部幂等替换”协议能收敛，而不是在非事务 OS API 上凭
SQLite 单独实现 mathematically exactly-once side effect。生产 macOS adapter 若不能保证
相同 identity 的替换语义，就必须把 RT-NOTIFY-02 重新标为未解决风险。

### 4. 内容与点击边界

writer 只接受 allowlist 中相互匹配的 `eventType/contentClass`，Gateway 再将 content class
映射到固定 title/body。调用方附加的 title、Transcript、Input、OSC、路径或 secret 字段
不会被序列化。route parser 要求对象键集合完全等于以下二者之一：

```text
{ kind: "task", taskId }
{ kind: "attempt", taskId, attemptId }
```

activation envelope 为版本化、定长上限的 canonical JSON，经 HMAC-SHA256 后使用
base64url 传递。Electron Main 侧 authenticator 先验证 MAC 和精确 schema，只输出稳定
identity；Daemon Gateway 再将其与持久化 intent 的 route 比对后才写 Acknowledged。
Electron Main 不接触 SQLite，也不能把 URL、path、argv 或 command 作为 route 传入。

## 证据与复现

- 原型代码：
  [`packages/daemon/src/prototypes/r0-13-notification-gateway/`](../../packages/daemon/src/prototypes/r0-13-notification-gateway/README.md)
- 机器证据：[`r0-13/evidence.json`](r0-13/evidence.json)，包含 20 个布尔检查、实测
  payload bytes、重试时点，以及 atomic/delivered/failed/crash 四组脱敏 DB snapshot。
- 聚焦测试：4 个文件、12 个测试，覆盖事务回滚与重放、投递与失败、真实子进程崩溃、
  内容和 activation 安全，以及 Task 与 Task+Attempt route identity 的解析与鉴权。
- 重跑证据：`pnpm prototype:r0-13`。
- 全仓验收：`pnpm test && pnpm typecheck && pnpm lint`。

## 边界与后续

- **真实 macOS API 未接入。** persistent fake 验证的是所需 adapter contract，不是
  UserNotifications 权限、通知中心行为、签名 helper、hardened runtime、notarization 或
  安装流程。生产 R3 必须以真实 API 复测相同 identity 的 replace/coalesce 语义。
- **HMAC secret 是 probe fixture。** 本原型证明 envelope/binding 算法，不证明 secret
  provisioning、Keychain、Electron sender/frame 或本地 socket 双向认证；这些分别由
  #10 和 #11 的边界原型承接，生产集成必须组合验证。
- **policy 数值不是产品默认值。** `3 / 100 / 250 / 1024` 仅使测试快速、确定；规范值由
  #15 的 RuntimeLimitProfile 冻结。
- **单 Gateway writer 假设。** 实测覆盖单一 Daemon 的进程崩溃和重启，没有覆盖升级期间
  两个 Gateway 并发投递；生产 single-writer/version-handshake 仍需阻止该状态。
- **权限拒绝是脚本化边界。** 已验证失败重试与终态，但未测真实系统通知权限被拒、
  用户关闭通知、Focus mode 或通知中心清理后的 UX。
- **平台样本单一。** 只在一台 macOS 26.5.2 / Apple Silicon 主机上运行；最低系统和最低
  硬件仍由 SupportedPlatformMatrix 冻结。
- **schema 是原型。** DDL、事件目录和 migration 不是 R3 生产 schema；Task-only route 已在
  route 解析与 activation envelope 层覆盖（含过权 route 拒绝），但 Attempt-scoped writer
  仍只产出 Attempt 事件 intent，Task-only intent 的权威来源留待 R3。

建议：保留当前接口分层进入 R3；把“真实 macOS adapter 的稳定 ID 语义”“#10/#11 的
认证链组合测试”“#15 的预算值”作为合并生产 Notification Gateway 前的硬门槛。
