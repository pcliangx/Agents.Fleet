# R0-02 — LaunchAgent 启动环境探测

> Branch: `r0-02/launchagent-env`。验证 ADR-0001 的关键假设: LaunchAgent 下 PATH、shell、Keychain 与 Agent discovery 的实际行为。
> 实测于 2026-07-25, macOS 26.5.2 (25F84) / Apple Silicon。方法: `probe.mjs` 分别以交互式 shell 与真实 `launchctl bootstrap gui/<uid>` 运行, 采集脱敏 JSON 证据。

**结论: ADR-0001 的决策（绝对路径 + 清理后环境，不依赖系统 Node / 用户 shell 初始化 / 可变 PATH）被实测数据完整证实为必要且可行。** RT-ENV-02 形态的中立 probe（显式路径 + 清理环境 + 中立 cwd）在 LaunchAgent 下可正常执行 Agent 版本探测；Keychain 无需用户交互即可达（SV1-DATA-01 / SV1-AUTH-03 前置成立）。

## 实测对比

| 维度 | LaunchAgent（实测） | 交互式 shell（基线） |
| --- | --- | --- |
| env 变量总数 | **11** | 38 |
| `PATH` | **`/usr/bin:/bin:/usr/sbin:/sbin`** | 25 段用户定制（homebrew、`~/.local/bin` 等） |
| shell 初始化 | **不继承**（PATH 即证据；`SHELL=/bin/zsh` 被设置但 rc 未执行） | 继承 |
| `cwd` | **`/`** | 调用者目录 |
| `LANG` / `TERM` | **均未设置** | `LANG=en_AU.UTF-8`、`TERM=dumb` |
| `HOME` / `USER` / `LOGNAME` / `TMPDIR` | 均正确设置 | 同 |
| `SSH_AUTH_SOCK` | 已设置（launchd session socket） | 已设置 |
| `node` / `claude` / `codex` 按 PATH 解析 | **全部 null** | 全部解析成功 |
| `git` / `security` 按 PATH 解析 | `/usr/bin/git`、`/usr/bin/security` | 同 |

LaunchAgent 完整 env（11 项，脱敏证据原文）: `HOME` `LOGNAME` `OSLogRateLimit` `PATH` `SHELL` `SSH_AUTH_SOCK` `TMPDIR` `USER` `XPC_FLAGS` `XPC_SERVICE_NAME` `__CF_USER_TEXT_ENCODING`。

## Agent discovery（RT-ADAPTER-06 / RT-ENV-02）

- 默认 PATH 上**找不到** `node`、`claude`、`codex` — discovery 不能依赖 PATH 或 shell 初始化，必须使用显式候选路径（本机实测: `~/.local/bin/claude`、`~/.local/bin/codex`，均为指向版本化安装的 symlink）。
- 以 RT-ENV-02 形态 probe（清理环境 `HOME/USER/LOGNAME/TMPDIR/PATH/LANG`、中立 cwd、不经 login shell）:
  - `~/.local/bin/claude --version` → `2.1.218 (Claude Code)` ✓
  - `~/.local/bin/codex --version` → `codex-cli 0.145.0` ✓
- 即：两阶段 discovery 的 verified 阶段在 Daemon（LaunchAgent）中可行；candidate 阶段（pre-Trust）只读路径/安装信息，不执行。

## Keychain（SV1-DATA-01 / SV1-AUTH-03 前置）

- `security list-keychains` 正常返回，login keychain 可见（与交互式一致）。
- 对不存在服务名的 `find-generic-password` 返回 exit 44「could not be found in the keychain」——与交互式完全相同: **Keychain API 从 LaunchAgent 可达，无需用户交互，不弹窗**。

## 对 Daemon 启动环境的强制推论（输入 RT-ENV-03 Environment Snapshot）

1. Daemon 自身与子进程必须使用**绝对路径**（Daemon 不能依赖系统 Node —— 默认 PATH 上没有 node）。
2. 给 Agent 子进程注入**显式 PATH**，继承变量走 allowlist。
3. 必须注入 `LANG`（UTF-8）与 `TERM`——LaunchAgent 环境两者皆无，PTY 程序行为依赖之。
4. 必须显式设置中立 cwd——LaunchAgent 默认 cwd 是 `/`。
5. Keychain 可用于 secret 存储与 Main/Daemon 共享 access group，无交互阻塞。

## 证据与复现

- 探测脚本: [`r0-02/probe.mjs`](r0-02/probe.mjs)（env 脱敏后落盘；DENYLIST 变量不写入仓库）
- plist: [`r0-02/launchagent.plist`](r0-02/launchagent.plist)（`bootstrap gui/<uid>` 一次性运行，取证后即 `bootout` 并删除）
- 证据: [`r0-02/evidence-launchagent.json`](r0-02/evidence-launchagent.json) / [`r0-02/evidence-interactive.json`](r0-02/evidence-interactive.json)
- 结构化 fixture: [`packages/testing/src/fixtures/launchagent-environment.ts`](../../packages/testing/src/fixtures/launchagent-environment.ts)（Host Environment Module 与 discovery 的已测事实输入）

## 边界与后续

- 单台机器单次采样；`SupportedPlatformMatrix`（R0-15）冻结后需在矩阵最低 macOS 上复测同一 fixture。
- 未测 File Provider / 企业 MDM 受限账号等变体；若矩阵覆盖，补充 fixture。
- SSH_AUTH_SOCK 在 LaunchAgent 下可用，但 Daemon 是否允许 Agent 继承它属于 Permission Mapping / 继承 allowlist 决策，不在本探测范围。
