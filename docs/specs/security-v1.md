# Agents.Fleet v1 Security Contract

> Status: Draft
>
> 本文件定义 v1 能兑现的安全保证及明确的非保证。运行时状态与协议见 [`runtime-contracts-v1.md`](./runtime-contracts-v1.md)。
>
> `SV1-*` 是稳定 requirement ID。issue 与测试必须引用这些 ID；已发布 ID 不得重编号或复用于另一语义。

## 1. Security Position

Agents.Fleet 是本地用户主动安装的开发工具，不是隔离恶意代码的 VM。它以当前用户身份启动用户选择的外部 Agent，因此主要目标是：

- **SV1-GOAL-01**：未经 Active Repository Trust 不执行 Repository 内容；PendingValidation 只允许 RT-REPO-02 的受限 Git 验证。
- **SV1-GOAL-02**：未经授权的客户端不能控制 Daemon。
- **SV1-GOAL-03**：Fleet 自己的文件、Git 和生命周期命令遵守最小权限与 Side-effect Class。
- **SV1-GOAL-04**：对 Fleet 无法控制的 Agent 行为如实披露，不制造 sandbox 或完全脱敏的假承诺。

## 2. Trust Model

| ID | Actor / input | 默认信任 | v1 处理 |
| --- | --- | --- | --- |
| SV1-ACTOR-01 | Repository 内容、脚本、Git hooks | Untrusted | 授予 Repository Trust 前不执行 |
| SV1-ACTOR-02 | 外部 Agent CLI | 用户选择，但能力不受 Fleet 控制 | 首次 Trust 确认前只展示候选 identity 与权限上界；Active 后中立 probe，再在 Launch Confirmation 展示已验证版本、Capability 和实际 Permission Mapping |
| SV1-ACTOR-03 | Electron Renderer | 不直接可信 | 只能经受鉴权的 Control Interface 请求 Host 能力 |
| SV1-ACTOR-04 | Electron Main 与签名 Daemon | 本产品可信计算基 | 版本握手、应用级认证、最小用户权限 |
| SV1-ACTOR-05 | 本机其他进程 | 不可信 | socket 权限、peer identity 与 capability token |
| SV1-ACTOR-06 | Hook / Transcript / PTY 内容 | 不可信数据 | 限长、校验、转义；不得当作命令执行 |
| SV1-ACTOR-07 | xterm.js、选定的官方 addon 与 Terminal Surface | 随应用签名的产品代码；输入不可信 | 锁定 package set、校验依赖完整性、限制资源与 terminal effects |

**SV1-NG-05**：当前用户账号或操作系统已被攻陷不在 v1 防御范围内。

## 3. Repository Trust

