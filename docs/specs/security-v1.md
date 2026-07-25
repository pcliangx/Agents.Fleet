# Agents.Fleet v1 Security Contract

> Status: Draft
>
> 本文件定义 v1 能兑现的安全保证及明确的非保证。运行时状态与协议见 [`runtime-contracts-v1.md`](./runtime-contracts-v1.md)。
>
> `SV1-*` 是稳定 requirement ID。issue 与测试必须引用这些 ID；已发布 ID 不得重编号或复用于另一语义。

## 1. Security Position

Agents.Fleet 是本地用户主动安装的开发工具，不是隔离恶意代码的 VM。它以当前用户身份启动用户选择的外部 Agent，因此主要目标是：

- **SV1-GOAL-01**：未经 Repository Trust 不执行 Repository 内容。
- **SV1-GOAL-02**：未经授权的客户端不能控制 Daemon。
- **SV1-GOAL-03**：Fleet 自己的文件、Git 和生命周期命令遵守最小权限与 Side-effect Class。
- **SV1-GOAL-04**：对 Fleet 无法控制的 Agent 行为如实披露，不制造 sandbox 或完全脱敏的假承诺。

## 2. Trust Model

| ID | Actor / input | 默认信任 | v1 处理 |
| --- | --- | --- | --- |
| SV1-ACTOR-01 | Repository 内容、脚本、Git hooks | Untrusted | 授予 Repository Trust 前不执行 |
| SV1-ACTOR-02 | 外部 Agent CLI | 用户选择，但能力不受 Fleet 控制 | 展示路径、版本、Capability 和实际 Permission Mapping |
| SV1-ACTOR-03 | Electron Renderer | 不直接可信 | 只能经受鉴权的 Control interface 请求 Host 能力 |
| SV1-ACTOR-04 | Electron Main 与签名 Daemon | 本产品可信计算基 | 版本握手、应用级认证、最小用户权限 |
| SV1-ACTOR-05 | 本机其他进程 | 不可信 | socket 权限、peer identity 与 capability token |
| SV1-ACTOR-06 | Hook / Transcript / PTY 内容 | 不可信数据 | 限长、校验、转义；不得当作命令执行 |

**SV1-NG-05**：当前用户账号或操作系统已被攻陷不在 v1 防御范围内。

## 3. Repository Trust

- **SV1-TRUST-01**：新导入的 Repository 状态始终为 untrusted。
- **SV1-TRUST-02**：授权界面必须展示 canonical path、将启动的 Agent、实际 Permission Mapping、可能执行的 Repository 脚本与数据保存位置。
- **SV1-TRUST-03**：Repository Trust 绑定 Repository identity 与 canonical root；路径被替换、Repository identity 改变或从备份恢复到不同位置时重新确认。
- **SV1-TRUST-04**：授权前只允许运行 Host 级诊断和不执行代码的文件系统检查；不得调用 Repository 上下文中的 Git CLI、shell 初始化脚本、Repository 内二进制或 Agent。
- **SV1-TRUST-05**：Repository Trust 可以撤销；撤销不静默终止 Alive Attempt，而是阻止新 Attempt 并要求用户选择停止或保留。

## 4. Agent Isolation: Explicit Non-guarantees

v1 不提供 Fleet 级 Agent sandbox。除非 Agent 自己提供并启用了限制：

- **SV1-NG-01**：Agent 可以访问当前用户可访问的 Worktree 外文件。
- **SV1-NG-02**：Agent 可以发起网络请求和 external 副作用。
- **SV1-NG-03**：Agent 可以调用 shell、Git 或其他本机工具。
- **SV1-NG-04**：Fleet 不能可靠拦截、批准或回滚 Agent 内部的每一次工具调用。

**SV1-NG-06**：因此，“Worktree 路径约束”只适用于 Worktree Manager 和 Fleet 自己的文件 interface。UI 必须把 Agent 的实际权限与这些 Fleet 保证分开展示。

## 5. Permission Modes and Capabilities

**SV1-PERM-05**：`Manual`、`Balanced`、`YOLO` 是用户意图，不是跨 Agent 的统一安全等级；每个 Adapter 必须返回以下 mapping：

```text
PermissionMapping = {
  requestedMode,
  effectiveMode,
  launchArgumentsPreview,
  enforcedCapabilities,
  unsupportedControls,
  warnings
}
```

规则：

- **SV1-PERM-01**：`effectiveMode` 比请求更宽松时必须阻止启动并要求重新确认。
- **SV1-PERM-02**：无法确认某项控制是否受 Agent 强制时，将其列入 `unsupportedControls`，不能默认视为安全。
- **SV1-PERM-03**：启动预览展示结构化 argv 的脱敏表示；实际启动使用 argv 数组，不拼接 shell 命令字符串。
- **SV1-PERM-04**：Profile 中的账号或秘密不改变 Repository Trust，也不能自动升级 Permission Mode。

## 6. Fleet Side-effect Policy

Side-effect Class 只分类 Fleet 自己发起的操作：

| ID / Class | 示例 | 默认策略 |
| --- | --- | --- |
| SV1-SIDE-READ / read | status、diff、读取 Observation | 允许 |
| SV1-SIDE-REV / reversible | 创建 Worktree；在保留 branch 的前提下移除已确认 clean 的 Worktree | 显示影响，按 Workspace 策略允许 |
| SV1-SIDE-DES / destructive | 停止 Alive Attempt、删除脏 Worktree、删除 branch、丢弃数据 | 每次显式确认 |
| SV1-SIDE-EXT / external | push、创建远端资源、发送外部消息 | 每次显式确认；v1 产品界面不提供 |

