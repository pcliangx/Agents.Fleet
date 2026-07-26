import { describe, expect, it } from "vitest";
import {
  parseArchitecture,
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

describe("parseSignatureKind (codesign -dv output, stderr)", () => {
  it("detects adhoc / linker-signed", () => {
    expect(
      parseSignatureKind(
        "Identifier=spawn-helper\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20400 size=517 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc",
      ),
    ).toBe("adhoc");
  });

  it("detects developer-id via Authority", () => {
    expect(
      parseSignatureKind(
        "Identifier=spawn-helper\nAuthority=Developer ID Application: Acme Inc. (ABCD1234)\nTeamIdentifier=ABCD1234\nSignature=valid",
      ),
    ).toBe("developer-id");
  });

  it.each([[""], [null]])("returns none for %s", (raw) => {
    expect(parseSignatureKind(raw)).toBe("none");
  });
});

// Canned outputs captured from the real installed spawn-helper on this host.
const realDeps = (over: Partial<SpawnHelperProbeDeps> = {}): SpawnHelperProbeDeps => ({
  mode: () => 0o444,
  runText: (cmd) => {
    if (cmd === "file") return "Mach-O 64-bit executable arm64";
    if (cmd === "codesign")
      return "Identifier=spawn-helper\nCodeDirectory v=20400 size=517 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc";
    throw new Error(`unexpected probe: ${cmd}`);
  },
  sha256: () => "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26",
  ...over,
});

describe("sampleSpawnHelper", () => {
  it("samples the real installed helper (0o444 / arm64 / adhoc / sha256)", () => {
    expect(sampleSpawnHelper("/path/to/spawn-helper", realDeps())).toEqual({
      exists: true,
      mode: 0o444,
      architecture: "arm64",
      signatureKind: "adhoc",
      sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26",
    });
  });

  it("returns exists=false (null fields) when the file is missing", () => {
    expect(sampleSpawnHelper("/nope", realDeps({ mode: () => null }))).toEqual({
      exists: false,
      mode: null,
      architecture: null,
      signatureKind: null,
      sha256: null,
    });
  });

  it("tolerates a failing probe (null) without throwing", () => {
    const deps = realDeps({
      runText: () => {
        throw new Error("file missing");
      },
      sha256: () => {
        throw new Error("unreadable");
      },
    });
    expect(sampleSpawnHelper("/path/to/spawn-helper", deps)).toEqual({
      exists: true,
      mode: 0o444,
      architecture: null,
      signatureKind: "none",
      sha256: null,
    });
  });
});
