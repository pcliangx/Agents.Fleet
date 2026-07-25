# R0-03 — Daemon 崩溃与孤儿进程行为

> Branch: `R0-03`。**本次实测**为以下契约提供 Daemon 进程崩溃层面的证据:
> RT-REC-07(Daemon 崩溃 → Session Lost / 孤儿)、RT-REC-12(按完整身份再识别)、
> RT-STATE-22/23(停止孤儿可能需 SIGKILL)、RT-T-08(不得把已死 Daemon 的 Session 当 Alive)。
> RT-REC-08(Host 重启)、RT-T-27(各 Disposition 状态下重启 Daemon 的 slot/replacement)**未在本次覆盖**, 见「边界与后续」。
>
> 实测于 2026-07-25, macOS 26.5.2 (25F84) / Apple Silicon / node v26.4.0 / node-pty 1.1.0(prebuilt)。
> 方法: `probe.mjs` 把 daemon-worker 作为子进程 spawn, 它用 node-pty 拉起 agent-child 并记录完整身份;
> orchestrator 随后以三种方式杀死 daemon-worker, 再从**独立进程**(= 重启后的新 Daemon / Reconciliation 视角)
> 观察子进程命运、按完整身份再识别、并尝试停止孤儿。证据: [`r0-03/evidence-daemon-crash.json`](r0-03/evidence-daemon-crash.json)。

## 结论

**三模式(正常退出 / SIGTERM / SIGKILL)完全一致: Daemon 以任意方式死亡时, 本探测使用的
signal-trapping 子进程都不会随之终止, 而是被 reparent 到 launchd(pid 1)成为仍运行但不可 attach 的孤儿,
同时收到一次 SIGHUP(PTY master 关闭)。**

- **实测直接支持**: Daemon 崩溃会留下仍存活的孤儿进程 → 必须做 Reconciliation 与孤儿探测(RT-REC-07),
  且不得把旧 Session 显示为 Alive(RT-T-08); 必须用 `{pid, lstart}` 完整身份再识别(RT-REC-12);
  停止孤儿可能需升级到 SIGKILL(RT-STATE-22/23)。
- **推断(非本次实测)**: 真实 Agent 是否存活取决于其自身 SIGHUP/SIGTERM 处理(本探测用 trapping 子进程);
  「不得自动 spawn replacement」是 RT-REC-07 的规范不变量, 由「孤儿存活」所推动, 但本探测未跑调度器观测替换行为。

