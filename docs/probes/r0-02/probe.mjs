// R0-02 LaunchAgent 启动环境探测
// 用法: node probe.mjs <sanitized-out.json> [raw-out.json]
// 采集: env(脱敏) / PATH 解析 / 显式路径版本 probe(清理环境,RT-ENV-02 形态) / Keychain 可达性 / session 上下文
// 脱敏: 命中 DENYLIST 的变量值不写入任何仓库文件; raw 输出只可指向 $TMPDIR 等仓库外路径。
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [sanitizedOut, rawOut] = process.argv.slice(2);
if (!sanitizedOut) {
  console.error("usage: node probe.mjs <sanitized-out.json> [raw-out.json]");
  process.exit(2);
}

const DENYLIST = /TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE|CREDENTIAL|COOKIE|SESSION|AUTH(?!_SOCK)/i;

function sanitizeEnv(env) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    out[k] = DENYLIST.test(k) ? "<redacted>" : env[k];
  }
  return out;
}

function resolveOnPath(exe, pathValue) {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const p = join(dir, exe);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function run(argv, options = {}) {
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return { ok: true, argv, stdout: stdout.trim().slice(0, 500) };
  } catch (e) {
    return {
      ok: false,
      argv,
      status: e.status ?? null,
      signal: e.signal ?? null,
      stderr: String(e.stderr ?? "").trim().slice(0, 500),
      message: e.message?.slice(0, 200),
    };
  }
}

// RT-ENV-02 形态: 中立 cwd + 清理后环境 + 显式 executable path, 不经 login shell
const cleanedEnv = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  TMPDIR: process.env.TMPDIR,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
};
const neutralCwd = process.env.TMPDIR ?? "/tmp";

const home = process.env.HOME ?? "";
const explicitCandidates = {
  claude: `${home}/.local/bin/claude`,
  codex: `${home}/.local/bin/codex`,
  nodeSystem: "/usr/bin/node",
  nodeHomebrew: "/opt/homebrew/bin/node",
};

const versionProbes = {};
for (const [name, p] of Object.entries(explicitCandidates)) {
  let exists = false;
  let real = null;
  try {
    accessSync(p, constants.X_OK);
    exists = true;
    real = realpathSync(p);
  } catch {}
  versionProbes[name] = {
    path: p,
    exists,
    realpath: real,
    versionProbe: exists ? run([p, "--version"], { env: cleanedEnv, cwd: neutralCwd }) : null,
  };
}

const keychain = {
  listKeychains: run(["/usr/bin/security", "list-keychains"]),
  defaultKeychain: run(["/usr/bin/security", "default-keychain"]),
  // 只探测不存在的服务名: 证明 API 可达且不触碰任何真实 secret
  findNonexistent: run([
    "/usr/bin/security",
    "find-generic-password",
    "-s",
    "agents-fleet.r0-02.probe.nonexistent",
  ]),
};

const report = {
  probeId: "r0-02-launchagent-environment",
  capturedAt: new Date().toISOString(),
  context: {
    node: process.version,
    execPath: process.execPath,
    cwd: process.cwd(),
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    ppid: process.ppid,
    managerName: run(["/bin/launchctl", "managername"]),
    swVers: run(["/usr/bin/sw_vers"]).stdout ?? null,
  },
  env: process.env,
  pathResolution: Object.fromEntries(
    ["node", "claude", "codex", "git", "security"].map((exe) => [
      exe,
      resolveOnPath(exe, process.env.PATH),
    ]),
  ),
  explicitVersionProbes: versionProbes,
  cleanedEnvUsed: cleanedEnv,
  keychain,
};

const sanitized = { ...report, env: sanitizeEnv(process.env) };
mkdirSync(dirname(sanitizedOut), { recursive: true });
writeFileSync(sanitizedOut, `${JSON.stringify(sanitized, null, 2)}\n`);
if (rawOut) {
  if (!rawOut.startsWith("/tmp") && !rawOut.startsWith(process.env.TMPDIR ?? "/tmp")) {
    console.error("raw output must live outside the repo (e.g. $TMPDIR); refusing");
    process.exit(2);
  }
  writeFileSync(rawOut, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`sanitized -> ${sanitizedOut}`);
if (rawOut) console.log(`raw       -> ${rawOut}`);