- **SV1-TRUST-01**：新导入的 Repository 状态始终为 Untrusted。
- **SV1-TRUST-02**：Repository Trust 界面必须展示 canonical path、文件系统 identity、计划使用的 Agent、数据保存位置、PendingValidation 将执行的受限 Git 验证、Active 后才允许的中立 probe，以及 Agent 最终可能拥有的 Host 权限上界；不得声称此时已经验证实际 Agent 版本、Permission Mapping、`baseCommitSha` 或 Repository 脚本清单。
- **SV1-TRUST-03**：Repository Trust 的首次确认绑定 candidate canonical root 与文件系统 identity，并进入 PendingValidation；RT-REPO-02 验证成功后才补充绑定 common Repository identity 并进入 Active。路径被替换、验证出的 Git root 与用户确认的 root 不同、Repository identity 改变或从备份恢复到不同位置时，旧 Trust 失效并重新确认。
- **SV1-TRUST-04**：首次确认前只允许读取 canonical path、文件系统 identity 和应用安装信息等不执行代码的 Host 元数据；不得调用任何 Git CLI、Agent、shell、shell 初始化脚本、Repository 内二进制或脚本。首次确认后的 PendingValidation 例外仅为 SV1-TRUST-08。
- **SV1-TRUST-05**：PendingValidation 或 Active Repository Trust 可以撤销并按 RT-REPO-05 进入 Revoked；撤销不静默终止非终态 Attempt 或其 Alive Session，而是阻止新 Attempt，并要求用户对仍可能运行的进程选择停止或保留。
- **SV1-TRUST-06**：只有 Active Repository Trust 才允许 Host Environment probe；probe 仍在应用拥有的中立目录、清理后的环境与显式 executable path 下运行，不以 Repository / Worktree 为 cwd。Worktree provision 只能按 SV1-FILE-11 materialize 数据，`CommitLaunch` 是 Fleet 首次允许 Agent 或 Repository 外部程序在目标 Worktree 执行的点。
- **SV1-TRUST-07**：Repository Trust 与逐次 Launch Confirmation 是两个凭证。Trust 为 Active 后，RT-CMD-14 的 `launchConfirmationReceipt` 才能绑定 RT-ENV-06 的 executable / launch closure identity 与 coverage、受支持版本、Environment Snapshot、Permission Mapping、结构化 argv、Task / Profile snapshot、Repository identity、`WorktreeTargetBinding`、Worktree `stateFingerprint` / 预期 clean 状态和 `baseCommitSha`；Existing target 绑定实际 filesystem identity，Planned target 绑定预分配 ID、计划 path、Repository identity 与 branch 策略，不能声称已确认尚不存在的 filesystem identity。执行前或 Planned target Ready 后任一受绑定事实漂移都必须重新确认；Repository Trust、destructive confirmation 与 Launch Confirmation 不能互相代替。
- **SV1-TRUST-08**：PendingValidation 只授权一次有界、幂等的 RT-REPO-02 验证流程；它不能创建 Workspace、执行 Agent probe、读取任意 Repository 文件、创建 Attempt / Worktree 或 LaunchIntent。普通验证失败或进程崩溃保留 PendingValidation，只能幂等重试同一 candidate 或撤销；root 不一致或已确认 identity 漂移按 RT-REPO-05 转为 Revoked，必须重新确认新的 Trust version，任何情况都不能自动升级为 Active。
- **SV1-TRUST-09**：Launch Confirmation challenge 由 Daemon 从权威 preview 生成，receipt 只能由持有受保护 Main / Daemon capability 的 Electron Main 在原生用户确认后签发。Renderer 不能签发、持有签发材料、替换 challenge 内容或把自绘按钮当作确认；Main 也不能用 Renderer 提供的自由文本代替 Daemon 的结构化 identity、argv、permission、Worktree 与影响字段。
- **SV1-TRUST-10**：首次 Repository Trust 与重新授予也使用 RT-REPO-06 的 Daemon challenge 和 Electron Main 原生确认。Renderer 不能把路径选择、导航、打开页面或自绘按钮当作授权，不能更换 canonical path / filesystem identity、隐藏 PendingValidation 计划或自行签发 `repositoryTrustReceipt`。

## 4. Agent Isolation: Explicit Non-guarantees

v1 不提供 Fleet 级 Agent sandbox。除非 Agent 自己提供并启用了限制：

- **SV1-NG-01**：Agent 可以访问当前用户可访问的 Worktree 外文件。
- **SV1-NG-02**：Agent 可以发起网络请求和 external 副作用。
- **SV1-NG-03**：Agent 可以调用 shell、Git 或其他本机工具。
- **SV1-NG-04**：Fleet 不能可靠拦截、批准或回滚 Agent 内部的每一次工具调用。

**SV1-NG-06**：因此，“Worktree 路径约束”只适用于 Worktree Manager 和 Fleet 自己的文件 Interface。UI 必须把 Agent 的实际权限与这些 Fleet 保证分开展示。

**SV1-NG-08**：Fleet 会在受控操作与 `CommitLaunch` 前重新观察 Repository、Worktree 和 Agent launch closure identity，但不把同一用户的外部文件系统变成锁或 sandbox；另一个同用户进程仍可能在最后一次观察之后改写文件。UI 与证据必须展示 `observedAt` / identity coverage，不能声称彻底消除该 race。

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
| SV1-SIDE-DES / destructive | 强制 Control takeover、`RequestAttemptStop`、`TerminateSession`、删除持久数据 | 每次显式确认 |
| SV1-SIDE-EXT / external | push、创建远端资源、发送外部消息 | 每次显式确认；v1 产品界面不提供 |

- **SV1-SIDE-01**：确认凭证必须绑定 `commandId`、规范化 payload hash、目标 state version、Side-effect Class、影响摘要 hash、用户身份和过期时间，不能复用于另一个目标。执行前状态或影响发生变化时必须重新确认。
- **SV1-SIDE-02**：destructive / external 影响预览必须来自 RT-CMD-18 的 Daemon challenge，并由 ConfirmationBroker 的原生对话框展示；Renderer 不能提供替代展示文本或自行签发确认。Daemon 只接受 Main 对同一 challenge / payload / impact hash 的一次性证明。

