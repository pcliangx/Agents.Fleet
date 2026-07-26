// R0-22 — node-pty spawn-helper exec-bit + signature verifier evidence CLI.
//
// Samples the installed spawn-helper (shipped 0644 → posix_spawnp fails because
// npm 11 allow-scripts blocks its lifecycle chmod, issue #22), runs the verifier,
// reproduces the pre-repair spawn failure on a copy, proves the chmod 0755 repair
// enables a real pty.spawn, and records the SV1-SUPPLY-02 downstream patch. The
// installed package and pnpm store are never mutated; the repair proof uses a
// temporary copy (as in r0-10).
//
// Usage: pnpm prototype:r0-22

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProbeDeps, sampleSpawnHelper } from "../../native-artifact/spawn-helper-sampler.js";
import {
  repairSpawnHelper,
  type SpawnHelperExpected,
  verifySpawnHelper,
} from "../../native-artifact/spawn-helper-verifier.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = join(ROOT, "docs", "probes", "r0-22");

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

interface NativePtyProcess {
  readonly pid: number;
  onData(listener: (data: unknown) => void): { dispose(): void };
  onExit(listener: () => void): { dispose(): void };
  kill(): void;
}
interface NativePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly cols: number;
      readonly rows: number;
      readonly encoding: null;
    },
  ): NativePtyProcess;
}

const HELPER_SHA = "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26";

/** Spawn on a copied node-pty whose helper has the given mode; returns output or the thrown error. */
const trySpawnOnCopy = async (
  helperMode: 0o444 | 0o755,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> => {
  const requireFromMain = createRequire(import.meta.url);
  const installedRoot = dirname(requireFromMain.resolve("node-pty/package.json"));
  const tempRoot = await mkdtemp(join(tmpdir(), "af-r022-spawn-helper-"));
  const copiedRoot = join(tempRoot, "node-pty");
  try {
    await cp(installedRoot, copiedRoot, { recursive: true });
    await chmod(
      join(copiedRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      helperMode,
    );
    const requireFromCopy = createRequire(join(copiedRoot, "package.json"));
    const nodePty = requireFromCopy(copiedRoot) as NativePtyModule;
    try {
      const proc = nodePty.spawn("/bin/sh", ["-c", "echo spawn-ok"], {
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin" },
        cols: 80,
        rows: 24,
        encoding: null,
      });
      const chunks: Buffer[] = [];
      const onData = (data: unknown): void => {
        chunks.push(Buffer.from(data as Uint8Array));
      };
      const onExit = (): void => undefined;
      const disp = proc.onData(onData);
      proc.onExit(onExit);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 3_000);
        const exitDisp = proc.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
        exitDisp.dispose();
      });
      disp.dispose();
      return { ok: true, output: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) };
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const requireFromMain = createRequire(import.meta.url);
  const installedRoot = dirname(requireFromMain.resolve("node-pty/package.json"));
  const helperPath = join(
    installedRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );

  const observed = sampleSpawnHelper(helperPath, defaultProbeDeps);
  const expected: SpawnHelperExpected = {
    architecture: "arm64",
    minimumSignature: "adhoc", // dev acceptance; release needs developer-id (SV1-SUPPLY-03)
    sha256: null, // release-manifest pin is R5 (RT-DIST-01)
  };
  const verdict = verifySpawnHelper(observed, expected);
  const repair = repairSpawnHelper(verdict);

  // Reproduce #22 then prove the owned repair — both on disposable copies.
  const preRepair = await trySpawnOnCopy(0o444);
  const postRepair = await trySpawnOnCopy(0o755);

  const evidence = {
    probeId: "r0-22-spawn-helper-exec-bit",
    capturedAt: new Date().toISOString(),
    baseCommit: git("rev-parse", "HEAD"),
    issue: 22,
    contracts: ["RT-DIST-01", "SV1-SUPPLY-02", "SV1-SUPPLY-03", "RT-DIST-08"],
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      hostNode: process.version,
      nodePty: "1.1.0",
    },
    installedHelper: {
      path: helperPath,
      ...observed,
      mode: observed.mode === null ? null : `0o${observed.mode.toString(8)}`,
    },
    verdict,
    repair,
    reproduction: {
      preRepairSpawn: {
        copiedHelperMode: "0o444",
        attempted: true,
        failed: !preRepair.ok,
        error: preRepair.ok ? null : preRepair.error,
      },
      postRepairSpawnOnTempCopy: {
        copiedHelperMode: "0o755",
        passed: postRepair.ok && postRepair.output.includes("spawn-ok"),
        output: postRepair.ok ? postRepair.output : null,
        sourcePackageMutated: false,
        temporaryCopyRemoved: true,
      },
    },
    downstreamPatch: {
      owner: "Agents.Fleet daemon install/upgrade (RT-DIST-01)",
      source: "node-pty@1.1.0 prebuild (darwin-arm64)",
      patch: "chmod 0755 prebuilds/darwin-arm64/spawn-helper",
      hash: HELPER_SHA,
      regressionFixture:
        "packages/daemon/src/__tests__/spawn-helper-verifier.test.ts + this prototype",
      deletionCondition:
        "when node-pty ships spawn-helper with +x in the prebuild, or the release bundle embeds a developer-id-signed + notarized spawn-helper (SV1-SUPPLY-03 / RT-DIST-01)",
      doesNotRelyOnNpmLifecycle: true,
    },
    releaseGaps: [
      "developer-id signing + notarization (SV1-SUPPLY-03) — adhoc only today",
      "release-manifest hash pin (RT-DIST-01) — sha256 recorded but not pinned",
      "installer / LaunchAgent / migration integration of verify+repair (R5)",
    ],
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const out = join(EVIDENCE_DIR, "evidence.json");
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  console.log(`R0-22 spawn-helper verifier (issue #22)`);
  console.log(
    `installed helper: mode ${evidence.installedHelper.mode} / ${observed.architecture} / ${observed.signatureKind} / sha ${observed.sha256?.slice(0, 12)}…`,
  );
  console.log(`verdict: ready=${verdict.ready} problems=[${verdict.problems.join(",")}]`);
  console.log(`repair: permitted=${repair.permitted}`);
  console.log(
    `pre-repair spawn (0o444 copy): ${preRepair.ok ? "unexpectedly succeeded" : `failed → ${preRepair.error}`}`,
  );
  console.log(
    `post-repair spawn (0o755 copy): ${postRepair.ok && postRepair.output.includes("spawn-ok") ? "PASS" : "FAIL"}`,
  );
  console.log(`wrote ${out}`);

  // Success = the expected #22 demonstration, NOT helper-ready (the installed
  // helper is deliberately not ready — that is the bug). Fail only if the
  // diagnosis, repair permission, failure reproduction, or repair proof is wrong.
  const expectedDiagnosis =
    !verdict.ready &&
    verdict.problems.length === 1 &&
    verdict.problems[0] === "missingExecutableBit";
  const spawnProofOk = postRepair.ok && postRepair.output.includes("spawn-ok");
  const preRepairFailed = !preRepair.ok;
  if (!expectedDiagnosis || !repair.permitted || !preRepairFailed || !spawnProofOk) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
