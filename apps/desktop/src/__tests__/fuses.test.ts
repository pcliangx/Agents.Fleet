import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FUSE_SENTINEL,
  flipFuseWire,
  frameworkBinaryPath,
  parseFuseWire,
  REQUIRED_RELEASE_FUSES,
  verifyReleaseFuses,
} from "../main/fuses.js";

// SV1-ELECTRON-05 / SV1-T-16 / SV1-T-21 — the release fuse posture is
// verified from the binary itself, a wrong-fuse image fails closed, and the
// flipped-fuse fixture proves the fuses actually gate the behaviors.

const itMacArm64 = process.platform === "darwin" && process.arch === "arm64" ? it : it.skip;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const syntheticWire = (flags: string): Buffer =>
  Buffer.concat([
    Buffer.from("prefix-bytes"),
    Buffer.from(FUSE_SENTINEL, "utf8"),
    Buffer.from([0x01, flags.length]),
    Buffer.from(flags, "utf8"),
    Buffer.from("suffix"),
  ]);

describe("fuse wire parsing", () => {
  it("parses a synthetic fuse wire", () => {
    const parsed = parseFuseWire(syntheticWire("01010101"));
    expect(parsed?.version).toBe(1);
    expect(parsed?.fuses).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: true,
      EnableEmbeddedAsarIntegrityValidation: false,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: true,
    });
  });

  it("fails closed on a binary without a parseable fuse wire", () => {
    const report = verifyReleaseFuses(Buffer.from("no sentinel here"));
    expect(report).toMatchObject({
      parseable: false,
      compliant: false,
      violations: ["fuse wire not found or unparseable"],
    });
  });

  it("accepts exactly the required release posture and rejects any deviation", () => {
    const releaseFlags = REQUIRED_RELEASE_FUSES;
    const flags = Object.values(releaseFlags)
      .map((on) => (on ? "1" : "0"))
      .join("");
    expect(verifyReleaseFuses(syntheticWire(flags)).compliant).toBe(true);
    // One flipped flag (RunAsNode on) must fail closed.
    const wrong = flipFuseWire(syntheticWire(flags), { RunAsNode: true });
    const report = verifyReleaseFuses(wrong);
    expect(report.compliant).toBe(false);
    expect(report.violations).toEqual(["RunAsNode: required off, found on"]);
  });
});

