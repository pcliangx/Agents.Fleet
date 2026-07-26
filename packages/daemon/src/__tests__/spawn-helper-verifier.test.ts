import { describe, expect, it } from "vitest";
import {
  repairSpawnHelper,
  SPAWN_HELPER_REPAIR_PATCH,
  type SpawnHelperExpected,
  type SpawnHelperObserved,
  verifySpawnHelper,
} from "../native-artifact/spawn-helper-verifier.js";

// Independent floor: dev acceptance (adhoc signature ok; hash not yet pinned);
// matrix minimum host macOS 26 (RT-DIST-08). Helper deployment target 11.0
// loads on a macOS 26 host, so it is within floor.
const expected = (over: Partial<SpawnHelperExpected> = {}): SpawnHelperExpected => ({
  architecture: "arm64",
  minimumMacOSVersion: "26",
  minimumSignature: "adhoc",
  sha256: null,
  ...over,
});

const observed = (over: Partial<SpawnHelperObserved> = {}): SpawnHelperObserved => ({
  exists: true,
  mode: 0o755,
  architecture: "arm64",
  deploymentTarget: "11.0",
  signatureKind: "adhoc",
  sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26",
  ...over,
});

describe("RT-DIST-01 / SV1-SUPPLY-02 spawn-helper verifier", () => {
  it("accepts a launch-ready helper (exec bit + arch + deployment target + signature)", () => {
    expect(verifySpawnHelper(observed(), expected())).toEqual({ ready: true, problems: [] });
  });

  it("reproduces #22: shipped 0o644 helper is not ready (sole problem = exec bit)", () => {
    const verdict = verifySpawnHelper(observed({ mode: 0o644 }), expected());
    expect(verdict).toEqual({ ready: false, problems: ["missingExecutableBit"] });
    expect(repairSpawnHelper(verdict)).toEqual({
      permitted: true,
      action: "chmod",
      mode: 0o755,
    });
  });

  it.each([
    ["missing", observed({ exists: false }), expected(), ["missing"]],
    [
      "missingExecutableBit (0o644)",
      observed({ mode: 0o644 }),
      expected(),
      ["missingExecutableBit"],
    ],
    [
      "architectureMismatch",
      observed({ architecture: "x86_64" }),
      expected(),
      ["architectureMismatch"],
    ],
    [
      "deploymentTargetAboveHostFloor (27 > 26)",
      observed({ deploymentTarget: "27.0" }),
      expected(),
      ["deploymentTargetAboveHostFloor"],
    ],
    ["signatureMissing", observed({ signatureKind: "none" }), expected(), ["signatureMissing"]],
    [
      "signatureTooWeak (adhoc vs developer-id)",
      observed({ signatureKind: "adhoc" }),
      expected({ minimumSignature: "developer-id" }),
      ["signatureTooWeak"],
    ],
    [
      "hashMismatch (pinned)",
      observed({ sha256: "deadbeef" }),
      expected({ sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26" }),
      ["hashMismatch"],
    ],
  ] as const)("reports problem %s", (_label, obs, exp, problems) => {
    expect(verifySpawnHelper(obs as SpawnHelperObserved, exp as SpawnHelperExpected)).toEqual({
      ready: false,
      problems,
    });
  });

  it("treats a null deployment target as non-blocking (caller flags the gap)", () => {
    expect(verifySpawnHelper(observed({ deploymentTarget: null }), expected())).toEqual({
      ready: true,
      problems: [],
    });
  });
});

describe("spawn-helper repair decision (SV1-SUPPLY-02 owned patch)", () => {
  it("is not needed when already ready", () => {
    expect(repairSpawnHelper({ ready: true, problems: [] })).toEqual({
      permitted: false,
      reason: "not-needed",
      blockingProblems: [],
    });
  });

  it("permits chmod 0755 when the exec bit is the sole problem", () => {
    expect(repairSpawnHelper({ ready: false, problems: ["missingExecutableBit"] })).toEqual({
      permitted: true,
      action: "chmod",
      mode: 0o755,
    });
  });

  it.each([
    [
      "architecture mismatch",
      ["missingExecutableBit", "architectureMismatch"],
      ["architectureMismatch"],
    ],
    [
      "deployment target too high",
      ["missingExecutableBit", "deploymentTargetAboveHostFloor"],
      ["deploymentTargetAboveHostFloor"],
    ],
    ["hash mismatch (tampered)", ["missingExecutableBit", "hashMismatch"], ["hashMismatch"]],
    [
      "release adhoc (needs resign, not chmod)",
      ["missingExecutableBit", "signatureTooWeak"],
      ["signatureTooWeak"],
    ],
  ] as const)("blocks chmod when %s is also present", (_label, problems, blocking) => {
    expect(repairSpawnHelper({ ready: false, problems: [...problems] })).toEqual({
      permitted: false,
      reason: "blocked",
      blockingProblems: [...blocking],
    });
  });

  it("exposes the co-located SV1-SUPPLY-02 patch record", () => {
    expect(SPAWN_HELPER_REPAIR_PATCH).toMatchObject({
      owner: expect.any(String),
      source: expect.any(String),
      patch: "chmod 0755 prebuilds/darwin-arm64/spawn-helper",
      regressionFixture: expect.any(String),
      deletionCondition: expect.any(String),
      doesNotRelyOnNpmLifecycle: true,
    });
  });
});
