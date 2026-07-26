# R0-11 — 无外部程序 Worktree checkout（#10 第一片）

> Branch: `worktree-r0-11-boundary`。验证 SV1-FILE-11 / RT-WORKTREE-11 / SV1-T-27 的 checkout 物化边界。
> 实测于 2026-07-26，Apple Git 2.50.1（`/usr/bin/git`）。

## 范围

#10 (R0-11) 跨三块——(1) 无外部程序 Worktree checkout、(2) FileBroker native directory-fd、(3) Electron 边界（app protocol/CSP/fuses）。本 probe 只覆盖 **(1)**，其余两块为后续独立 slice。

## 问题

Worktree provision 用 `git worktree add` 物化文件时会触发外部程序（post-checkout hook、smudge/process filter、可能的 fsmonitor/submodule）。Fleet 必须证明这些入口在 materialize 时**都不执行**；若 Repository 需要 filter 才能得到正确 checkout，则 fail-closed（CapabilityUnavailable），不得用「不完整但可启动」的 Worktree 继续 LaunchIntent（SV1-FILE-11 / RT-WORKTREE-11）。

## 结论

**`materializeWorktree` 在锁定 git 上达成 no-external-program checkout：post-checkout hook 被 `core.hooksPath=/dev/null` 禁用（canary 实测不触发）；声明的 filter 经 `git check-attr` 检测后 fail-closed（不 checkout、filter 程序永不运行）；fsmonitor/submodule/pager/credential/external-diff 作为纵深防御禁用（当前 git 的 `worktree add` 本就不调用它们，禁用防未来回归）。**

入口处理（SV1-T-27）：

| 入口 | 处理 | 实测 |
| --- | --- | --- |
| post-checkout hook | `core.hooksPath=/dev/null` 禁用 | ✓ canary 不写 |
| smudge/clean/process filter | `check-attr filter` 检测；任一非 unset → CapabilityUnavailable（不 checkout） | ✓ fixture fail-closed |
| fsmonitor | `core.fsmonitor=false`（纵深防御；worktree add 不调用） | 禁用 |
| submodule recursion | `submodule.recurse=false`（纵深防御；worktree add 不 init submodule） | 禁用 |
| pager / credential / external diff | `-c` 禁用（不被 checkout 触发） | 禁用 |

实现：`packages/daemon/src/git/worktree-checkout.ts` `materializeWorktree()`。镜像 restricted-git 边界（显式 binary、结构化 argv、无 shell、清理 env、`-c` 最高优先级），未改已合并的 R0-05 模块。

## 证据（RT-T 风格 fixture）

`packages/daemon/src/__tests__/worktree-checkout.test.ts`（3 测试）：

1. 干净 repo 物化成功、HEAD == baseCommitSha、文件存在。
2. 武装 post-checkout hook（写 canary）→ 物化后 canary 不存在（hook 未运行）。
3. repo 声明 `* filter=myfilter`（+ filter driver）→ `CapabilityUnavailable(declared-filter)`，target 未物化（filter 程序未运行）。

## 边界与后续

- **filter 检测的精度**：用 `git ls-tree -r --name-only <baseSha>` 列被物化路径 + `git check-attr filter -- <paths>`（读 working-tree `.gitattributes`）判定。未用 `--source=<tree>`（兼容性；Apple Git 2.50.1 下 working-tree `.gitattributes` 是合理代理）。路径数未来受 `RuntimeLimitProfile.fileTreeEntries` 约束（当前 argv 形式，大 repo 需改 `--stdin` 分批）。
- **filter 的 `required` 语义**：git 对 `filter.<drv>.required=true` 会在 filter 缺失时自行失败；本实现一律 fail-closed（无论 required），更保守、与 spec「需要外部 filter 才能 checkout」一致。
- **fsmonitor/submodule canary**：未加，因当前 git 的 `worktree add` 不调用它们（canary 测试会是空真的——TDD 反模式）；改为纵深防御禁用 + 本表记录。
- **未覆盖（#10 其他 slice）**：FileBroker（native openat directory-fd，SV1-FILE-01..11）、Electron 边界（app protocol/CSP/sender-frame/fuses，SV1-ELECTRON-01..07）。这两块与 checkout 是不同 surface，后续 slice/issue 处理。
- **`materializeWorktree` 与 Worktree Manager**：本片是 RT-MOD-04 Worktree Manager provision 的 no-external-program 物化原语；Ready transaction / Orphaned 处置（RT-WORKTREE-05/10）属 Worktree Manager 实现切片，不在本 probe。

## 证据与复现

- 实现：`packages/daemon/src/git/worktree-checkout.ts`。
- 测试：`packages/daemon/src/__tests__/worktree-checkout.test.ts`。
- 复现：`pnpm vitest run packages/daemon/src/__tests__/worktree-checkout.test.ts`。