## 7. Daemon and Local Transport

- **SV1-AUTH-01**：Daemon 使用当前登录用户的 LaunchAgent，不以 root 身份执行 Agent。
- **SV1-AUTH-02**：socket 位于仅当前用户可访问的目录，目录权限为 `0700`，socket 权限为 `0600`。
- **SV1-AUTH-03**：Daemon 校验 peer uid，并要求 RT-HS-01..05 使用由已签名 Electron Main 与 Daemon 共享 Keychain access group 保护的 capability token 完成双向 nonce / transcript proof；token 本身不在 transport 发送。Renderer 永远不接触 token、nonce proof API 或未认证 socket。
- **SV1-AUTH-04**：capability token 不写入命令行、普通日志或 Repository；可轮换，Daemon 重装后失效。
- **SV1-AUTH-05**：Renderer 不直接连接 socket；Electron Main 负责 transport Adapter，并把 Renderer 请求限制为声明过的 Control Interface。
- **SV1-AUTH-06**：所有 transport 输入都按 RT-LIMIT-01 的 `RuntimeLimitProfile` 执行 schema、大小和速率限制；未知字段按版本策略拒绝，而非转成 shell 或文件路径。

**SV1-AUTH-07**：开发模式可以使用单独的 `0600` token 文件，但必须明确标识为非发布配置，且不能复用生产 Keychain 条目。

- **SV1-AUTH-08**：发布构建启用 Renderer sandbox、context isolation 并关闭 node integration。Renderer 只能通过最小、类型化的 preload Interface 请求 Main，不得取得 capability token、socket path、PTY fd 或任意 Host object。
- **SV1-AUTH-09**：Electron Main 不加载 node-pty，也不代 Renderer 执行任意 native function；node-pty 只存在于独立 Daemon，并仍受 Control Dispatcher、Repository Trust 与 Side-effect Class 约束。
- **SV1-AUTH-10**：Electron Main 只可加载 release manifest 中签名、精确锁定的 native ConfirmationBroker；它只接受 Daemon challenge schema、绘制固定字段并返回用户确认 / 取消结果，不暴露通用 native call、文件、进程、网络或任意 UI payload Interface。Renderer 只能请求 Main 打开一个已有 challenge ID，不能直接调用 Broker。

## 8. Electron Boundary

- **SV1-ELECTRON-01**：发布构建通过受限的自定义 app protocol 加载 Renderer asset，不使用 `file://`，不允许 protocol handler 解析任意本地路径、目录遍历或网络 fallback。
- **SV1-ELECTRON-02**：每个 preload / IPC 请求都校验 sender webContents、frame identity、origin、schema、`RuntimeLimitProfile` 大小 / 速率和当前 route capability；子 frame、已导航 frame、销毁 frame 或非应用 origin 默认拒绝。
- **SV1-ELECTRON-03**：Main 默认拒绝 navigation、new-window、webview attach、download 与 permission request；允许的外部 URL 必须来自独立策略、通过用户手势和系统默认浏览器打开，不能在具有 preload 权限的窗口中加载。
- **SV1-ELECTRON-04**：Renderer 使用严格 CSP；Repository、Hook、Transcript、Artifact、terminal title / link / clipboard 与错误内容一律作为不可信文本或有界二进制处理，不得进入 `innerHTML`、script URL、style URL 或动态代码执行。
- **SV1-ELECTRON-05**：发布构建固定并验证安全相关 Electron fuses，至少禁止 RunAsNode、NODE_OPTIONS / NODE_EXTRA_CA_CERTS 注入和从 ASAR 外加载不受信代码；签名后再次验证 fuse 与 bundle manifest。
- **SV1-ELECTRON-06**：preload 只暴露按命令命名的类型化方法和绑定 Attachment 的 MessagePort；不暴露通用 `send` / `invoke`、Node object、filesystem、shell、raw socket 或任意 channel 名。
- **SV1-ELECTRON-07**：原生 Repository Trust confirmation、destructive confirmation、Launch Confirmation、Notification activation 和外部 URL 决策只能由 Main 的声明式策略发起；三类 confirmation 只展示 RT-REPO-06 / RT-CMD-18 / RT-CMD-17 的 Daemon challenge，Renderer 提供的展示文本不能变成确认凭证、route 或 executable payload。

