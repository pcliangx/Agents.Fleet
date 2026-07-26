# R0-11 — Worktree Provision No-External-Program Checkout

> Branch: `r0-11-electron-filebroker-checkout`（slice C）。SV1-FILE-11 / RT-WORKTREE-11 / SV1-T-27 的 Worktree provision 物化边界，R0-05（Repository Trust 验证边界）的姊妹篇。
> Facts gathered 2026-07-26 on macOS with `/usr/bin/git` = Apple Git 2.50.1 (Apple Git-155)。Executable evidence: `packages/daemon/src/__tests__/provision-worktree.test.ts`（16 tests，hostile fixture + canary + network listener 全入口覆盖）。Probe transcripts: `docs/probes/r0-11/no-external-checkout-evidence.json`。

Deliverable: `packages/daemon/src/git/provision-worktree.ts` — Fleet-managed Worktree 的唯一物化入口。R0-05 的 frozen plan 从不物化 working tree；checkout/materialization 会触发 post-checkout hook、smudge/process filter、fsmonitor（index 写入时）等更多外部程序入口，本 probe 回答的核心问题是：**哪条物化路径可以证明 zero external program execution**。

## The boundary in one paragraph

- **Preflight（zero side effect）**：重新验证 Repository identity（SV1-FILE-10，drift → 零 Git 调用 fail closed）→ 记录 `git --version`（neutral cwd，evidence）→ `ls-tree -r -z <sha>` 枚举目标 commit 的 tree → `check-attr --source <sha> -z filter` 证明 **tree 内没有任何 path 携带 `filter` attribute**。filter 是 attribute 驱动的（实测 P3/S3）：无 attribute 则无 filter 执行，无论 config 声明什么。
- **Fail closed（SV1-FILE-11）**：任何 in-tree path 携带 set 的 `filter` attribute → `CapabilityUnavailable/external-filter-required`，附 findings（driver、repo config 是否声明、blob 是否 LFS 风格 pointer）。`check-attr --source` 不可用的 Git 版本 → `CapabilityUnavailable/cannot-prove-no-external-program`。两者都发生在任何 Worktree metadata、文件、LaunchIntent、Agent 之前（SV1-T-27）。
- **Materialization**：`git worktree add --detach <path> <sha>`，显式 binary、结构化 argv（no shell）、12-key 环境 allowlist、6 条 `-c` 覆盖（hooksPath=/dev/null、fsmonitor=false、pager=cat、diff.external=、credential.helper=、submodule.recurse=false）。`-c` 优先级高于 system/global/repo/include.path，Repository 无法重新打开任何入口。
- **Verify + classify**：realpath == planned path、`rev-parse HEAD` == 确认 SHA、`--show-toplevel` == target。失败时 `leftover: "none"`（可证无 side effect → Failed）vs `"unknown"`（可能有部分结果 → Orphaned），本模块从不删除无法证明归属的路径（RT-WORKTREE-06/11）。

## 候选物化路径实测对比

| 候选 | 实测 | 结论 |
| --- | --- | --- |
| **1. `git worktree add` + `-c` 覆盖 + 前置 filter 扫描（选定）** | post-checkout hook 被 `core.hooksPath=/dev/null` 中和（P1→P2）；fsmonitor 被 `core.fsmonitor=false` 中和（P9）；pager/credential/diff 中和（P11）；不递归 submodule（P10）；filter 靠 preflight 证明不存在可触发路径 | **可证明 no-external-program**；且物化语义就是 git 自己的 checkout 语义，byte-correct |
| 2. 纯 plumbing 物化（`worktree add --no-checkout` + `read-tree` + `checkout-index -f -a`） | `--no-checkout` 不跑 post-checkout hook（P6），但 `checkout-index` **照常执行 smudge filter**（P7），filter 问题一点没少；仍要同样的 preflight 扫描 | 无收益、多两步、更多失败点 → 否决 |
| 3. `git archive <sha> \| tar -x` | archive **也执行 smudge filter**（P8，未预期的实测结果）；`export-subst` 改写文件内容、`export-ignore` 丢文件（P8）——物化结果 ≠ checkout 语义 | 既不 exec-free 也不语义等价 → 否决 |

关键实测（原始命令与输出见 evidence JSON）：

