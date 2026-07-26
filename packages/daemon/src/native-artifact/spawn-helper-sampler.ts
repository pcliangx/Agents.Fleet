// RT-DIST-01 / SV1-SUPPLY-02 — observe the installed node-pty spawn-helper.
//
// Pure parsing + an injectable probe interface so tests do not shell out. This
// module imports no Node builtins; the real probe (stat / file / vtool /
// codesign / sha256) is wired in spawn-helper-probe.ts, matching the R0-15
// platform-gate pure-gate pattern.

import type {
  Architecture,
  SpawnHelperObserved,
  SpawnHelperSignatureKind,
} from "./spawn-helper-verifier.js";

/** Architecture families recognised in `file -b` Mach-O output. */
const ARCH_TOKENS: readonly Architecture[] = ["arm64", "x86_64", "i386"];

export function parseArchitecture(fileOutput: string | null): Architecture | null {
  if (!fileOutput) return null;
  return ARCH_TOKENS.find((token) => fileOutput.includes(token)) ?? null;
}

/** Deployment target from `vtool -show-build` LC_BUILD_VERSION `minos X.Y`. */
export function parseDeploymentTarget(vtoolOutput: string | null): string | null {
  if (!vtoolOutput) return null;
  const match = vtoolOutput.match(/^\s*minos\s+(\d+(?:\.\d+)?)/m);
  return match ? (match[1] ?? null) : null;
}

export function parseSignatureKind(codesignOutput: string | null): SpawnHelperSignatureKind {
  if (!codesignOutput) return "none";
  if (codesignOutput.includes("Signature=adhoc")) return "adhoc";
  if (codesignOutput.includes("Authority=")) return "developer-id";
  return "none";
}

export interface SpawnHelperProbeDeps {
  /** Permission bits (st_mode & 0o777), or null if the file does not exist. */
  mode(path: string): number | null;
  /** Merged stdout+stderr of a probe command, trimmed. Throws on failure. */
  runText(command: string, args: readonly string[]): string;
  /** SHA-256 hex of the file bytes. Throws on failure. */
  sha256(path: string): string;
}

function tryValue<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function sampleSpawnHelper(path: string, deps: SpawnHelperProbeDeps): SpawnHelperObserved {
  const mode = deps.mode(path);
  if (mode === null) {
    return {
      exists: false,
      mode: null,
      architecture: null,
      deploymentTarget: null,
      signatureKind: null,
      sha256: null,
    };
  }
  const fileOutput = tryValue(() => deps.runText("file", ["-b", path]));
  const vtoolOutput = tryValue(() => deps.runText("vtool", ["-show-build", path]));
  const codesignOutput = tryValue(() => deps.runText("codesign", ["-dv", path]));
  const sha = tryValue(() => deps.sha256(path));
  return {
    exists: true,
    mode,
    architecture: parseArchitecture(fileOutput),
    deploymentTarget: parseDeploymentTarget(vtoolOutput),
    signatureKind: parseSignatureKind(codesignOutput),
    sha256: sha,
  };
}