## 9. Worktree and File Safety

Worktree Manager 对 Fleet 自己的文件操作保证。每个操作必须声明一个已经验证的 Repository、Worktree 或 app-data root；声明 root 不是允许跨这些 root 任意导航：

- **SV1-FILE-01**：Repository、Worktree 与 app-data root 在首次使用前 canonicalize，并保存稳定 identity；每次敏感操作重新验证所声明 root 的 identity。
- **SV1-FILE-02**：每次 FileBroker 操作只相对该命令声明并验证的单一 root 解析，拒绝绝对路径、`..`、NUL 和越界 symlink；Renderer 不能通过选择另一个 root、拼接 Repository 与 Worktree 路径或复用旧 handle 扩大访问范围。
- **SV1-FILE-03**：安全检查与打开文件使用该操作同一已验证 directory fd，并通过平台 `openat` 类能力或等价 native primitive 相对该 fd 逐段解析，避免检查后替换路径的 TOCTOU；普通 `realpath` 后再按字符串路径打开不满足本条。
- **SV1-FILE-04**：dispose 前重新检查非终态 Attempt、所有 Alive Session、Uncertain Process Disposition、未提交修改、相对确认中显式 `integrationTargetSha` 的未合并 commit、Worktree identity 和目标路径；target 缺失或漂移时 fail closed。
- **SV1-FILE-05**：v1 产品 Interface 只移除 Fleet-managed、identity 匹配、已确认 clean、没有 Alive Session / 未决 Process Disposition 且没有相对 `integrationTargetSha` 的未合并 commit 的 Worktree，并保留 branch。强制删除脏 Worktree、reset 与 branch delete 不在 v1 产品 Interface，也不能由卸载或完整清理确认间接触发。
- **SV1-FILE-06**：PendingValidation 只允许 RT-REPO-02 所需的固定、只读 Git 查询；Active Trust 后才允许其他声明过的只读 Git 查询。两者都使用结构化 argv 与清理后的环境，并禁用 hooks、external diff、textconv、fsmonitor 和不必要的 submodule 递归；不得执行 Repository 配置声明的外部程序。
- **SV1-FILE-07**：status、diff、ahead / behind 等只读查询只使用本地 refs，不隐式 fetch、访问 credential helper 或产生网络请求。
- **SV1-FILE-08**：FileBroker 是 Worktree Manager 的私有 native Implementation，不作为 Renderer、Adapter 或插件可调用的公共 Seam；native 能力缺失或 identity 无法证明时操作 fail closed。
- **SV1-FILE-09**：dispose 的影响预览必须明确列出 Worktree path / identity、clean 证据、保留的 branch、相关 Task / Session 和回收空间；检查与执行之间事实变化时旧确认失效。
- **SV1-FILE-10**：Worktree provision、inspect 与 dispose 可以通过受限、结构化 Git Interface 访问 identity 已验证的 common Repository Git directory；这是 Worktree Manager 的内部能力，不是 FileBroker 任意跨 root 访问。Git 操作前后都重新验证 Repository / Worktree identity，且不得把 common Git directory path 暴露为 Renderer 可浏览 root。
- **SV1-FILE-11**：Worktree provision 的 checkout / materialization 必须显式禁用 Repository 与用户配置中的 hooks、smudge / clean / process filter、external diff、textconv、fsmonitor、submodule recursion、pager、credential helper 和其他外部程序入口，且不得执行 Worktree 内文件。若锁定 Git 版本没有可验证的 no-external-program 路径，或禁用 filter 会使 Repository checkout 语义不完整，v1 必须在创建 LaunchIntent 前 fail closed；不能以 Active Trust 或 Launch Confirmation 代替该边界。

**SV1-NG-07**：这些保证不限制在 Session 中运行的 Agent 或用户 shell。

## 10. Secrets and Observations

