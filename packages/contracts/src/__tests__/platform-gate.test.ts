import { describe, expect, it } from "vitest";
import type { SupportedPlatformMatrix } from "../platform.js";
import {
  appleSiliconGeneration,
  checkPlatform,
  type HostCommandRunner,
  type HostPlatform,
  sampleHostPlatform,
} from "../platform-gate.js";

// Independent floor spec used only to drive the gate (the canonical frozen
// values live in frozen-platform-matrix.ts and are asserted separately).
const FLOOR: SupportedPlatformMatrix = {
  matrixVersion: 1,
  architecture: "arm64",
  minimumMacOSVersion: "26",
  minimumHardware: {
    machineModel: "MacBookAir10,1",
    cpuClass: "M1",
    gpuClass: "apple-integrated",
    memoryBytes: 8589934592,
  },
  electronVersion: "43.2.0",
  nodeRuntimeVersion: "22.17.1",
  nodePtyArtifactIdentity: "node-pty@1.1.0;darwin-arm64",
  terminalPackageSetIdentity: "test",
  runtimeLimitProfileVersion: 0,
  rendererPaths: ["WebGL2", "DOM"],
  keychainPolicyVersion: 1,
  signingAndNotarizationPolicyVersion: 0,
  evidenceRefs: [],
};

function host(over: Partial<HostPlatform> = {}): HostPlatform {
  return {
    architecture: "arm64",
    osPlatform: "darwin",
    macosProductVersion: "26.0",
    cpuBrand: "Apple M1",
    machineModel: "MacBookAir10,1",
    memoryBytes: 8589934592,
    ...over,
  };
}

describe("RT-DIST-09 checkPlatform", () => {
  it("accepts a host at the frozen floor (M1, 8 GiB, macOS 26.0)", () => {
    expect(checkPlatform(host(), FLOOR)).toEqual({ ok: true });
  });

  it("accepts a host above the floor (M5 Pro, 48 GiB, macOS 26.5.2)", () => {
    expect(
      checkPlatform(
        host({
          macosProductVersion: "26.5.2",
          cpuBrand: "Apple M5 Pro",
          machineModel: "Mac17,8",
          memoryBytes: 51539607552,
        }),
        FLOOR,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    { over: { architecture: "x64" }, reason: "architecture" },
    { over: { osPlatform: "linux", macosProductVersion: null }, reason: "operatingSystem" },
    { over: { macosProductVersion: "15.7" }, reason: "macOSVersion" },
    { over: { macosProductVersion: "25.1" }, reason: "macOSVersion" },
    { over: { cpuBrand: "Qualcomm Oryon CPU" }, reason: "cpuClass" },
    { over: { memoryBytes: 4294967296 }, reason: "memory" },
  ] as const)("rejects $reason when host is below floor", ({ over, reason }) => {
    const result = checkPlatform(host(over as Partial<HostPlatform>), FLOOR);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(reason);
  });
});

describe("appleSiliconGeneration", () => {
  it.each([
    ["Apple M1", 1],
    ["Apple M1 Pro", 1],
    ["Apple M5 Pro", 5],
    ["M1", 1],
    ["M2", 2],
  ] as const)("parses %s → generation %i", (brand, gen) => {
    expect(appleSiliconGeneration(brand)).toBe(gen);
  });

  it.each([["Intel Core i7"], ["Qualcomm Oryon"], [null]])("returns null for %s", (brand) => {
    expect(appleSiliconGeneration(brand)).toBeNull();
  });
});

// Real captured outputs from the M5 Pro / macOS 26.5.2 sampling host.
const sampledRunner: HostCommandRunner = {
  runText(cmd, args) {
    const key = `${cmd} ${args.join(" ")}`;
    switch (key) {
      case "sw_vers -productVersion":
        return "26.5.2";
      case "sysctl -n machdep.cpu.brand_string":
        return "Apple M5 Pro";
      case "sysctl -n hw.model":
        return "Mac17,8";
      case "sysctl -n hw.memsize":
        return "51539607552";
      default:
        throw new Error(`unexpected probe: ${key}`);
    }
  },
};

describe("RT-DIST-09 sampleHostPlatform", () => {
  it("parses real sw_vers / sysctl output on darwin/arm64", () => {
    expect(sampleHostPlatform(sampledRunner, "arm64", "darwin")).toEqual({
      architecture: "arm64",
      osPlatform: "darwin",
      macosProductVersion: "26.5.2",
      cpuBrand: "Apple M5 Pro",
      machineModel: "Mac17,8",
      memoryBytes: 51539607552,
    });
  });

  it("returns null macOS fields off darwin", () => {
    expect(sampleHostPlatform(sampledRunner, "x64", "linux")).toEqual({
      architecture: "x64",
      osPlatform: "linux",
      macosProductVersion: null,
      cpuBrand: null,
      machineModel: null,
      memoryBytes: null,
    });
  });

  it("sampled host passes the frozen-floor gate", () => {
    expect(checkPlatform(sampleHostPlatform(sampledRunner, "arm64", "darwin"), FLOOR)).toEqual({
      ok: true,
    });
  });
});
