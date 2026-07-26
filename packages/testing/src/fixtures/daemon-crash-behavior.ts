/**
 * R0-03 Daemon crash & orphan-process behavior — 结构化结论 fixture。
 * 证据与采集方法见 docs/probes/r0-03-daemon-crash-behavior.md(含脱敏 JSON 证据)。
 * 采集: 2026-07-25, macOS 26.5.2 (25F84), Apple Silicon, node v26.4.0,
 * node-pty 1.1.0(prebuilt),用户进程三模式(exit-normal / SIGTERM / SIGKILL)。
 *
 * 用途: 未来 ProcessSupervisor(#9/#10)与 Reconciliation(RT-REC)以这些已测得
 * 事实为输入。字段注释区分「实测(measured)」与「推断(inferred)」; 未验证的
 * 路径显式标注, 不得当作事实消费。推断项另列于 inferredImplications。
 *
 * 核心实测结论: 当持有 node-pty master 的 Daemon 以任意方式(正常退出 / SIGTERM /
 * SIGKILL)死亡时, 由本探测使用的 signal-trapping 子进程不会随 Daemon 终止, 而是被
 * reparent 到 launchd(pid 1)成为仍运行但不可 attach 的孤儿, 同时收到一次 SIGHUP
 * (PTY master 关闭)。真实 Agent 是否存活取决于其自身 signal 处理(见 signalDelivery)。
 */

/** 单个崩溃模式下子进程命运的实测结果(本探测的 trapping 子进程)。 */
export interface CrashModeResult {
  readonly mode: "exit-normal" | "sigterm" | "sigkill";
  /** 实测: Daemon 死后子进程是否仍存活(本探测使用 signal-trapping 子进程)。 */
  readonly childSurvived: boolean;
  /** 实测: 子进程 ppid 是否变为 1(reparent 到 launchd)。 */
  readonly orphanedToPid1: boolean;
  /** 实测: PTY master 关闭时内核是否向子进程投递 SIGHUP。 */
  readonly sighupDelivered: boolean;
  /** 实测: 子进程是否仍持续心跳(确证真存活, 不是 zombie)。 */
  readonly heartbeatContinued: boolean;
  /** 实测: 停止该孤儿最终需要 SIGKILL(trapping 子进程挡住了 SIGTERM)。 */
  readonly stopRequiredSigkill: boolean;
}