- **SV1-DATA-01**：由 Fleet 管理的凭据进入 OS Keychain，不写 SQLite、Profile 明文、命令行参数或 Repository。
- **SV1-DATA-02**：SQLite、chunk、Snapshot、Artifact content 和导出默认按敏感本地数据处理，文件权限仅限当前用户。
- **SV1-DATA-03**：PTY 与 Input Intent 的原始 bytes 为保证字节完整性而原样持久化；用于恢复的 Snapshot 不执行内容替换式 redaction。三者都可能包含秘密，按敏感本地数据限制权限、日志与导出。
- **SV1-DATA-04**：默认导出只使用派生的 redacted 内容。导出界面必须提示脱敏不是完整保证，并在导出前展示扫描结果、目标范围和任何显式 raw-data 选择。
- **SV1-DATA-05**：错误、诊断与普通日志默认记录 ID、状态和计数，不记录完整 argv、环境变量、PTY 内容或 Transcript。
- **SV1-DATA-06**：用户可以清理单个 Task、Workspace 或全部持久数据，并在操作前看到受影响的 Artifact 与预计空间。

**SV1-DATA-07**：v1 不宣称本地 Observation 已加密静态存储；若需要该保证，必须增加密钥恢复、索引与性能设计后再承诺。

- **SV1-DATA-08**：best-effort redaction 只生成派生的时间线、搜索索引、诊断日志和默认导出；脱敏结果必须保留 provenance，且绝不能替代 raw chunk、Input Intent、Snapshot 或 PTY 输入。
- **SV1-DATA-09**：Notification Intent 与锁屏通知使用最小摘要，默认不包含 Repository 私密路径、PTY、Transcript、Input Intent、secret 或任意可执行 route。

## 11. Terminal Supply Chain and Renderer Isolation

- **SV1-TERM-01**：终端 allowlist 仅包含精确版本的 `@xterm/xterm`、`@xterm/headless`、`@xterm/addon-webgl`、`@xterm/addon-serialize` 与 `@xterm/addon-unicode11`；构建验证 lockfile / package integrity 和任何 patch-set hash，生成 SBOM，并只把已验证产物放入签名应用。
  > _Changelog (R0-09, [ADR-0007](../adr/0007-terminal-allowlist-unicode11-addon.md))_：allowlist 由 4 包扩为 5 包（+`@xterm/addon-unicode11`）。SBOM 生成属构建流水线，本 slice 未产出。
- **SV1-TERM-02**：Renderer Content Security Policy 只允许加载安装包内声明的 script、style 和 font asset；Daemon Snapshot Worker 也只能加载签名安装包内的锁定 package set。asset 缺失、完整性或版本握手失败时终端 fail closed；不得从 CDN 或网络取得替代代码、addon 或样式。
- **SV1-TERM-03**：PTY bytes、terminal title、OSC、image protocol、hyperlink 和 clipboard sequence 都是不可信输入。打开 URL / 文件、读写 clipboard、发送通知或访问 Host 能力必须经过独立策略与必要的用户手势，不能由 escape sequence 直接触发。
- **SV1-TERM-04**：每个 Terminal Surface、headless Snapshot Worker 和整个 Renderer 按 `RuntimeLimitProfile` 对 scrollback、glyph、image、WebGL texture、DOM node、pending write、URL、title、clipboard payload 与 effect rate 设置硬上限；一个恶意 Session 达到上限不能使其他 Session 丢失状态或越权。
- **SV1-TERM-05**：WebGL2 / DOM 只能从 xterm.js 的终端状态绘制；Terminal Surface 与 addon 不得把原始 PTY、title、link 或 Snapshot 送入 `innerHTML` 或解释为 JavaScript。WebGL context lost、DOM exception 或 renderer fallback 不能触发 native command 或 Host 能力。
- **SV1-TERM-06**：xterm.js package set、addon、终端 CSS 或下游 patch 更新必须更新 SBOM，并通过 terminal effect、CSP、bundle tamper、资源耗尽、双绘制路径与 Renderer compromise fixture。
- **SV1-TERM-07**：v1 不打包或加载 `addon-image`；image protocol 只能被忽略或显示有界占位符。所有 terminal effect 经过私有 TerminalEffectPolicy Implementation，不能直接取得 Main / Daemon Capability。
- **SV1-TERM-08**：Snapshot Worker 或 terminal package set 失败只能使对应终端视图 fail closed、从已验证 raw chunk 重建或报告 data gap；不得停止 Agent、改写 Attempt、删除 raw chunk 或从网络下载替代实现。

## 12. Distribution Supply Chain