| ID | 实测项 | 结果 |
| --- | --- | --- |
| P1 | `git worktree add`（hostile core.hooksPath，无覆盖） | post-checkout hook **执行** |
| P2 | 同上 + `-c core.hooksPath=/dev/null` | hook **不执行** |
| P3 | repo config `filter.evil.smudge` + `.gitattributes` 声明 `filter=evil` | `worktree add` 时 smudge **执行** |
| P3b | `-c filter.evil.smudge=`（已知名字的逐项覆盖） | 不执行 —— 但名字无法预知，不能作为主防线 |
| P4 | attr 声明 `filter=missing` 但 config 无该 driver | 不执行；checkout 出 raw blob（→ 完整性不可证，fail closed 的判据） |
| P5 | `git check-attr --source=<sha>` | 读到的是 **commit tree** 的 .gitattributes（working tree 被改成 `-filter` 后仍报 `evil`） |
| P5b | `.git/info/attributes` 声明 filter | check-attr **能看到**（info/attributes 在 attr stack 内）→ preflight 覆盖 |
| P6 | `worktree add --no-checkout` + hostile hooksPath | post-checkout hook 不执行 |
| P7 | `read-tree` + `checkout-index -f -a` + filter config | smudge **执行**（plumbing 填充不天然安全） |
| P8 | `git archive` | smudge **执行**；`export-subst` 展开 `$Format:%H$`；`export-ignore` 文件缺席 |
| P9 | `core.fsmonitor=<script>` | `worktree add` 写 index 时 hook **执行**；`-c core.fsmonitor=false` 中和 |
| P10 | `submodule.recurse=true` + 含 gitlink 的 tree | `worktree add` **不递归**、不填充 submodule 工作目录（无论 recurse 开关）；仍钉 `submodule.recurse=false` |
| P11 | hostile pager / credential.helper / diff.external + 全套覆盖 | 无一执行 |
| P12 | `worktree add` 失败（不存在的 SHA） | exit 128，target 无残留 → `leftover: "none"` |
| S1 | `core.attributesFile` 指向 repo 外 attrs 文件 | check-attr 能看到 → preflight 覆盖 |
| S2 | `ls-tree -r -z` / `check-attr -z --stdin` 输出格式 | `<mode> <type> <sha>\t<path>\0`；`path\0attr\0value\0` 三元组（实现依据） |
| S3 | config 声明 filter 但 tree 内无 path 引用 | 零执行，checkout 内容正确 → preflight 按 path 精确判定，不误伤 |
| S4 | `filter.x.process`（long-running process filter） | `worktree add` 时同样**执行** → 与 smudge 同等对待，CU |

## SV1-T-27 入口逐项结论（全部有 canary + 联网尝试的 executable evidence）

| 入口（fixture 配置） | provision 时能否执行 | 机制 |
| --- | --- | --- |
| post-checkout hook（core.hooksPath，含 include.path 二次声明） | **否** | `-c core.hooksPath=/dev/null`，优先级压过 repo config 与 include.path（P2） |
| smudge / clean filter | **否** | attribute 驱动：tree 内无 `filter` attribute 时 config 声明是死代码（P3/S3）；有 attribute → CU，物化前 fail closed |
| process filter（filter.x.process） | **否** | 同上（S4 + CU 测试） |
| external diff / diff.\<drv\>.command / textconv | **否** | provision 不跑 diff；`-c diff.external=` 兜底（P11） |
| fsmonitor hook | **否** | `-c core.fsmonitor=false`（P9） |
| submodule recursion | **否** | `worktree add` 本身不递归（P10）；`-c submodule.recurse=false` 钉死；fixture 配置 `submodule.sub.update = !canary.sh` 自定义更新命令 + `submodule.recurse=true`，断言工作目录不填充、sentinel 静默、零联网 |
| pager | **否** | `--no-pager` + `-c core.pager=cat` + `GIT_PAGER=cat`/`PAGER=cat`（P11） |
| credential helper | **否** | 无网络操作；`-c credential.helper=` + `GIT_TERMINAL_PROMPT=0`（P11） |
| Worktree 内可执行文件（build.sh fixture） | **否** | 物化只写数据；测试断言文件落地但 sentinel 静默 |
| 联网 | **否** | 每个 canary 脚本同时尝试 `/dev/tcp/127.0.0.1:<port>` 连接本地 listener，测试断言零连接 |

## 「需要外部 filter 才能正确 checkout」的检测逻辑（实测支撑）

