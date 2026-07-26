import { describe, expect, it } from "vitest";
import { FROZEN_PLATFORM_MATRIX, PLATFORM_MATRIX_VERSION } from "../frozen-platform-matrix.js";
import { checkPlatform } from "../platform-gate.js";

describe("RT-DIST-08 frozen SupportedPlatformMatrix v2", () => {
  it("matrixVersion is 2 and the constant agrees (bumped by R0-16 profile freeze)", () => {
    expect(FROZEN_PLATFORM_MATRIX.matrixVersion).toBe(2);
    expect(PLATFORM_MATRIX_VERSION).toBe(2);
  });

  it("freezes Apple Silicon / Tahoe / WebGL2+DOM per PLATFORM-1", () => {
    expect(FROZEN_PLATFORM_MATRIX.architecture).toBe("arm64");
    expect(FROZEN_PLATFORM_MATRIX.minimumMacOSVersion).toBe("26");
    expect(FROZEN_PLATFORM_MATRIX.rendererPaths).toEqual(["WebGL2", "DOM"]);
  });

  it("minimumHardware is M1 / 8 GiB (lowest Apple Silicon)", () => {
    expect(FROZEN_PLATFORM_MATRIX.minimumHardware).toEqual({
      machineModel: "MacBookAir10,1",
      cpuClass: "M1",
      gpuClass: "apple-integrated",
      memoryBytes: 8589934592,
    });
  });

  it("terminalPackageSetIdentity pins the R0-09 5-package set", () => {
    expect(FROZEN_PLATFORM_MATRIX.terminalPackageSetIdentity).toBe(
      "@xterm/addon-serialize@0.14.0,@xterm/addon-unicode11@0.9.0,@xterm/addon-webgl@0.19.0,@xterm/headless@6.0.0,@xterm/xterm@6.0.0",
    );
  });

  it("pins runtime identities proven by R0-10", () => {
    expect(FROZEN_PLATFORM_MATRIX.electronVersion).toBe("34.5.8");
    expect(FROZEN_PLATFORM_MATRIX.nodeRuntimeVersion).toBe("22.17.1");
    expect(FROZEN_PLATFORM_MATRIX.nodePtyArtifactIdentity).toBe("node-pty@1.1.0;darwin-arm64");
  });

  it("a host at the matrix's own declared floor passes the gate (round-trip)", () => {
    const m = FROZEN_PLATFORM_MATRIX;
    const atFloor = {
      architecture: m.architecture,
      osPlatform: "darwin",
      macosProductVersion: m.minimumMacOSVersion,
      cpuBrand: `Apple ${m.minimumHardware.cpuClass}`,
      machineModel: m.minimumHardware.machineModel,
      memoryBytes: m.minimumHardware.memoryBytes,
    };
    expect(checkPlatform(atFloor, m)).toEqual({ ok: true });
  });

  it("records the frozen limit profile; not-yet-frozen policy fields stay explicitly 0", () => {
    expect(FROZEN_PLATFORM_MATRIX.runtimeLimitProfileVersion).toBe(1);
    expect(FROZEN_PLATFORM_MATRIX.signingAndNotarizationPolicyVersion).toBe(0);
    expect(FROZEN_PLATFORM_MATRIX.keychainPolicyVersion).toBe(1);
  });
});
