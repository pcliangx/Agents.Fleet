import { describe, expect, it } from "vitest";
import {
  parseArchitecture,
  parseDeploymentTarget,
  parseSignatureKind,
  type SpawnHelperProbeDeps,
  sampleSpawnHelper,
} from "../native-artifact/spawn-helper-sampler.js";

describe("parseArchitecture (file -b output)", () => {
  it.each([
    ["Mach-O 64-bit executable arm64", "arm64"],
    ["Mach-O 64-bit executable x86_64", "x86_64"],
    ["Mach-O universal binary with 2 architectures: arm64 x86_64", "arm64"],
  ] as const)("parses %s → %s", (raw, arch) => {
    expect(parseArchitecture(raw)).toBe(arch);
  });

  it.each([[null], ["data"], ["ASCII text"]])("returns null for %s", (raw) => {
    expect(parseArchitecture(raw)).toBeNull();
  });
});

describe("parseDeploymentTarget (vtool -show-build minos)", () => {
  it.each([
    [
      "Load command 10\n      cmd LC_BUILD_VERSION\n  platform MACOS\n    minos 11.0\n      sdk 15.5",
      "11.0",
    ],
    ["    minos 26.0\n", "26.0"],
    ["    minos 14\n", "14"],
  ] as const)("parses minos %s → %s", (raw, out) => {
    expect(parseDeploymentTarget(raw)).toBe(out);
  });

  it.each([[null], [""], ["no version line here"]])("returns null for %s", (raw) => {
    expect(parseDeploymentTarget(raw)).toBeNull();
  });
});

describe("parseSignatureKind (codesign -dv output, stderr)", () => {
  it("detects adhoc / linker-signed", () => {
    expect(
      parseSignatureKind(
        "Identifier=spawn-helper\nCodeDirectory v=20400 size=517 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc",
      ),
    ).toBe("adhoc");
  });

  it("detects developer-id via Authority", () => {
    expect(
      parseSignatureKind(
        "Identifier=spawn-helper\nAuthority=Developer ID Application: Acme Inc. (ABCD1234)\nSignature=valid",
      ),
    ).toBe("developer-id");
  });

  it.each([[""], [null]])("returns none for %s", (raw) => {
    expect(parseSignatureKind(raw)).toBe("none");
  });
});

// Canned outputs captured from the real installed spawn-helper on this host.
const realDeps = (over: Partial<SpawnHelperProbeDeps> = {}): SpawnHelperProbeDeps => ({
  mode: () => 0o644,
  runText: (cmd) => {
    if (cmd === "file") return "Mach-O 64-bit executable arm64";
    if (cmd === "vtool")
      return "Load command 10\n      cmd LC_BUILD_VERSION\n  platform MACOS\n    minos 11.0\n      sdk 15.5";
    if (cmd === "codesign")
      return "Identifier=spawn-helper\nCodeDirectory v=20400 size=517 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc";
    throw new Error(`unexpected probe: ${cmd}`);
  },
  sha256: () => "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26",
  ...over,
});

describe("sampleSpawnHelper", () => {
  it("samples the real installed helper (0o644 / arm64 / minos 11.0 / adhoc / sha256)", () => {
    expect(sampleSpawnHelper("/path/to/spawn-helper", realDeps())).toEqual({
      exists: true,
      mode: 0o644,
      architecture: "arm64",
      deploymentTarget: "11.0",
      signatureKind: "adhoc",
      sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26",
    });
  });

  it("returns exists=false (null fields) when the file is missing", () => {
    expect(sampleSpawnHelper("/nope", realDeps({ mode: () => null }))).toEqual({
      exists: false,
      mode: null,
      architecture: null,
      deploymentTarget: null,
      signatureKind: null,
      sha256: null,
    });
  });

  it("tolerates a failing probe (null) without throwing", () => {
    const deps = realDeps({
      runText: () => {
        throw new Error("tool missing");
      },
      sha256: () => {
        throw new Error("unreadable");
      },
    });
    expect(sampleSpawnHelper("/path/to/spawn-helper", deps)).toEqual({
      exists: true,
      mode: 0o644,
      architecture: null,
      deploymentTarget: null,
      signatureKind: "none",
      sha256: null,
    });
  });
});
