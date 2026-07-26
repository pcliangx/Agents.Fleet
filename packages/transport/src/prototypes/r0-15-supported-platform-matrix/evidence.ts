// R0-15 — SupportedPlatformMatrix freeze evidence CLI.
// Samples this host via real sw_vers / sysctl, runs the RT-DIST-09 gate against
// the frozen matrix, verifies the frozen terminal identity against the declared
// packages/terminal dependencies, replays synthetic below-floor hosts to prove
// the rejection reasons, and writes docs/probes/r0-15/evidence.json.
//
// Usage: pnpm prototype:r0-15

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlatform,
  FROZEN_PLATFORM_MATRIX,
  type HostCommandRunner,
  type HostPlatform,
  sampleHostPlatform,
} from "@agents-fleet/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = join(ROOT, "docs", "probes", "r0-15");

const nodeRunner: HostCommandRunner = {
  runText(command, args) {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  },
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Independent source: the terminal package set as actually declared by
// packages/terminal. The frozen matrix must match this exactly.
const readDeclaredTerminalSet = (): {
  readonly identity: string;
  readonly sha256: string;
  readonly packages: ReadonlyArray<{ readonly name: string; readonly version: string }>;
} => {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "packages", "terminal", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const entries = Object.entries(pkg.dependencies)
    .filter(([name]) => name.startsWith("@xterm/"))
    .sort(([a], [b]) => a.localeCompare(b));
  const packages = entries.map(([name, version]) => ({ name, version }));
  const identity = packages.map((p) => `${p.name}@${p.version}`).join(",");
  return { identity, sha256: createHash("sha256").update(identity).digest("hex"), packages };
};

// Synthetic below-floor hosts — each must be rejected with a distinct reason.
const rejectionCases: ReadonlyArray<{ readonly label: string; readonly host: HostPlatform }> = [
  {
    label: "Intel x64",
    host: {
      architecture: "x64",
      osPlatform: "darwin",
      macosProductVersion: "26.5.2",
      cpuBrand: "Apple M5 Pro",
      machineModel: "Mac17,8",
      memoryBytes: 51539607552,
    },
  },
  {
    label: "macOS 15 (below floor 26)",
    host: {
      architecture: "arm64",
      osPlatform: "darwin",
      macosProductVersion: "15.7",
      cpuBrand: "Apple M1",
      machineModel: "MacBookAir10,1",
      memoryBytes: 8589934592,
    },
  },
  {
    label: "4 GiB memory (below 8 GiB)",
    host: {
      architecture: "arm64",
      osPlatform: "darwin",
      macosProductVersion: "26.0",
      cpuBrand: "Apple M1",
      machineModel: "MacBookAir10,1",
      memoryBytes: 4294967296,
    },
  },
  {
    label: "non-Apple arm64 cpu",
    host: {
      architecture: "arm64",
      osPlatform: "darwin",
      macosProductVersion: "26.0",
      cpuBrand: "Qualcomm Oryon CPU",
      machineModel: "unknown",
      memoryBytes: 8589934592,
    },
  },
  {
    label: "non-darwin OS",
    host: {
      architecture: "arm64",
      osPlatform: "linux",
      macosProductVersion: null,
      cpuBrand: null,
      machineModel: null,
      memoryBytes: null,
    },
  },
];

const main = (): void => {
  const host = sampleHostPlatform(nodeRunner, process.arch, process.platform);
  const verdict = checkPlatform(host, FROZEN_PLATFORM_MATRIX);
  const declared = readDeclaredTerminalSet();

  const evidence = {
    probeId: "r0-15-supported-platform-matrix",
    capturedAt: new Date().toISOString(),
    baseCommit: git("rev-parse", "HEAD"),
    frozenMatrix: FROZEN_PLATFORM_MATRIX,
    terminalPackageSet: {
      declaredBy: "packages/terminal/package.json",
      identity: declared.identity,
      sha256: declared.sha256,
      matchesFrozenMatrix: declared.identity === FROZEN_PLATFORM_MATRIX.terminalPackageSetIdentity,
      packages: declared.packages,
    },
    hostSample: host,
    gateVerdict: verdict,
    rejectionCases: rejectionCases.map((c) => ({
      label: c.label,
      host: c.host,
      result: checkPlatform(c.host, FROZEN_PLATFORM_MATRIX),
    })),
    pendingFields: {
      runtimeLimitProfileVersion: {
        value: FROZEN_PLATFORM_MATRIX.runtimeLimitProfileVersion,
        owner: "R0-16 (issue #15)",
        bumpEffect: "freezing it produces a new matrixVersion per RT-DIST-08",
      },
      signingAndNotarizationPolicyVersion: {
        value: FROZEN_PLATFORM_MATRIX.signingAndNotarizationPolicyVersion,
        owner: "R5 distribution",
      },
    },
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const out = join(EVIDENCE_DIR, "evidence.json");
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  console.log(`R0-15 SupportedPlatformMatrix v${FROZEN_PLATFORM_MATRIX.matrixVersion}`);
  console.log(
    `host: ${host.cpuBrand} / macOS ${host.macosProductVersion} / ${host.machineModel} / ${host.memoryBytes} bytes / ${host.architecture}`,
  );
  console.log(`gate: ${verdict.ok ? "PASS" : `FAIL (${verdict.reason}: ${verdict.detail})`}`);
  console.log(
    `terminal identity matches declared deps: ${evidence.terminalPackageSet.matchesFrozenMatrix}`,
  );
  console.log(`terminal sha256: ${declared.sha256}`);
  console.log(`wrote ${out}`);

  if (!verdict.ok || !evidence.terminalPackageSet.matchesFrozenMatrix) {
    process.exitCode = 1;
  }
};

main();