describe("release fuse posture on real binaries", () => {
  const electronBinary = (): string => {
    const requireFromDesktop = createRequire(
      join(REPOSITORY_ROOT, "apps", "desktop", "package.json"),
    );
    return requireFromDesktop("electron") as string;
  };

  itMacArm64(
    "reports the dev Electron binary as non-compliant (RunAsNode and friends on)",
    async () => {
      // This is the expected *development* posture: the shipped Electron
      // Framework binary carries default fuses (wire "10110001"). Release
      // verification must refuse to boot from this image.
      const framework = await readFile(frameworkBinaryPath(electronBinary()));
      const report = verifyReleaseFuses(framework);
      expect(report.parseable).toBe(true);
      expect(report.fuses).toMatchObject({
        RunAsNode: true,
        EnableNodeOptionsEnvironmentVariable: true,
        EnableNodeCliInspectArguments: true,
        EnableEmbeddedAsarIntegrityValidation: false,
        OnlyLoadAppFromAsar: false,
        GrantFileProtocolExtraPrivileges: true,
      });
      expect(report.compliant).toBe(false);
      expect(report.violations).toContain("RunAsNode: required off, found on");
      expect(report.violations).toContain(
        "EnableNodeOptionsEnvironmentVariable: required off, found on",
      );
    },
  );

  itMacArm64(
    "fuses gate real behavior: dev binary injects, flipped-fuse clone fails closed",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "af-r011-fuses-"));
      const run = (
        binary: string,
        args: string[],
        extraEnv: Record<string, string>,
        waitMs = 30_000,
      ): Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }> =>
        new Promise((resolveRun, reject) => {
          const child = spawn(binary, args, {
            env: {
              HOME: process.env.HOME ?? "/tmp",
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              TMPDIR: process.env.TMPDIR ?? "/tmp",
              ...extraEnv,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
          child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf8");
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
          }, waitMs).unref();
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("exit", (code, signal) => {
            clearTimeout(timer);
            resolveRun({ code, stdout, stderr, timedOut: signal === "SIGKILL" });
          });
        });

      try {
        const devBinary = electronBinary();

        // --- Control 1: unfused dev binary honors ELECTRON_RUN_AS_NODE.
        const runAsNode = await run(devBinary, ["-p", "40+2"], {
          ELECTRON_RUN_AS_NODE: "1",
        });
        expect(runAsNode.stdout.trim()).toBe("42");

        // --- Control 2: unfused dev binary honors NODE_OPTIONS injection
        // into the Main process of an arbitrary app.
        const dummyApp = join(fixtureRoot, "dummy-app");
        await mkdir(dummyApp, { recursive: true });
        await writeFile(
          join(dummyApp, "package.json"),
          JSON.stringify({ name: "af-fuse-dummy", version: "0.0.0", main: "main.cjs" }),
        );
        await writeFile(
          join(dummyApp, "main.cjs"),
          `require("electron").app.whenReady().then(() => require("electron").app.exit(0));`,
        );
        const markerModule = join(fixtureRoot, "marker.cjs");
        await writeFile(
          markerModule,
          `require("node:fs").writeFileSync(process.env.AF_MARKER_PATH, "injected");`,
        );
        const devMarker = join(fixtureRoot, "dev-marker.txt");
        const injection = await run(devBinary, [dummyApp], {
          NODE_OPTIONS: `--require ${markerModule}`,
          AF_MARKER_PATH: devMarker,
        });
        expect(injection.code).toBe(0);
        expect(existsSync(devMarker)).toBe(true);

        // --- Clone the app, flip the injection fuses off, re-sign ad-hoc
        // (arm64 requires a valid signature; the clone lives in tmp only).
        const clonedApp = join(fixtureRoot, "Electron.app");
        await cp(join(devBinary, "..", "..", ".."), clonedApp, {
          recursive: true,
          verbatimSymlinks: true,
        });
        const cloneBinary = join(clonedApp, "Contents", "MacOS", "Electron");
        const cloneFrameworkPath = join(
          clonedApp,
          "Contents",
          "Frameworks",
          "Electron Framework.framework",
          "Versions",
          "Current",
          "Electron Framework",
        );
        const framework = await readFile(cloneFrameworkPath);
        const flipped = flipFuseWire(framework, {
          RunAsNode: false,
          EnableNodeOptionsEnvironmentVariable: false,
          EnableNodeCliInspectArguments: false,
        });
        await writeFile(cloneFrameworkPath, flipped);
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", cloneFrameworkPath]);

        // --- Flipped: ELECTRON_RUN_AS_NODE is ignored (fail closed). The
        // clone either errors out or idles at the "no app" dialog — either
        // way it never evaluates the payload.
        const fusedRunAsNode = await run(
          cloneBinary,
          ["-p", "40+2"],
          {
            ELECTRON_RUN_AS_NODE: "1",
          },
          8_000,
        );
        expect(fusedRunAsNode.stdout.trim()).not.toBe("42");
        expect(fusedRunAsNode.code).not.toBe(0);

        // --- Flipped: NODE_OPTIONS --require is ignored (fail closed),
        // while the app itself still boots normally.
        const fusedMarker = join(fixtureRoot, "fused-marker.txt");
        const fusedInjection = await run(cloneBinary, [dummyApp], {
          NODE_OPTIONS: `--require ${markerModule}`,
          AF_MARKER_PATH: fusedMarker,
        });
        expect(fusedInjection.code).toBe(0);
        expect(existsSync(fusedMarker)).toBe(false);

        // --- The wire-level report reflects the flip (still not a full
        // release posture: OnlyLoadAppFromAsar etc. remain off).
        const flippedReport = verifyReleaseFuses(await readFile(cloneFrameworkPath));
        expect(flippedReport.fuses).toMatchObject({
          RunAsNode: false,
          EnableNodeOptionsEnvironmentVariable: false,
          EnableNodeCliInspectArguments: false,
        });
        expect(flippedReport.compliant).toBe(false);
        expect(flippedReport.violations).not.toContain("RunAsNode: required off, found on");
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
