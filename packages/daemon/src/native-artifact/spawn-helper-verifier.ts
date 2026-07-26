// RT-DIST-01 / SV1-SUPPLY-02 — node-pty spawn-helper artifact verifier.
//
// node-pty 1.1.0 ships its prebuilt spawn-helper with mode 0644 (no executable
// bit), and npm 11 allow-scripts blocks the lifecycle script that would restore
// +x, so `pty.spawn` fails with `posix_spawnp failed.` (issue #22). The Daemon
// install/upgrade path must therefore explicitly verify the helper's executable
// bit, architecture, deployment target, signature and hash, and apply a chmod
// repair as an owned downstream patch (SV1-SUPPLY-02) rather than relying on an
// npm lifecycle.
//
// This module is pure: it classifies an *observed* helper against an *expected*
// policy and decides whether a chmod repair is safe. Sampling the real helper
// (stat / file / vtool / codesign / sha256) lives in spawn-helper-sampler.ts.

export type Architecture = "arm64" | "x86_64" | "i386";

export type SpawnHelperSignatureKind = "developer-id" | "adhoc" | "none";

export interface SpawnHelperObserved {
  readonly exists: boolean;
  /** Permission bits (st_mode & 0o777), e.g. 0o444 (shipped) or 0o755 (repaired). */
  readonly mode: number | null;
  /** Mach-O architecture from `file`, e.g. "arm64". */
  readonly architecture: Architecture | null;
  /** Mach-O deployment target (LC_BUILD_VERSION minos) from `vtool`, e.g. "11.0". */
  readonly deploymentTarget: string | null;
  /** Signature kind from `codesign -dv`. */
  readonly signatureKind: SpawnHelperSignatureKind | null;
  /** SHA-256 of the helper bytes. */
  readonly sha256: string | null;
}

export type SpawnHelperMinimumSignature = "developer-id" | "adhoc";

export interface SpawnHelperExpected {
  readonly architecture: Architecture;
  /**
   * Minimum supported HOST macOS from SupportedPlatformMatrix.minimumMacOSVersion
   * (RT-DIST-08). The helper's deployment target must be ≤ this so the binary
   * loads on the lowest supported host (SV1-SUPPLY-02).
   */
  readonly minimumMacOSVersion: string;
  /** Dev acceptance allows adhoc; release requires developer-id (SV1-SUPPLY-03). */
  readonly minimumSignature: SpawnHelperMinimumSignature;
  /** Release-pinned hash. null means not pinned yet (R0 dev / R5 release manifest). */
  readonly sha256: string | null;
}

export type SpawnHelperProblem =
  | "missing"
  | "missingExecutableBit"
  | "architectureMismatch"
  | "deploymentTargetAboveHostFloor"
  | "signatureMissing"
  | "signatureTooWeak"
  | "hashMismatch";

export interface SpawnHelperVerdict {
  readonly ready: boolean;
  readonly problems: readonly SpawnHelperProblem[];
}

const EXEC_BITS = 0o111;

const SIGNATURE_STRENGTH: Record<SpawnHelperSignatureKind, number> = {
  none: 0,
  adhoc: 1,
  "developer-id": 2,
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

/** a ≤ b on major.minor (null → not comparable). */
function versionAtMost(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  return va.major < vb.major || (va.major === vb.major && va.minor <= vb.minor);
}

export function verifySpawnHelper(
  observed: SpawnHelperObserved,
  expected: SpawnHelperExpected,
): SpawnHelperVerdict {
  if (!observed.exists) {
    return { ready: false, problems: ["missing"] };
  }

  const problems: SpawnHelperProblem[] = [];

  if (observed.mode === null || (observed.mode & EXEC_BITS) === 0) {
    problems.push("missingExecutableBit");
  }
  if (observed.architecture !== expected.architecture) {
    problems.push("architectureMismatch");
  }
  // SV1-SUPPLY-02: the binary must load on the lowest supported host, i.e. its
  // deployment target ≤ the matrix minimum macOS version. Only checked when the
  // deployment target was observed; a null sample is left to the caller to flag.
  if (
    observed.deploymentTarget !== null &&
    !versionAtMost(observed.deploymentTarget, expected.minimumMacOSVersion)
  ) {
    problems.push("deploymentTargetAboveHostFloor");
  }
  if (observed.signatureKind === null || observed.signatureKind === "none") {
    problems.push("signatureMissing");
  } else if (
    SIGNATURE_STRENGTH[observed.signatureKind] < SIGNATURE_STRENGTH[expected.minimumSignature]
  ) {
    problems.push("signatureTooWeak");
  }
  if (expected.sha256 !== null && observed.sha256 !== expected.sha256) {
    problems.push("hashMismatch");
  }

  return { ready: problems.length === 0, problems };
}

export type SpawnHelperRepair =
  | { readonly permitted: true; readonly action: "chmod"; readonly mode: 0o755 }
  | {
      readonly permitted: false;
      readonly reason: "blocked" | "not-needed";
      readonly blockingProblems: readonly SpawnHelperProblem[];
    };

/**
 * The chmod 0755 repair is the owned downstream patch (see
 * SPAWN_HELPER_REPAIR_PATCH). It is permitted ONLY when the executable bit is
 * the sole problem — never repair a wrong-architecture, wrong-deployment-target,
 * tampered (hash mismatch), or under-signed binary, and never when the helper is
 * already launch-ready.
 */
export function repairSpawnHelper(verdict: SpawnHelperVerdict): SpawnHelperRepair {
  if (verdict.ready) {
    return { permitted: false, reason: "not-needed", blockingProblems: [] };
  }
  const blockingProblems = verdict.problems.filter((p) => p !== "missingExecutableBit");
  if (blockingProblems.length > 0) {
    return { permitted: false, reason: "blocked", blockingProblems };
  }
  return { permitted: true, action: "chmod", mode: 0o755 };
}

/**
 * SV1-SUPPLY-02 downstream-patch record, co-located with the repair it
 * describes. `hash` is filled at runtime from the observed helper. The Daemon
 * install/upgrade (R5) is the runtime owner; until then this record is the
 * authoritative patch provenance.
 */
export const SPAWN_HELPER_REPAIR_PATCH = {
  owner: "Agents.Fleet daemon install/upgrade (RT-DIST-01)",
  source: "node-pty@1.1.0 prebuild (darwin-arm64)",
  patch: "chmod 0755 prebuilds/darwin-arm64/spawn-helper",
  regressionFixture:
    "packages/daemon/src/__tests__/spawn-helper-verifier.test.ts + r0-22 prototype",
  deletionCondition:
    "when node-pty ships spawn-helper with +x in the prebuild, or the release bundle embeds a developer-id-signed + notarized spawn-helper (SV1-SUPPLY-03 / RT-DIST-01)",
  doesNotRelyOnNpmLifecycle: true,
} as const;