附带一条 **#3 范围外**的供应链发现: node-pty 1.1.0 prebuilt `spawn-helper` 出厂无可执行位 + npm 11 allow-scripts
拦截 → `pty.spawn` 抛 `posix_spawnp failed.`(EACCES, 实测复现)。已拆为 [issue #22](https://github.com/pcliangx/Agents.Fleet/issues/22)
跟踪(RT-DIST-01 / SV1-SUPPLY-02), 不计入 R0-03 验收。

## 实测矩阵(三模式)

| 维度 | exit-normal | SIGTERM | SIGKILL(= 崩溃) |
| --- | :-: | :-: | :-: |
| Daemon(worker)退出 | `code=0` | `signal=SIGTERM` | `signal=SIGKILL` |
| trapping 子进程存活 | ✅ | ✅ | ✅ |
| 子进程 reparent 到 pid 1 | ✅ | ✅ | ✅ |
| 收到 SIGHUP(master 关闭) | ✅ | ✅ | ✅ |
| 心跳持续(确证真存活) | ✅(+8 beats) | ✅(+8) | ✅(+8) |
| stdout 写报错(察觉 master 消失) | ✅ | ✅ | ✅ |
| `{pid,lstart}` 再识别 | ✅ | ✅ | ✅ |
| 停止孤儿最终需要 | SIGKILL | SIGKILL | SIGKILL |

> 注: 本探测的 agent-child 是 **signal-trapping** 的(捕获并记录 SIGHUP/SIGTERM 但不退出), 用以观测
> **内核/node-pty 投递了哪些信号**, 与「子进程是否因此死亡」解耦。真实 Agent 是否存活取决于该 Agent 自身的
> signal 处理; SIGHUP 默认会终止多数进程, 但不能假定所有 Agent 都如此 —— 这是 R1/R2 runtime 需复核的项(推断)。

## node-pty process-group 语义(实测)

- 子进程是**自身 process group 的 leader**: `pgid == childPid`(实测)。(此处 process group 指 POSIX pgid,
  非 CONTEXT.md 的 Terminal Session 概念。)
- 负 pgid 信号可达: `kill(-pgid, SIGTERM)` 从新进程送达孤儿(实测 `sigtermByPgidReached=true`)。
- macOS `ps -o sess=` 对该进程返回 `0`(平台 quirk); 但 `pgid==pid` + 负 pgid 信号实测成功,
  已足够支撑「按 process group 停止孤儿」的设计。`getsid()` 级直接观测未单独验证(见边界)。

## 信号投递与子进程存活(RT-REC-07 / RT-LAUNCH-06)

- **PTY master 关闭 → 内核投递 SIGHUP**(三模式均观测到)。这是 master 消失时子进程收到的信号(实测)。
- 但 **SIGHUP 不是可靠清理信号**(实测): trapping 子进程收到 SIGHUP 后仍存活为孤儿。→ 不能依赖「Daemon 死 → 子进程自动死」。
- 子进程的 stdout 写在 master 消失后报错(EIO/EPIPE), 可作为「Daemon 消失」的**可观测信号**(实测) ——
  inert bootstrap **可借**此类 fd 消失作为自超时触发(RT-LAUNCH-06), 但 bootstrap 自超时本身属**推断**(本探测未跑 bootstrap)。

## 孤儿再识别(RT-REC-12: 不能只比 PID)

- `{pid, lstart}` 在存活期内稳定, 且可从新进程经 `ps -o lstart=` 查询; 实测三模式 `reidentifiedByFullIdentity=true`。
- **PID 复用**: 400 个短命进程 churn 窗口内**未观察到**旧 PID 被复用(`pidReuseNotObservedInProbeWindow=true`)。
  但未观察到 ≠ 不可能 —— macOS PID 终会被复用, 故 `pid-alone` 仍不安全(显式标注为**推断**)。
  → Reconciliation 必须按 **完整进程身份** `{pid, lstart, pgid, command}` 探测, 不能只比较 PID(RT-REC-12)。

## 停止孤儿(RT-STATE-22/23: StopRequested → ConfirmedStopped)

- `kill(pid, SIGTERM)` 与 `kill(-pgid, SIGTERM)` 均**送达**, 但 trapping 子进程挡住了 SIGTERM, 存活。
- 最终 `kill(pid, SIGKILL)` 终止(`sigkillByPidTerminated=true`)。
- 推论: Process Disposition 的 `StopRequested → ConfirmedStopped` 必须允许**升级到 SIGKILL**;
  `ConfirmedStopped` 只能在确认进程确实消失后写入(与本探测的「先 SIGTERM 再 SIGKILL 再验活」一致)。
- (pgid==pid, 故 `kill(-pgid, SIGKILL)` 等价; 本探测在 SIGKILL-by-pid 即终止, 未单独走到 -pgid 分支, 标注未独立验证。)

## Out-of-scope discovery: node-pty spawn-helper 供应链(→ issue #22)

**此发现属于分发/供应链范畴, 不在 #3「Daemon 崩溃与孤儿进程行为」内, 完整跟踪见
[issue #22](https://github.com/pcliangx/Agents.Fleet/issues/22)。** 此处仅记录实测事实:

- node-pty 1.1.0 的 prebuilt `spawn-helper`(`prebuilds/darwin-arm64/spawn-helper`)出厂 mode **`0644`**(无可执行位)。
- 正常安装靠 node-gyp 重编译或 prebuild 解压恢复 +x; 但 **npm 11 的 allow-scripts 默认拦截 lifecycle 脚本**,
  该恢复路径被切断 → `pty.spawn` 抛 `posix_spawnp failed.`(EACCES)。
- **实测复现**: chmod 之前的 `pty.spawn` 即抛 `posix_spawnp failed.`; `chmod 0755` 后恢复。
- 推论(前瞻要求): 发布清单必须把 `spawn-helper` 纳入 native artifact 校验(执行位 + 代码签名 + 公证),
  Daemon 安装/升级不得依赖 npm 生命周期。

## 对 Reconciliation / 启动协议 / 分发的推论

除标注「推断」外, 均由本次实测直接支持。

1. Daemon 崩溃后**必须**执行 Reconciliation 并做孤儿探测(RT-REC-07); 孤儿探测按完整身份, 不只比 PID(RT-REC-12)。
2. **不得自动 spawn replacement**(RT-REC-07 / RT-T-08): 孤儿可能仍占用 slot 与 Worktree, 自动重开会叠加副作用。
   *(推断: 本探测证实孤儿会存活, 从而推动该不变量; 但未跑调度器观测替换行为。)*
3. inert bootstrap 必须自超时退出, 不得假定随 Daemon 退出(RT-LAUNCH-06/07); 可借 master/fd 消失作为触发信号。
   *(推断: 本探测未运行 bootstrap。)*
4. 停止孤儿允许升级到 SIGKILL(RT-STATE-22/23); `ConfirmedStopped` 只在确认进程消失后写入。
5. Daemon 安装/升级必须显式校验 `spawn-helper` 执行位与签名(RT-DIST-01 / SV1-SUPPLY-02, issue #22)。
   *(范围外发现。)*

## 证据与复现

- 探测脚本: [`r0-03/probe.mjs`](r0-03/probe.mjs)(orchestrator) + [`r0-03/daemon-worker.mjs`](r0-03/daemon-worker.mjs)(旧 Daemon, node-pty owner) + [`r0-03/agent-child.mjs`](r0-03/agent-child.mjs)(Agent, heartbeat + signal 日志) + [`r0-03/ps-helpers.mjs`](r0-03/ps-helpers.mjs)(共享 `ps` 身份解析)
- 证据: [`r0-03/evidence-daemon-crash.json`](r0-03/evidence-daemon-crash.json)(脱敏实测)
- 结构化 fixture: [`packages/testing/src/fixtures/daemon-crash-behavior.ts`](../../packages/testing/src/fixtures/daemon-crash-behavior.ts)(实测/推断标注 + `inferredImplications`, 喂 ProcessSupervisor #9/#10 与 Reconciliation)
- 复现: `node docs/probes/r0-03/probe.mjs docs/probes/r0-03/evidence-daemon-crash.json`
  (probe 自带 setup: 在 `$TMPDIR/r0-03-pty-env` 临时 `npm install node-pty@1.1.0`, **chmod 前先 spawn 一次复现 EACCES**, 再 chmod; repo 零新依赖, 不触发 packages/apps 的 node-pty guard。)

## 边界与后续(本次未覆盖)

- **RT-REC-08(Host 重启)**: 仅测 Daemon 进程死法, 未测 Host 重启 / launchd KeepAlive 自动拉起 Daemon 后与孤儿进程的交互(ADR-0001: LaunchAgent 拉起 Daemon)。RT-REC-07 的该子项与 RT-REC-08 的完整闭环需后续原型。
- **RT-T-27**: 未运行 SQLite/Repository/Attempt 状态机; 各 Process Disposition 状态下重启 Daemon 的 slot 与 replacement 行为未实测。
- 单 Host 单次采样; `SupportedPlatformMatrix`(R0-15)冻结后需在矩阵最低 macOS / 最低硬件上复测同一 fixture。
- agent-child 为 signal-trapping; **真实 Agent 的存活取决于其 SIGHUP/SIGTERM 处理**, 需 R1(Claude)/ R2(Codex) runtime 复核(推断)。
- macOS `ps -o sess=` 返回 0; session 语义的更强证据需 `getsid()` 级直接观测(本探测用 pgid 已可落地停止语义, 未单独做)。
- PID 复用未在窗口内复现; 无法证伪, 设计仍按「pid-alone 不安全」处理(推断)。
- 三模式 SIGKILL-by-pid 即终止孤儿, 故 `kill(-pgid, SIGKILL)` 未单独走到; pgid==pid 下二者等价, 已在 fixture 标注未独立验证。