- **SV1-SUPPLY-01**：发布清单精确记录 Electron、内置 Node runtime、`node-pty` native binary、Daemon、bootstrap、Notification Gateway、terminal package set、native FileBroker、native ConfirmationBroker、migration、`SupportedPlatformMatrix` 与 `RuntimeLimitProfile` 的版本、hash、签名 identity 和 SBOM 关系。
- **SV1-SUPPLY-02**：构建在固定 toolchain 与 lockfile 下生成 native artifact，验证 package integrity、native architecture、最低系统版本和禁止的 install-time network / script；architecture、deployment target 与最低系统版本必须匹配 RT-DIST-08 的 `SupportedPlatformMatrix`。任何下游 patch 都有 owner、来源、hash、回归 fixture 与删除条件。
- **SV1-SUPPLY-03**：应用、Daemon、helper 与 LaunchAgent 目标都必须通过 macOS code-signing、notarization、hardened runtime 和 designated-requirement 验证；签名后 bundle、fuse 或 native artifact 改变即拒绝启动。
- **SV1-SUPPLY-04**：升级与回滚保持单一可写 Daemon，先 drain 或显式处理 Alive Session 与未决 Process Disposition，验证 backup 与 schema compatibility；不兼容或验证失败时保留旧数据进入只读恢复，不运行混合版本。

## 13. Required Security Tests