`check-attr --source <sha>` 扫出任何 value 非 `unspecified`/`unset` 的 `filter` attribute 即 fail closed（`CapabilityUnavailable`），findings 逐项记录：

- **driver 已在 repo config 声明**（`config --local --get-regexp ^filter\.` 命中）→ 正确 checkout 需要执行该外部程序，或禁用后得到不完整内容：两种都越界（P3 证明它会执行；P3b 的逐项覆盖不能推广到未知名字）。
- **driver 未声明 + blob 是 LFS 风格 pointer**（`cat-file -s` ≤ 4 KiB 且首行匹配 `version https://git-lfs.github.com/spec/v1`）→ raw blob 不是真实内容，物化不完整（P4）。
- **driver 未声明 + 普通 blob** → 本机物化不会执行任何程序，但 repo 声明了 filter 意图，driver 可能只存在于被禁用的 user-global config 中（本仓库开发机的 global config 实测就声明了 `filter.lfs.process` —— fixture setup 曾被它劫持），正确性不可证 → fail closed。

判定为保守过近似：只对 `clean` 配置而无 smudge 的 driver、或 attr 打在 gitlink 上等理论上可证安全的情形，同样返回 CU。精确化属于后续 refinement，方向必须保持 fail closed。

## Git version

`check-attr --source` 需要 git ≥ 2.40；`core.hooksPath` ≥ 2.9。provisioner 不做版本下限硬编码（matrix 门槛属于 `SupportedPlatformMatrix`，R0-15）：旧 git 上 `check-attr --source` 以 exit 129 / `unknown option` 失败，分类为 `CapabilityUnavailable/cannot-prove-no-external-program`，正是 SV1-FILE-11「锁定 Git 版本没有可验证的 no-external-program 路径 → fail closed」要求的行为。每次成功的 provision 记录原始 `git --version` 字符串作 matrix 证据。Host probe: `/usr/bin/git` → `git version 2.50.1 (Apple Git-155)`。

## 实测 vs 推断

- **实测（本机执行过，有 transcript/canary）**：上表 P1–P12、S1–S4 全部；SV1-T-27 全入口 canary + 网络 listener；CU 六变体（smudge 配置、process 配置、config 缺失+pointer、config 缺失+普通 blob、info/attributes、core.attributesFile）；identity drift / target 已存在 / 非 SHA / 不存在 SHA / timeout 分类；argv/env 审计（12-key allowlist、6 条 `-c`、命令序列冻结为 `--version → ls-tree → check-attr → worktree → rev-parse → rev-parse`）。
- **推断（未单独实测，依据 git 文档与 R0-05 同款机制）**：`GIT_ATTR_NOSYSTEM=1` 中和 system 级 gitattributes（本机无 system attrs 文件，无法实测）；`diff.<drv>.textconv` 只在 diff 时触发，provision 路径不经过 diff，属结构性不触发。

## Non-guarantees / deferred

- **不覆盖** Ready transaction、Worktree record 状态机（RT-WORKTREE-05/10）、branch 策略（RT-WORKTREE-04，本原型恒 `--detach`）、reconciliation 与 orphan 接纳（RT-WORKTREE-06 的执行侧）——均属 Worktree Manager slice；本模块只输出 `leftover` 分类作为其输入。
- **不覆盖** provision 后的 inspection（status/diff 可能触达 clean filter，是 inspection slice 的边界；本模块 verify 只用 `rev-parse`）。
- **观察竞态**：preflight 扫描与 `worktree add` 之间 repo config / `.git/info/attributes` 被同用户其他进程改写的情形不在防御范围（SV1-NG-05/NG-08）；Trust/validation 绑定的是 Repository identity，内容级 TOCTOU 如实披露。
- **CU 精确化**：仅 clean 配置的 driver、gitlink 上的 filter attr、以及「driver 未声明但可证无外部程序」的细分类，当前一律 CU（过近似，fail closed 方向）。
- **大仓库**：`ls-tree` 全量枚举 + `check-attr` 按 256 path 分块；64 MB maxBuffer 之上 fail closed 为 `git-failed`。流式化属性能优化，非本 slice。
- **LaunchIntent / Agent / Ready 标记**：本模块无创建它们的能力（by construction），SV1-T-27 的「不创建 LaunchIntent、不启动 Agent、不把部分 Worktree 标为 Ready」由模块边界结构性满足，并由 CU 测试断言无 partial Worktree（target 不存在、`git worktree list` 无注册）。
