# R0-11 slice B — native FileBroker 风险原型（macOS 上兑现 openat 语义）

> Branch: `r0-11-electron-filebroker-checkout`。**本次实测**为以下契约提供证据：
> SV1-FILE-01（root canonicalize + identity 保存与重验）、SV1-FILE-02（单 root 解析、
> 拒绝绝对/`..`/NUL/越界 symlink、跨 root handle 复用拒绝）、SV1-FILE-03（检查与打开
> 绑定同一已验证 directory 身份的 fd 相对逐段解析）、SV1-FILE-08（FileBroker 为私有
> Implementation；能力缺失 / identity 不可证明时 fail closed）、SV1-T-02 / SV1-T-17 /
> SV1-T-26（本 slice 覆盖 FileBroker 侧；受限 Git Interface 侧与 common Git directory
> 的 Git 操作面归 slice 内其他部分 / R1）。
>
> 实测于 2026-07-26，macOS 26.5.2 (25F84) / Darwin 25.5.0 / Apple Silicon (arm64) /
> node v24.18.0。竞态 fixture 用**独立攻击者进程**高频 rename/symlink 替换（OS 级真并发，
> 不受 Node 单线程交错限制）。证据：[`r0-11/filebroker-evidence.json`](r0-11/filebroker-evidence.json)。

## 结论（Verdict）

**可行。** Node.js 没有 openat 绑定，但用纯 Node 内置能力（无新增依赖、无 native 构建）
可以兑现与 macOS `openat(O_NOFOLLOW)` 逐段解析**等价**的语义：**chdir 梯子** ——
`lstat(root)` 身份重验 → `chdir(root)` → `stat(".")` 与注册 identity 比对 → 逐段
`lstat`（拒 symlink）→ `chdir(段)` → `stat(".")` 与该段 lstat 的 dev/ino 比对 →
末段 `open(O_NOFOLLOW)` + `fstat` 比对。每一跳把后续解析锚定在**已进入的目录 vnode**
上（cwd 是 vnode 引用，路径改名不影响它）。竞态实测：**symlink swap 与 root 替换各
2000 次迭代，0 次逃逸**（攻击者内容零读取）。两个朴素候选在同样竞态下都实测逃逸。

生产实现建议仍以 N-API 包装真实 `openat(2)`（macOS 有），消除进程全局 cwd 依赖；
本原型证明的是语义上界与 fail-closed 分类，不是最终形态。

## 候选机制实测对比

| # | 候选 | 实测 | 结论 |
| --- | --- | --- | --- |
| 1 | `/dev/fd/<dirfd>/<subpath>` 穿透（Linux /proc/self/fd 风格） | `openSync("/dev/fd/11/child.txt")` → **ENOENT**；fdesc 不支持子路径解析 | 不可用 |
| 1b | `process.chdir("/dev/fd/<dirfd>")`（模拟 fchdir） | **ENOTDIR** | 不可用 |
| 2 | 逐段 `lstat` + 字符串路径 `open(O_NOFOLLOW)` + `fstat` 比对 | symlink swap 竞态 5000 次迭代**逃逸 289 次**：lstat 与 open 之间中间段 symlink 被换入，open 跟随到 root 外 | **不满足 SV1-FILE-03**，拒绝（检查与打开绑定的是字符串路径而非目录 vnode） |
| 2b | `realpath` 含 `root` 前缀检查 + 按结果字符串打开 | 同样竞态 5000 次迭代**逃逸 1 次** | 不满足（spec 已点名），拒绝 |
| 3 | `fs.opendir` 的 Dir handle | Dir 不暴露 dirfd，也无相对 open API | 不可用 |
| 4 | **chdir 梯子（选定）** | symlink swap 2000 次 + root 替换 2000 次迭代，**0 逃逸**；中间段 swap 全部落入 `symlink-rejected` / `not-found` / `race-lost`，root 替换全部落入 `identity-drift` / `race-lost` | 采纳；语义等价 macOS openat(O_NOFOLLOW) 逐段 |

机制 4 的关键性质（逐条实测支撑）：

- **cwd 是 vnode 引用**：`chdir(dir)` 后把 `dir` rename 走、在原路径放攻击者目录，
  相对打开仍落在原目录（`fstat` 与原 identity 一致；攻击者内容零读取）。
- **stat(".") 后验**：`lstat(name)` 与 `chdir(name)` 之间被换入另一个目录时，进入后
  `stat(".")` 的 dev/ino 与 lstat 不符 → `race-lost`，绝不继续下行。
- **O_NOFOLLOW 只作用于末段**，所以中间段 symlink 必须靠逐段 lstat 拒绝 ——
  这正是候选 2 的逃逸窗口（它只 lstat 末段）。