- **SV1-T-01**：未授予 Repository Trust 时，任何 start、Workspace create 和 Repository 上下文 Git CLI 都被拒绝，且没有 Repository 代码被执行；选择 candidate 只保存 canonical path 与文件系统 identity。PendingValidation 时只有 RT-REPO-02 的受限 Git 验证可运行，Agent probe、Workspace create 和其他 Repository 操作仍被拒绝。
- **SV1-T-02**：canonical root 被 symlink 替换、路径含 `..`、绝对路径或竞态替换时，Fleet 文件操作失败。
- **SV1-T-03**：非当前用户、无 capability token、旧 token、错误签名客户端、重放 ClientHello / proof、nonce 复用、transcript / version 降级和时序比较 fixture 都不能完成 RT-HS-01..05 或调用 Control Interface。
- **SV1-T-04**：Renderer 注入任意 argv、路径或 payload 不能绕过 Electron Main 和 Daemon schema。
- **SV1-T-05**：Repository Trust 不能充当 Launch Confirmation；缺少逐次确认、Permission Mapping 比请求更宽松、Existing target identity 被替换，或 Planned target receipt 被用于不同 ID / path / Repository / branch 策略时，启动被阻止。
- **SV1-T-06**：destructive 命令缺少 RT-CMD-18 原生确认、challenge / confirmation 过期、Renderer 改写展示文本、payload / target / state / impact 改变或 receipt 重放时被拒绝。
- **SV1-T-07**：Hook、Transcript、PTY 中的控制字符和超大 payload 不被执行，也不破坏 UI。
- **SV1-T-08**：已知 secret fixtures 不进入普通日志或默认导出；同时测试 UI 明确展示 best-effort 限制。
- **SV1-T-09**：卸载和数据清理在 Alive Session、未决 Process Disposition 或 Artifact 下都要求明确选择；Worktree dispose 在 Alive Session、脏 Worktree、identity 漂移、unmerged commit 或未决 Process Disposition 下被拒绝，不能由确认越过。被阻塞的“完整清理”必须保留 Worktree / branch 并报告人工处理步骤。
- **SV1-T-10**：恶意 `.gitconfig`、`.gitattributes`、external diff、textconv、fsmonitor 与 submodule fixture 在只读查询中均不被执行。
- **SV1-T-11**：只读 Git 查询在配置 remote、credential helper 和网络代理的 fixture 中仍不发起网络请求。
- **SV1-T-12**：xterm.js package / addon、bundle manifest、终端 script / style 被篡改、缺失或版本不兼容时终端 fail closed，网络记录中不存在远端替代代码请求。
- **SV1-T-13**：恶意 OSC、image protocol、hyperlink、title 与 clipboard fixture 不能直接打开 URL / 文件、读写 clipboard、执行 HTML / JavaScript 或调用 Host Interface。
- **SV1-T-14**：Renderer compromise fixture 不能加载 node-pty、取得 PTY fd / socket / capability token、直接调用 ConfirmationBroker，或绕过类型化 preload Interface。
- **SV1-T-15**：超大 image、scrollback、DOM node、WebGL texture、pending write、effect storm 和 WebGL context-lost fixture 均保持资源硬上限并正确回退，且其他 Session 的状态、输入与 Control Lease 不受影响。
- **SV1-T-16**：自定义 protocol 的 traversal、伪造 sender / subframe、navigation、new-window、webview、download、permission request、CSP bypass、通用 IPC channel 与错误 fuse fixture 全部 fail closed。
- **SV1-T-17**：在 path 检查与 open / dispose 的每个边界并发替换 symlink、目录与 mount identity；native FileBroker 要么操作原已验证 identity，要么失败，不能落到攻击者路径。
- **SV1-T-18**：clean Fleet-managed Worktree 可以在保留 branch 后 dispose；脏 Worktree、identity 漂移、Alive Session、未决 Process Disposition、相对显式 `integrationTargetSha` 的未合并 commit、target 漂移与 branch delete 请求全部被拒绝。
- **SV1-T-19**：包含已知 secret、NUL、invalid UTF-8 的 PTY / Input fixture 在 raw chunk 与恢复 Snapshot 中逐字节或按定义语义保持完整，同时普通日志、派生时间线与默认导出只包含标记过 provenance 的 redacted 结果。
- **SV1-T-20**：Input Intent 的原始内容只经受鉴权的 Session Runtime 可读；Renderer compromise、普通日志、通知和默认导出无法取得 raw input，redacted input 也不能被重放。
- **SV1-T-21**：Electron、Node runtime、node-pty、helper、terminal package、FileBroker、ConfirmationBroker、`SupportedPlatformMatrix`、`RuntimeLimitProfile`、SBOM、签名、fuse 或 patch hash 任一篡改 / 混用时发布或启动失败，且不会从系统 Node 或网络回退。
- **SV1-T-22**：首次 Repository Trust 确认前，恶意 shell rc、Git config、PATH、Repository binary 与 Agent executable fixture 均不执行；PendingValidation 只运行受限 Git 验证且不 probe Agent，Active 后 probe 仍使用中立 cwd。Repository Trust、Launch Confirmation 与 exec 任一阶段的 Repository / executable / environment identity 漂移都要求回到对应确认步骤。
- **SV1-T-23**：Electron 关闭时通知仍可投递；恶意 title / OSC / Transcript 不能生成通知、注入 route 或泄露 secret，点击只能打开已鉴权的稳定 Task / Attempt route。
- **SV1-T-24**：构建或运行时加入 `addon-image`、额外 addon、CDN script / style 或不匹配 package set 时终端 fail closed；不影响 Daemon 继续持久化 raw PTY。
- **SV1-T-25**：`RequestAttemptStop`、`CancelTask` 与 `TerminateSession` 的 confirmation receipt 绑定各自 Daemon challenge、目标、state version 与影响摘要；Renderer 伪造命令名、展示文本、Lease、route 或跨命令复用 receipt 不能扩大停止范围。
- **SV1-T-26**：对 Repository、linked Worktree、app-data 与 common Git directory 分别执行 absolute path、`..`、symlink、mount / identity replacement 和跨 root handle 复用 fixture；FileBroker 只能操作命令声明的 root，受限 Git Interface 只能操作已验证 Repository identity，Renderer 永远不能取得 common Git directory 浏览能力。
- **SV1-T-27**：在 Worktree provision fixture 中配置 post-checkout hook、smudge / clean / process filter、external diff、textconv、fsmonitor、submodule、pager 与 credential helper，并让每个入口尝试写 canary 或联网；所有外部程序均不得执行。需要外部 filter 才能正确 checkout 或无法证明禁用的 Repository 返回 `CapabilityUnavailable`，且不会创建 LaunchIntent、启动 Agent 或把部分 Worktree 标为 Ready。
- **SV1-T-28**：Renderer compromise fixture 伪造或改写 Launch Confirmation challenge、展示文本、payload / binding hash、receipt、用户手势与 Main IPC sender，并重放已签发 / 过期 challenge；所有尝试均不能产生可用 receipt 或启动 Agent。只有 Main 展示 Daemon 权威字段并接收真实原生确认的同一 challenge 可以签发一次。
- **SV1-T-29**：Renderer compromise fixture 通过路径选择、导航、自绘按钮、伪造 Main sender、替换 canonical identity、隐藏 validation plan、重放 / 改写 challenge 或直接提交 Trust 命令；所有尝试都不能产生 PendingValidation / Active Trust 或调用 Git。只有 Main 原生展示同一 RT-REPO-06 challenge 并取得真实用户确认后，才签发一次可用 `repositoryTrustReceipt`。
