/**
 * R0-07 At-most-once Agent launch 协议 — 结构化结论 fixture。
 * 证据与采集方法见 docs/probes/r0-07-at-most-once-launch.md(含脱敏 JSON 证据)。
 * 采集: 2026-07-25, macOS 26.5.2 (25F84) / Darwin 25.5.0, Apple Silicon, node v26.4.0;
 * 真实 node:sqlite(WAL + synchronous=FULL) + 真实子进程(inert bootstrap / fake agent)。
 *
 * 用途: R1 Session Runtime(#9/#10 及以后)以这些已测得事实为输入实现
 * RT-LAUNCH-01..08。字段注释区分「实测(measured)」与「推断(inferred)」;
 * 推断项另列于 inferredImplications, 不得当作事实消费。
 *
 * 核心实测结论: 在 RT-T-11 要求的全部崩溃点(start / retry / resume ×
 * RT-LAUNCH-01..08 每两步之间 + RT-LAUNCH-08 两个边界, 共 30 个场景)强制
 * SIGKILL coordinator 后, 新进程 Reconciliation 均能收敛到: 恰好一个 Agent、
 * 无部分 Attempt / binding、相同 commandId 幂等返回原结果、Aborted nonce
 * 永不复活、CommitLaunch 送达未知时标 Uncertain 而非 Aborted。
 */

/** 单个崩溃点的收敛形态分类(避免用 CONTEXT.md 在 Reconciliation 条目 Avoid 的 "recovery")。 */
export type LaunchCrashConvergence =
  | "continued-same-handshake" // 无副作用, 新进程继续同一 handshake(RT-LAUNCH-05)
  | "failed-then-explicit-retry" // 干净 Aborted+Failed, 用户显式 retry 收敛
  | "resolved-running-via-probe" // 按完整进程身份探测到 Agent → finalize Running
  | "uncertain-no-replacement"; // 送达未知 → Uncertain, 不启动 replacement

export interface CrashPointResult {
  readonly crashPoint: string;
  readonly convergence: LaunchCrashConvergence;
  /** 实测: 场景结束时恰好一个 Agent 进程(Uncertain 场景为恰好零个且无 replacement)。 */
  readonly exactlyOneAgent: boolean;
  /** 实测: 无 Queued/Starting 残留、无 Planned Session 残留。 */
  readonly noPartialAttemptOrBinding: boolean;
  /** 实测: 相同 commandId 重发返回原结果(RT-CMD-02)。 */
  readonly idempotentReissue: boolean;
}

