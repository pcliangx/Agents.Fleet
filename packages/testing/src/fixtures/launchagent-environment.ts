/**
 * R0-02 LaunchAgent 启动环境探测 — 结构化结论 fixture。
 * 证据与采集方法见 docs/probes/r0-02-launchagent-environment.md（含两份脱敏 JSON 证据）。
 * 采集: 2026-07-25, macOS 26.5.2 (25F84), Apple Silicon, gui/<uid> domain, 真实 bootstrap。
 *
 * 用途: Host Environment Module(RT-MOD-12) 与 Agent discovery(RT-ADAPTER-06) 以这些
 * 已测得事实为输入, 不假设 LaunchAgent 继承任何用户 shell 配置(ADR-0001)。
 * 字段注释区分「实测」与「推断」; 未验证的路径显式标注, 不得当作事实消费。
 */
export const LAUNCHAGENT_ENVIRONMENT_PROFILE = {
  profileId: "r0-02-launchagent-environment",
  capturedAt: "2026-07-25",
  platform: "macOS 26.5.2 (25F84), Apple Silicon",

  /** LaunchAgent 实测默认环境(未在 plist 中自定义时) */
  measuredDefaults: {
    /** 唯一 PATH; 不含 homebrew / ~/.local/bin / 任何用户 shell 定制(实测) */
    path: "/usr/bin:/bin:/usr/sbin:/sbin",
    envVarCount: 11,
    cwd: "/",
    shell: "/bin/zsh",
    homeSet: true,
    userSet: true,
    /** 均未设置(实测) — Daemon 必须自己注入 locale; TERM 对 PTY 的影响见 implications */
    langSet: false,
    termSet: false,
    /** launchd 不 source 任何 shell 初始化文件(PATH 即证据, 实测) */
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
        /** 相对 HOME 的候选路径(discovery 按用户解析) */
        homeRelativePath: ".local/bin/claude",
        /** 本 Host 实测解析到的绝对路径(单 Host 采样) */
        observedAbsolutePath: "/Users/pc2026/.local/bin/claude",
        versionProbeArgv: ["--version"],
        observed: "2.1.218 (Claude Code)",
      },
      codex: {
        homeRelativePath: ".local/bin/codex",
        observedAbsolutePath: "/Users/pc2026/.local/bin/codex",
        versionProbeArgv: ["--version"],
        observed: "codex-cli 0.145.0",
      },
    },
    /** RT-ENV-02 probe 用的清理环境最小集(实测两个 Agent 均可运行) */
    cleanedEnvMinimum: ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "LANG"],
    probePath: "/usr/bin:/bin:/usr/sbin:/sbin",
  },

  /** Keychain 只读可达性(SV1-DATA-01 / SV1-AUTH-03 的可达性前置; 写入与 ACL 未验证) */
  keychain: {
    listKeychainsWorks: true,
    loginKeychainVisible: true,
    /** 实测: 对不存在服务名的 find-generic-password 返回 exit 44 "could not be found" — 只读 API 可达 */
    genericPasswordApiReachable: true,
    /** 未验证: add-generic-password 写入 / 已存在条目 ACL 授权 / access group 共享(需签名二进制) */
    writeAndAclPathsVerified: false,
  },

  /**
   * 对 Daemon 启动环境(Environment Snapshot, RT-ENV-03)的强制推论。
   * 除标注「推断」的条目外均由本次实测直接支持。
   */
  implications: [
    "daemon-must-use-absolute-executable-paths",
    "daemon-must-not-rely-on-system-node",
    "daemon-must-set-explicit-path-for-children",
    "daemon-must-inject-lang",
    /** 推断: LaunchAgent env 无 TERM(实测), PTY 程序依赖 TERM 属合理外推, 本次未用 PTY 验证 */
    "daemon-must-inject-term-for-pty",
    "daemon-must-set-neutral-cwd-not-slash",
    "agent-discovery-must-use-explicit-candidate-paths",
    "keychain-read-api-reachable",
  ],
} as const;

export type LaunchAgentEnvironmentProfile = typeof LAUNCHAGENT_ENVIRONMENT_PROFILE;