- **打开即钉住**：fd 打开后的 rename/swap 不影响本次操作（SV1-T-17「操作原已验证
  identity」分支）；`fstat` 与末段 `lstat` 的 dev/ino 比对关闭 lstat→open 窗口。

## 实测 vs 推断

- **实测**：上表全部候选行为；两类竞态 0 逃逸；19 例 vitest（拒绝 fixture + 竞态
  fixture + happy path）三连胜；SV1-T-26 四类 root kind（repository / worktree /
  app-data / common-git-dir）各自的 absolute/`..`/symlink/identity 替换 fixture 与
  跨 root handle 复用拒绝。
- **推断（非本次实测）**：`SupportedPlatformMatrix`（R0-15）冻结后需在矩阵最低
  macOS 上复测；Linux 上机制 1（/proc/self/fd）与 openat2 `RESOLVE_BENEATH` 可用，
  语义只会更强，但未实测。

## FileBroker 原型形状（SV1-FILE-01/02/08）

代码：[`packages/daemon/src/worktree-manager/filebroker.ts`](../../packages/daemon/src/worktree-manager/filebroker.ts)。

- `registerRoot(kind, path)`：realpath canonicalize + lstat，保存 `{dev, ino}`
  identity 与 opaque root id（SV1-FILE-01）。四类 `RootKind`。
- `readFile(rootId, rel)` / `writeFile(rootId, rel, data)`：**只接受 root id + 相对
  路径**，没有按字符串绝对路径解析的重载 —— 调用方无法拼接路径、换 root 或复用旧
  handle 扩大访问（SV1-FILE-02）。未知 id → `unknown-root`。
- 词法拒绝：绝对路径、`..`（含留在树内的 `sub/../x`）、NUL、空段、`.`段。
- symlink 一律拒绝（中间段与末段；包括指向树内的 symlink —— 原型从严）。
- 每次操作重新验证 root identity；路径暂时消失也按 `identity-drift` fail closed
  （无法证明 identity，SV1-FILE-08）。
- 错误分类稳定：`invalid-path` / `unknown-root` / `identity-drift` /
  `symlink-rejected` / `race-lost` / `not-found` / `capability-unavailable`。
- 构造即探测平台能力（`process.chdir`、`O_NOFOLLOW`、darwin/linux），缺失即
  `capability-unavailable`，不静默降级（SV1-FILE-08）。

## 证据与复现

- 测试：[`packages/daemon/src/worktree-manager/filebroker.test.ts`](../../packages/daemon/src/worktree-manager/filebroker.test.ts)
  （19 例），竞态攻击者 fixture：`race-attacker.mjs`（symlink swap）、
  `race-root-attacker.mjs`（root 替换），均为独立子进程。
- 证据：[`r0-11/filebroker-evidence.json`](r0-11/filebroker-evidence.json)
  （候选对比、竞态迭代计数与 0 逃逸、每契约 ID 的验证方式）。
- 复现：`pnpm vitest run packages/daemon/src/worktree-manager`（竞态统计打印在
  stdout；三连胜实测）。

## 边界与后续（本次未覆盖）

- **进程全局 cwd**：chdir 梯子是进程级状态。原型全程同步执行，依赖 Node 主线程
  单线程模型；与 Worker 线程并发 chdir 不兼容。生产 Daemon 若引入 Worker，FileBroker
  操作必须串行化或迁移到 N-API openat —— 这是 R1 的硬约束，已在代码头注记。
- **外部目录 rename 进树内不可区分**：攻击者把 root 外某目录 rename 进树内名字时，
  任何 fd 相对机制（含 macOS 原生 openat，无 `RESOLVE_BENEATH`）都无法与合法树内
  rename 区分。本原型与原生 openat 在此攻击面上语义相同；缓解靠 root identity 钉住
  + fd 打开即钉住 + SV1-NG-06 的诚实披露（同用户进程本就可在最后观察后改写）。
- **mount identity 替换**（卸载/重挂整个卷）未实测：dev/ino 校验在重新挂载后必然
  drift → fail closed，方向正确但未在真机上做 mount fixture（需要 root 权限，超出
  原型范围）。
- **写操作面较窄**：`writeFile` 只覆盖 create/overwrite 常规文件；atomic rename
  写、mkdir、unlink、readdir 未实现，R1 按 Worktree provision（SV1-FILE-11）需要
  在同一解析器上扩展。
- **SV1-T-26 的受限 Git Interface 侧**（common Git directory 的 Git 操作、Renderer
  不可浏览）归本 issue 其他 slice / R0-05 已覆盖部分，本原型只覆盖 FileBroker 侧。
- **dispose / provision 复合流程**（SV1-FILE-04/05/09/11）不在本 slice；FileBroker
  只是它们的私有文件原语。