// runtime.node 是 R0-07 采集时的 host Node 快照（v26.4.0），与 project managed Node
// 24.18.0（devEngines）解耦——此 fixture 冻结历史实测环境，不随基线升级变化。
export const AT_MOST_ONCE_LAUNCH_PROFILE = {
  profileId: "r0-07-at-most-once-launch",
  capturedAt: "2026-07-25",
  platform: "macOS 26.5.2 (25F84), Darwin 25.5.0, Apple Silicon",
  runtime: { node: "v26.4.0", sqlite: "node:sqlite (WAL + synchronous=FULL)" },
  scenarioCount: 30, // 3 command kinds × (baseline + 8 crash points + delivery-unknown variant)

  /**
   * IPC 选型(实测支撑): CommitLaunch / AbortLaunch 用 write-tmp + rename 的原子文件。
   * FIFO 会把 writer 阻塞到 reader open, 信号无法携带 nonce; 原子 rename 让
   * Reconciliation 能区分「CommitLaunch 确定未发送」(文件不存在) 与「送达未知」
   * (文件存在) —— 这正是 RT-LAUNCH-08 尾部要求的分支条件。
   */
  ipcChoice: {
    mechanism: "atomic-rename-file",
    fifoWouldCoupleCrashWindow: true,
    signalCannotCarryNonce: true,
    /** 实测: rename 原子性使「commit 文件缺失 ⇒ 确定未发送」成为可靠判定。 */
    renameAtomicityDistinguishesSentFromUnknown: true,
  },

  /**
   * 崩溃点 × 收敛形态(实测, 每点均覆盖 start / retry / resume 三种命令)。
   * 崩溃方式为对真实 coordinator 子进程 SIGKILL; Reconciliation 一律在新进程执行。
   */
  crashPoints: [
    {
      crashPoint: "afterCommandTx", // RT-LAUNCH-01 cmd tx ←→ launch tx
      convergence: "continued-same-handshake",
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterLaunchTx", // intent Prepared ←→ bootstrap spawn
      convergence: "continued-same-handshake",
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterBootstrapSpawn", // bootstrap spawned ←→ authorize tx
      convergence: "failed-then-explicit-retry", // 孤儿 bootstrap 自超时 → 干净 Aborted
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterAuthorizeTx", // intent Authorized ←→ RT-CMD-16 revalidation
      convergence: "failed-then-explicit-retry", // commit 文件缺失 ⇒ 确定未发送 ⇒ Aborted 合法
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterRevalidationPass", // RT-LAUNCH-08 边界: 验证通过 ←→ CommitLaunch
      convergence: "failed-then-explicit-retry",
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterRevalidationFail", // RT-LAUNCH-08 边界: abort tx ←→ AbortLaunch
      convergence: "failed-then-explicit-retry", // AbortLaunch 未发出, bootstrap 自超时兜底
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterCommitSent", // CommitLaunch rename ←→ commit_sent_at 记录
      convergence: "resolved-running-via-probe", // 送达未知 → 探测到 Agent → finalize
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
    {
      crashPoint: "afterAgentObserved", // 观察到 Agent ←→ finalize tx
      convergence: "resolved-running-via-probe",
      exactlyOneAgent: true,
      noPartialAttemptOrBinding: true,
      idempotentReissue: true,
    },
  ] as const satisfies readonly CrashPointResult[],

  /** inert bootstrap 行为(实测, bootstrap.test.ts 直接驱动真实子进程)。 */
  bootstrap: {
    /** 实测: receipt 先于任何授权原子写入(O_EXCL), 含 {pid, pgid, lstart, argvHash}。 */
    receiptWrittenAtomicallyBeforeAuthorization: true,
    /** 实测: 第二个同 nonce bootstrap 在 O_EXCL receipt 上失败, 原 receipt 不被覆盖。 */
    duplicateNonceFailsOnExclusiveReceipt: true,
    /** 实测: Daemon 死亡(ppid→1)后未授权 bootstrap 在 grace 窗口内自超时(RT-LAUNCH-06)。 */
    selfTimeoutOnDaemonGone: true,
    /** 实测: 最多接受一次正确 nonce+argvHash 的 CommitLaunch; 错 nonce 拒绝且不 exec。 */
    acceptsAtMostOneCorrectAuthorization: true,
    /** 实测: AbortLaunch 到达即退出, 绝不 exec。 */
    abortLaunchNeverExecs: true,
  },

  /**
   * 协议不变量(实测直接支持, 30 场景全绿)。
   */
  invariants: {
    /** 实测: Aborted 是终态 — 无 commit 文件、无 agent、authorize 抛错, nonce 永不复活。 */
    abortedNonceNeverResurrected: true,
    /** 实测: commit 文件存在而 Agent 探测不到 ⇒ Attempt Uncertain 且 intent 保持 Authorized。 */
    deliveryUnknownYieldsUncertainNotAborted: true,
    /** 实测: abortTx 在 commit 可能已送达时拒绝执行(防御性不变量)。 */
    abortRefusedWhenCommitMayBeDelivered: true,
    /** 实测: Uncertain 场景不自动 retry / 不启动 replacement, slot lease 保留。 */
    noAutoReplacementForUncertain: true,
    /** 实测: 事务中途失败不留部分 Attempt / intent / lease / session(注入唯一约束冲突验证)。 */
    failedTxLeavesNoPartialState: true,
  },

  implications: [
    // RT-LAUNCH-01
    "command-and-launch-transactions-are-crash-atomic",
    // RT-LAUNCH-02
    "bootstrap-receipt-must-precede-any-authorization",
    "duplicate-nonce-bootstrap-fails-loudly",
    // RT-LAUNCH-03/04
    "commitlaunch-must-be-one-shot-and-nonce-bound",
    // RT-LAUNCH-05
    "reissued-commandid-continues-or-returns-original-result",
    "aborted-nonce-is-terminal-never-recommitted",
    // RT-LAUNCH-06
    "orphaned-bootstrap-self-times-out",
    "reconciliation-probes-by-full-process-identity",
    // RT-LAUNCH-08
    "commit-file-absence-proves-commit-never-sent",
    "delivery-unknown-forbids-aborted-use-uncertain",
    "abortlaunch-may-be-replaced-by-bootstrap-self-timeout",
    // RT-CMD-02
    "idempotent-result-survives-coordinator-crash",
  ],

  /**
   * 推断子集(非本次实测直接支持)。与 r0-03 一致的诚实标注原则:
   * 协议骨架已实测, 但以下外推需在 R1/R2 复核。
   */
  inferredImplications: [
    // 本 probe 用文件 IPC + fake agent; 真实 Agent 经 node-pty 启动(R0-09/R1)时
    // 「观察 Agent」要改由 PTY/进程事实判定, 结论方向一致但未实测。
    "reconciliation-probes-by-full-process-identity",
    // 自超时实测基于 ppid→1 检测; LaunchAgent 托管的真实 Daemon 死亡语义相同是推断。
    "orphaned-bootstrap-self-times-out",
  ],
} as const;

export type AtMostOnceLaunchProfile = typeof AT_MOST_ONCE_LAUNCH_PROFILE;
