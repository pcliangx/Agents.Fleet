/**
 * R0-02 LaunchAgent 启动环境探测 — 结构化结论 fixture。
 * 证据与采集方法见 docs/probes/r0-02-launchagent-environment.md（含两份脱敏 JSON 证据）。
 * 采集: 2026-07-25, macOS 26.5.2 (25F84), Apple Silicon, gui/<uid> domain, 真实 bootstrap。
 *
 * 用途: Host Environment Module(RT-MOD-12) 与 Agent discovery(RT-ADAPTER-06) 以这些
 * 已测得事实为输入, 不假设 LaunchAgent 继承任何用户 shell 配置(ADR-0001)。
 */
export const LAUNCHAGENT_ENVIRONMENT_PROFILE = {
  profileId: "r0-02-launchagent-environment",
  capturedAt: "2026-07-25",
  platform: "macOS 26.5.2 (25F84), Apple Silicon",

  /** LaunchAgent 实测默认环境(未在 plist 中自定义时) */
  measuredDefaults: {
    /** 唯一 PATH; 不含 homebrew / ~/.local/bin / 任何用户 shell 定制 */
    path: "/usr/bin:/bin:/usr/sbin:/sbin",
    envVarCount: 11,
    cwd: "/",
    shell: "/bin/zsh",
    homeSet: true,
    userSet: true,
    /** 均未设置 — Daemon 必须自己注入 locale 与 TERM, 否则 PTY / 子进程收到空 locale */
    langSet: false,
    termSet: false,
    /** launchd 不 source 任何 shell 初始化文件(PATH 即证据) */
    shellInitInherited: false,
  },

  /** 关键工具在默认 PATH 上的解析结果(实测) */
  pathResolution: {
    node: null,
    claude: null,
    codex: null,
    git: "/usr/bin/git",
    security: "/usr/bin/security",
  },

  /**
   * Agent discovery 结论: PATH 解析不可用, 必须走显式候选路径;
   * 显式路径 + 清理环境 + 中立 cwd 的版本 probe(RT-ENV-02 形态)实测可用。
   */
  agentDiscovery: {
    strategy: "explicit-path",
    candidates: {
      claude: {
        path: "~/.local/bin/claude",
        versionProbeArgv: ["--version"],
        observed: "2.1.218 (Claude Code)",
      },
      codex: {
        path: "~/.local/bin/codex",
        versionProbeArgv: ["--version"],
        observed: "codex-cli 0.145.0",
      },
    },
    /** RT-ENV-02 probe 用的清理环境最小集(实测两个 Agent 均可运行) */
    cleanedEnvMinimum: ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "LANG"],
    probePath: "/usr/bin:/bin:/usr/sbin:/sbin",
  },

  /** Keychain 可达性(SV1-DATA-01 / SV1-AUTH-03 前置) */
  keychain: {
    listKeychainsWorks: true,
    loginKeychainVisible: true,
    /** 对不存在服务名的 find-generic-password 返回 exit 44 "could not be found" — API 可达且无需用户交互 */
    genericPasswordApiReachable: true,
    interactionBlocked: false,
  },

  /** 对 Daemon 启动环境(Environment Snapshot, RT-ENV-03)的强制推论 */
  implications: [
    "daemon-must-use-absolute-executable-paths",
    "daemon-must-not-rely-on-system-node",
    "daemon-must-set-explicit-path-for-children",
    "daemon-must-inject-lang-and-term",
    "daemon-must-set-neutral-cwd-not-slash",
    "agent-discovery-must-use-explicit-candidate-paths",
    "keychain-available-without-user-interaction",
  ],
} as const;

export type LaunchagentEnvironmentProfile = typeof LAUNCHAGENT_ENVIRONMENT_PROFILE;