// runtime.node 是 R0-03 采集时的 host Node 快照（v26.4.0），与 project managed Node
// 24.18.0（devEngines）解耦——此 fixture 冻结历史实测环境，不随基线升级变化。
export const DAEMON_CRASH_BEHAVIOR_PROFILE = {
  profileId: "r0-03-daemon-crash-behavior",
  capturedAt: "2026-07-25",
  platform: "macOS 26.5.2 (25F84), Apple Silicon",
  runtime: { node: "v26.4.0", nodePty: "1.1.0", nodePtyPrebuilt: true },

  /**
   * node-pty spawn-helper 供应链发现。**#3 范围外的附带发现**(属分发/供应链), 完整
   * 跟踪见 issue #22; 此处仅保留实测事实, 不计入 R0-03 验收。
   *
   * 实测: prebuilt spawn-helper 以 mode 0644 发布(无可执行位); npm 11 allow-scripts 拦截
   * 其 lifecycle chmod; **chmod 前的 pty.spawn 复现了 `posix_spawnp failed.`(EACCES)**。
   * 发布清单(RT-DIST-01 / SV1-SUPPLY-02)必须显式校验并修复其执行位(及签名/公证)。
   */
  nodePtySpawnHelper: {
    outOfScopeForR003: true,
    trackedInIssue: 22,
    shipsNonExecutable: true,
    modeBeforeChmod: "0o644",
    modeAfterChmod: "0o755",
    npmAllowScriptsBlocksLifecycle: true,
    /** 实测: chmod 前的 pty.spawn 抛 `posix_spawnp failed.`(EACCES)。 */
    posixSpawnpFailsWithoutChmod: true,
    posixSpawnpErrorObserved: "posix_spawnp failed.",
    /** 推断: Daemon 安装/升级流程必须显式 chmod + 校验 spawn-helper, 不得依赖 npm 生命周期。 */
    daemonMustVerifyHelperExecBitAndSignature: true,
  },

  /**
   * node-pty 子进程的 process-group 语义(实测)。注意: 这里说的是 POSIX process
   * group(pgid), 不是 CONTEXT.md 的 Terminal Session(Session)概念。
   * 子进程是其自身 process group 的 leader(pgid == pid); 负 pgid 信号可达。
   * 注: macOS `ps -o sess=` 对该进程返回 0(平台 quirk), 但 pgid==pid + 负 pgid 信号
   * 实测成功, 已足够支撑"按 process group 停止孤儿"的设计。
   */
  processGroupSemantics: {
    childIsOwnProcessGroupLeader: true,
    pgidEqualsChildPid: true,
    negativePgidSignalReachesChild: true,
    macOSPsSessReturnedZero: true,
    /** 推断: 同一事实的更强证据需 getsid() 级直接观测, 本探测用 pgid 已可落地停止语义。 */
    sidSemanticsNotIndependentlyVerified: true,
  },

  /**
   * 三种 Daemon 死法下子进程的命运(实测, 三模式一致)。
   * 即使 SIGKILL Daemon, 子进程仍存活并 reparent 到 pid 1。
   */
  crashModes: [
    {
      mode: "exit-normal",
      childSurvived: true,
      orphanedToPid1: true,
      sighupDelivered: true,
      heartbeatContinued: true,
      stopRequiredSigkill: true,
    },
    {
      mode: "sigterm",
      childSurvived: true,
      orphanedToPid1: true,
      sighupDelivered: true,
      heartbeatContinued: true,
      stopRequiredSigkill: true,
    },
    {
      mode: "sigkill",
      childSurvived: true,
      orphanedToPid1: true,
      sighupDelivered: true,
      heartbeatContinued: true,
      stopRequiredSigkill: true,
    },
  ] as const satisfies readonly CrashModeResult[],

  /**
   * SIGHUP 投递与子进程存活的关系(实测 + 推断)。
   * master 关闭确实投递 SIGHUP, 但子进程是否死亡取决于其自身 signal 处理: 本探测的
   * trapping 子进程存活为孤儿; 真实 Agent 是否存活取决于该 Agent 的 SIGHUP 行为。
   */
  signalDelivery: {
    sighupDeliveredOnMasterClose: true,
    /** 实测(trapping 子进程): SIGHUP 送达但子进程存活 → SIGHUP 不是可靠清理信号。 */
    sighupDoesNotGuaranteeChildDeath: true,
    /** 推断: 真实 Agent 的存活取决于其 SIGHUP/SIGTERM 处理, 需 R1/R2 runtime 复核。 */
    realAgentSurvivalDependsOnAgentSignalHandling: true,
    /** 实测: 子进程的 stdout 写在 master 消失后报错(EIO/EPIPE), 可作为"Daemon 消失"的可观测信号。 */
    childDetectsMasterGoneViaStdoutError: true,
  },

  /**
   * 孤儿再识别(RT-REC-12: 必须按完整进程身份探测, 不能只比 PID)。
   * {pid + lstart} 在存活期内稳定且可从新进程查询; PID 单独不安全。
   */
  reidentification: {
    fullIdentityPidPlusLstartReliable: true,
    lstartStableAcrossCrash: true,
    /** 实测: 400 短命进程 churn 窗口内未观察到旧 PID 被复用。 */
    pidReuseNotObservedInProbeWindow: true,
    /** 推断: 未观察到 ≠ 不可能; macOS PID 终会被复用, 故 pid-alone 仍不安全。 */
    pidReuseRemainsRiskDespiteNoObservation: true,
    /** 实测: kill(-pgid, SIGTERM) 与 kill(pid, SIGKILL) 均从新进程可达孤儿。 */
    orphanStoppableFromNewProcess: true,
  },

  /**
   * 停止孤儿的升级路径(实测)。
   * SIGTERM(按 pid 或按负 pgid)送达但被 trapping 子进程挡住; 必须 SIGKILL 才终止。
   * 喂 RT-STATE-22/23 的 StopRequested → ConfirmedStopped: 停止可能需要升级到 SIGKILL。
   */
  orphanStop: {
    sigtermByPidReached: true,
    sigtermByPgidReached: true,
    sigtermDidNotTerminateTrappingChild: true,
    sigkillByPidTerminated: true,
    /** 推断: 同样可用 kill(-pgid, SIGKILL)(pgid==pid); 本探测在 SIGKILL-by-pid 即终止, 未单独走到 -pgid 分支。 */
    sigkillByPgidNotSeparatelyExercised: true,
  },

  /**
   * 全部推论。除标注「推断」外均由本次实测直接支持。
   * 注意: 本探测只覆盖 Daemon 进程崩溃; RT-REC-08(Host 重启)、RT-T-27(各 Disposition 状态下
   * 重启 Daemon 的 slot/replacement)未实测, 见报告「边界与后续」。
   */
  implications: [
    // RT-REC-07 / RT-T-08
    "daemon-crash-leaves-orphan-process",
    "orphan-survives-sigkill-of-daemon",
    "orphan-reparented-to-launchd-pid1",
    "must-not-auto-spawn-replacement-after-crash",
    // RT-REC-12
    "reconciliation-must-reidentify-by-pid-plus-lstart",
    "pid-alone-not-safe-pid-reuse-remains-risk",
    "orphan-stoppable-from-new-process-via-negative-pgid",
    // signal delivery & bootstrap (RT-LAUNCH-06/07)
    "pty-master-close-delivers-sighup",
    "sighup-not-reliable-cleanup-signal",
    "child-can-detect-master-gone-via-stdout-error",
    "inert-bootstrap-must-self-timeout-not-rely-on-daemon",
    // RT-STATE-22/23
    "stopping-orphan-may-require-sigkill-escalation",
    // RT-DIST-01 / SV1-SUPPLY-02 (out-of-scope discovery, issue #22)
    "node-pty-spawn-helper-ships-non-executable",
    "daemon-install-must-verify-helper-exec-bit-and-signature",
  ],

  /**
   * 推论中属于「推断」(design invariant / 无法证伪 / 未直接观测)而非本次实测直接
   * 支持的子集。与 implications 的交集; 不得从 measuredImplications 中遗漏。
   */
  inferredImplications: [
    // 规范不变量, 由「孤儿存活」实测所推动, 但本探测未跑调度器观测替换行为。
    "must-not-auto-spawn-replacement-after-crash",
    // 无法证伪: 窗口内未复现 PID 复用, 不代表不会发生。
    "pid-alone-not-safe-pid-reuse-remains-risk",
    // 未跑 bootstrap; 由 childDetectsMasterGoneViaStdoutError 外推。
    "inert-bootstrap-must-self-timeout-not-rely-on-daemon",
    // 失败本身实测; "须校验签名/执行位" 是对 Daemon 安装的前瞻要求。
    "daemon-install-must-verify-helper-exec-bit-and-signature",
  ],
} as const;

export type DaemonCrashBehaviorProfile = typeof DAEMON_CRASH_BEHAVIOR_PROFILE;