- **SV1-SIDE-01**：确认凭证必须绑定 `commandId`、规范化 payload hash、目标 state version、Side-effect Class、影响摘要 hash、用户身份和过期时间，不能复用于另一个目标。执行前状态或影响发生变化时必须重新确认。
- **SV1-SIDE-02**：destructive / external 影响预览与确认由 Electron Main 创建的原生对话框展示；Renderer 不能自行签发确认。Daemon 只接受 Main 对同一 payload hash 的一次性证明。

## 7. Daemon and Local Transport

- **SV1-AUTH-01**：Daemon 使用当前登录用户的 LaunchAgent，不以 root 身份执行 Agent。
- **SV1-AUTH-02**：socket 位于仅当前用户可访问的目录，目录权限为 `0700`，socket 权限为 `0600`。
- **SV1-AUTH-03**：Daemon 校验 peer uid，并要求握手提供由签名 UI 与 Daemon 共享 Keychain access group 保护的 capability token。
- **SV1-AUTH-04**：capability token 不写入命令行、普通日志或 Repository；可轮换，Daemon 重装后失效。
- **SV1-AUTH-05**：Renderer 不直接连接 socket；Electron Main 负责 transport adapter，并把 Renderer 请求限制为声明过的 Control interface。
- **SV1-AUTH-06**：所有 transport 输入都执行 schema、大小和速率限制；未知字段按版本策略拒绝，而非转成 shell 或文件路径。

**SV1-AUTH-07**：开发模式可以使用单独的 `0600` token 文件，但必须明确标识为非发布配置，且不能复用生产 Keychain 条目。

## 8. Worktree and File Safety

Worktree Manager 对 Fleet 自己的文件操作保证：

- **SV1-FILE-01**：Repository 和 Worktree root 在导入时 canonicalize，并保存稳定 identity。
- **SV1-FILE-02**：每次操作都相对已验证 root 解析，拒绝绝对路径、`..`、NUL 和越界 symlink。
- **SV1-FILE-03**：安全检查与打开文件使用同一已验证目录句柄，避免检查后替换路径的 TOCTOU。
- **SV1-FILE-04**：删除前重新检查 active Attempt、未提交修改、未合并 commit、Worktree identity 和目标路径。
- **SV1-FILE-05**：删除、reset、branch delete 等 destructive Git 操作不在 v1 产品界面；内部 cleanup 仍需显式确认。
- **SV1-FILE-06**：获得 Repository Trust 后的只读 Git 查询仍使用结构化 argv 与清理后的环境，并禁用 hooks、external diff、textconv、fsmonitor 和不必要的 submodule 递归；不得执行 Repository 配置声明的外部程序。
- **SV1-FILE-07**：status、diff、ahead / behind 等只读查询只使用本地 refs，不隐式 fetch、访问 credential helper 或产生网络请求。

**SV1-NG-07**：这些保证不限制在 Session 中运行的 Agent 或用户 shell。

## 9. Secrets and Observations

- **SV1-DATA-01**：由 Fleet 管理的凭据进入 OS Keychain，不写 SQLite、Profile 明文、命令行参数或 Repository。
- **SV1-DATA-02**：SQLite、chunk、Snapshot 和导出默认按敏感本地数据处理，文件权限仅限当前用户。
- **SV1-DATA-03**：PTY、Hook 或 Transcript 可能包含 Agent 主动输出的秘密；存储前和导出时执行格式保留的 best-effort redaction。
- **SV1-DATA-04**：导出界面必须提示脱敏不是完整保证，并在导出前展示扫描结果和目标范围。
- **SV1-DATA-05**：错误、诊断与普通日志默认记录 ID、状态和计数，不记录完整 argv、环境变量、PTY 内容或 Transcript。
- **SV1-DATA-06**：用户可以清理单个 Task、Workspace 或全部持久数据，并在操作前看到受影响的 Artifact 与预计空间。

**SV1-DATA-07**：v1 不宣称本地 Observation 已加密静态存储；若需要该保证，必须增加密钥恢复、索引与性能设计后再承诺。

## 10. Required Security Tests

- **SV1-T-01**：未授予 Repository Trust 时，任何 start 命令和 Repository 上下文 Git CLI 都被拒绝，且没有 Repository 代码被执行。
- **SV1-T-02**：canonical root 被 symlink 替换、路径含 `..`、绝对路径或竞态替换时，Fleet 文件操作失败。
- **SV1-T-03**：非当前用户、无 capability token、旧 token 和错误签名客户端不能调用 Control interface。
- **SV1-T-04**：Renderer 注入任意 argv、路径或 payload 不能绕过 Electron Main 和 Daemon schema。
- **SV1-T-05**：Permission Mapping 比请求更宽松时启动被阻止。
- **SV1-T-06**：destructive 命令缺少原生确认、确认过期或 payload 改变时被拒绝。
- **SV1-T-07**：Hook、Transcript、PTY 中的控制字符和超大 payload 不被执行，也不破坏 UI。
- **SV1-T-08**：已知 secret fixtures 不进入普通日志或默认导出；同时测试 UI 明确展示 best-effort 限制。
- **SV1-T-09**：卸载、数据清理和 Worktree dispose 在 Alive Session 或脏 Worktree 下都要求明确选择。
- **SV1-T-10**：恶意 `.gitconfig`、`.gitattributes`、external diff、textconv、fsmonitor 与 submodule fixture 在只读查询中均不被执行。
- **SV1-T-11**：只读 Git 查询在配置 remote、credential helper 和网络代理的 fixture 中仍不发起网络请求。
