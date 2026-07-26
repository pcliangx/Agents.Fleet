// RT-DIST-09 — SupportedPlatformMatrix host gate.
//
// Pure platform check: given a sampled host and a frozen matrix, decide whether
// the host belongs to the matrix. The installer / LaunchAgent / migration paths
// (RT-DIST-09) call this before any write; a non-matching host returns a typed
// reason that the integration layer surfaces as the `UnsupportedPlatform` error
// code (protocol/error.ts). This module stays pure and Node-free: `process` /
// `child_process` live in the Node-capable caller that supplies the runner.

import type { SupportedPlatformMatrix } from "./platform.js";

export interface HostPlatform {
  /** `process.arch` ("arm64", "x64", ...). */
  readonly architecture: string;
  /** `process.platform` ("darwin", "linux", ...). */
  readonly osPlatform: string;
  /** `sw_vers -productVersion` ("26.5.2") or null off macOS. */
  readonly macosProductVersion: string | null;
  /** `sysctl -n machdep.cpu.brand_string` ("Apple M5 Pro") or null. */
  readonly cpuBrand: string | null;
  /** `sysctl -n hw.model` ("Mac17,8") or null. */
  readonly machineModel: string | null;
  /** `sysctl -n hw.memsize` in bytes, or null. */
  readonly memoryBytes: number | null;
}

export type UnsupportedPlatformReason =
  | "architecture"
  | "operatingSystem"
  | "macOSVersion"
  | "cpuClass"
  | "memory";

export type PlatformCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: UnsupportedPlatformReason;
      readonly detail: string;
    };

interface VersionTriple {
  readonly major: number;
  readonly minor: number;
}

function parseVersion(raw: string): VersionTriple | null {
  const parts = raw.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(major)) return null;
  return { major, minor: Number.isNaN(minor) ? 0 : minor };
}

/** Apple Silicon generation from a cpu brand string ("Apple M5 Pro" → 5). */
export function appleSiliconGeneration(cpuBrand: string | null): number | null {
  if (!cpuBrand) return null;
  const match = cpuBrand.match(/^(?:Apple\s+)?M(\d+)/i);
  const gen = match ? Number.parseInt(match[1] ?? "", 10) : NaN;
  return Number.isNaN(gen) ? null : gen;
}

function atLeastFloor(host: VersionTriple, floor: VersionTriple): boolean {
  return host.major > floor.major || (host.major === floor.major && host.minor >= floor.minor);
}

export function checkPlatform(
  host: HostPlatform,
  matrix: SupportedPlatformMatrix,
): PlatformCheckResult {
  if (host.architecture !== matrix.architecture) {
    return {
      ok: false,
      reason: "architecture",
      detail: `architecture ${host.architecture} ≠ matrix ${matrix.architecture}`,
    };
  }

  if (host.osPlatform !== "darwin" || host.macosProductVersion === null) {
    return {
      ok: false,
      reason: "operatingSystem",
      detail: `operating system ${host.osPlatform} is not macOS`,
    };
  }

  const floorVersion = parseVersion(matrix.minimumMacOSVersion);
  const hostVersion = parseVersion(host.macosProductVersion);
  if (!floorVersion || !hostVersion || !atLeastFloor(hostVersion, floorVersion)) {
    return {
      ok: false,
      reason: "macOSVersion",
      detail: `macOS ${host.macosProductVersion} < minimum ${matrix.minimumMacOSVersion}`,
    };
  }

  const floorGen = appleSiliconGeneration(matrix.minimumHardware.cpuClass);
  const hostGen = appleSiliconGeneration(host.cpuBrand);
  if (floorGen === null || hostGen === null || hostGen < floorGen) {
    return {
      ok: false,
      reason: "cpuClass",
      detail: `cpu "${host.cpuBrand ?? "?"}" is below minimum ${matrix.minimumHardware.cpuClass}`,
    };
  }

  if (host.memoryBytes === null || host.memoryBytes < matrix.minimumHardware.memoryBytes) {
    return {
      ok: false,
      reason: "memory",
      detail: `memory ${host.memoryBytes ?? "?"} bytes < minimum ${matrix.minimumHardware.memoryBytes}`,
    };
  }

  return { ok: true };
}

/** Runs a host probe command and returns trimmed stdout. Throws on failure. */
export interface HostCommandRunner {
  runText(command: string, args: readonly string[]): string;
}

function tryRun(
  runner: HostCommandRunner,
  command: string,
  args: readonly string[],
): string | null {
  try {
    const out = runner.runText(command, args).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * Sample the running host. macOS fields are probed via sw_vers / sysctl and are
 * null off darwin; the gate decides support. Pure given `runner` — the Node
 * caller supplies `process.arch` / `process.platform` and a real runner, so this
 * module imports no Node builtins.
 */
export function sampleHostPlatform(
  runner: HostCommandRunner,
  arch: string,
  osPlatform: string,
): HostPlatform {
  const base = { architecture: arch, osPlatform };
  if (osPlatform !== "darwin") {
    return {
      ...base,
      macosProductVersion: null,
      cpuBrand: null,
      machineModel: null,
      memoryBytes: null,
    };
  }

  const macosProductVersion = tryRun(runner, "sw_vers", ["-productVersion"]);
  const cpuBrand = tryRun(runner, "sysctl", ["-n", "machdep.cpu.brand_string"]);
  const machineModel = tryRun(runner, "sysctl", ["-n", "hw.model"]);
  const memRaw = tryRun(runner, "sysctl", ["-n", "hw.memsize"]);
  const parsed = memRaw === null ? NaN : Number.parseInt(memRaw, 10);
  const memoryBytes = Number.isNaN(parsed) ? null : parsed;

  return { ...base, macosProductVersion, cpuBrand, machineModel, memoryBytes };
}
