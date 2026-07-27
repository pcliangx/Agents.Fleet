# Agents.Fleet

本地优先的 macOS AI Agent 舰队工作台：让异构 CLI Agent 在 Fleet 独占分配的 Git Worktree 中可靠地并行执行、观察与恢复。UI(Electron) 只是投影，用户级 Daemon 拥有进程与权威状态。Status: R0 baseline 已冻结，R1 实施中。

> **本文件是所有编码 Agent CLI 的共享指令源。** `CLAUDE.md`（Claude Code）与软链 `AGENTS.md → CLAUDE.md`（Codex / OpenCode / Kimi Code）指向同一份内容。新增 CLI 若读别的文件名（如 `KIMI.md`），加一个指向 `CLAUDE.md` 的软链即可。内容保持 **CLI 中立**——不写任何单一 CLI 的专属语法或能力评判。

## 共享上下文：动手前先读这些

issue body 永远不是契约的唯一副本。按需阅读 canonical 文档：

| 读什么 | 它拥有什么 | 何时读 |
| --- | --- | --- |
| `CONTEXT.md` | 领域语言（ubiquitous language），术语英文 + 释义中文 | 任何工作前；产出用词必须与 glossary 一致，不漂移到 `_Avoid_` 同义词 |
| `docs/specs/v1.md` | 产品 PRD + User Story ID（`TRUST-*`/`TASK-*`/`WORKTREE-*`/…） | 改产品行为前 |
| `docs/specs/runtime-contracts-v1.md` | 运行时契约 `RT-*`（状态机/接口/故障矩阵/测试 `RT-T-*`） | 改运行时/状态/协议前 |
| `docs/specs/security-v1.md` | 安全契约 `SV1-*` + 测试 `SV1-T-*` | 改信任/边界/权限前 |
| `docs/adr/0001..0007` | 难逆架构决策 | 碰到相关区域前 |
| `README.md` | 非规范性摘要 + v1 Promise | 快速了解 |

**冲突规则**：发现 spec / ADR / CONTEXT 冲突，改 canonical 文件，不用 issue 或实现行为静默选择。已发布的 requirement ID 不得重编号或复用另一语义。产出与某 ADR 矛盾时显式标注 `_Contradicts ADR-XXXX — but worth reopening because…_`，不静默覆盖。领域文档消费规则见 `docs/agents/domain.md`。

## 多 Agent 协调工作

多个 Agent CLI（Claude Code / Codex / Kimi Code / OpenCode）可并行推进本项目。遵循 **worktree-first 协调模型**（与产品自身理念一致）：

1. **一个 agent = 一个 worktree = 一个 issue slice**。开始前 `gh issue list --state open` 选一个无 blocker、无 assignee 的 `ready-for-agent` issue，`gh issue edit <n> --add-assignee @me` 认领（这是会话的第一次写）。slice 依赖与当前前沿见 `r1-issue-dependency-dag.html`——只认领已解锁的 slice，不要碰仍 blocked 的（如 R1-05 依赖 R1-03 + R1-04）。
2. **独立 worktree 工作**：`git worktree add ../Agents.Fleet.<slice> -b <slice-id>-<kebab>`（如 `r1-03-host-adapter`）。绝不在 `main` 或他人的 worktree 上直接改。
3. **契约优先**：改产品/运行时/安全行为，先改 `docs/specs/` 对应 requirement，再改代码；改领域术语先改 `CONTEXT.md`。issue 必须链接 spec 路径 + stable requirement ID（如 `RT-STATE-05`、`SV1-TRUST-01`）。
4. **PR squash merge**：commit 信息 `feat(<R1-xx>): <摘要> (Closes #<issue>)`（参考 `git log --oneline`）。
5. **canonical 文档经评审**：`docs/specs/`、`docs/adr/`、`CONTEXT.md` 的修改走 PR，不直接推 `main`。

### Issue tracker / Triage

- Issue 在 GitHub Issues，用 `gh` CLI 操作。约定见 `docs/agents/issue-tracker.md`。
- 五种 triage label（label 字符串 = role 名）：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

## 构建与代码风格

```bash
pnpm install --frozen-lockfile   # Node 24.18.0 + pnpm 11.17.0（devEngines.runtime 自动下载 Node）
pnpm typecheck                   # tsc -b，composite 项目引用
pnpm test                        # vitest run（全量）
pnpm test:watch
pnpm lint                        # biome check .
pnpm format                      # biome format --write .
pnpm dev:daemon                  # daemon: tsx packages/daemon/src/index.ts
pnpm dev:desktop                 # Electron: electron-vite dev
```

- **pnpm monorepo**：`packages/{contracts,transport,terminal,daemon,testing}` + `apps/desktop`。跨包执行用 `pnpm --filter @agents-fleet/<pkg> <cmd>`。
- **Biome**：2-space indent、lineWidth 100、recommended lint、organizeImports on。
- **TypeScript 极严格**：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` + `verbatimModuleSyntax` + `noUnusedLocals` / `noUnusedParameters`。类型导入用 `import type`。
- **测试用真实临时 SQLite + 临时文件系统**，不为本地存储暴露 mock seam（契约要求，见 `RT-STO` / ADR-0005）。崩溃边界测试在真实子进程 SIGKILL 下验证。
- **`node-pty` 只允许出现在 `packages/daemon` 的 `ProcessSupervisor`**，`encoding: null` 接收原始 `Buffer`；不得进入 Electron 或其他 package（`RT-TERM-08` / `SV1-AUTH-09`，见 ADR-0003）。

## 硬约束

- **仓库自包含**：本仓库文档与代码不引用任何外部内部代号或私有项目名；引用外部资源只用公开 canonical 链接。
- **不夸大状态**：与产品哲学一致——不把不确定伪装成确定。无法确认进程或副作用时如实标注（`Uncertain` / `Lost` / `inferred`），不编造。`Uncertain` 是不可回写终态（`RT-STATE-05..08/22`）。
- **冻结值**：`matrixVersion=4` / `profileVersion=1` / `budgetVersion=1` 固化在 `packages/contracts/src/frozen-*.ts`；改任一 limit 必须升 version 并重跑受影响 fixture（`RT-LIMIT-03` / `RT-DIST-08`）。
- **终端 package allowlist** 锁定 5 个 `@xterm/*` 精确版本，不从 CDN/网络/prerelease 加载（`RT-TERM-01` / `SV1-TERM-01`）。
