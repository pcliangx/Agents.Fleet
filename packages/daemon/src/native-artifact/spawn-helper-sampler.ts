// RT-DIST-01 / SV1-SUPPLY-02 — observe the installed node-pty spawn-helper.
//
// Pure parsing + an injectable probe interface so tests do not shell out. The
// real probe (stat / file / codesign / sha256) is wired in defaultProbeDeps.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { SpawnHelperObserved, SpawnHelperSignatureKind } from "./spawn-helper-verifier.js";

/** Architecture families recognised in `file -b` Mach-O output. */
const ARCH_TOKENS = ["arm64", "x86_64", "i386"] as const;

export function parseArchitecture(fileOutput: string | null): string | null {
  if (!fileOutput) return null;
  return ARCH_TOKENS.find((token) => fileOutput.includes(token)) ?? null;
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
    return { exists: false, mode: null, architecture: null, signatureKind: null, sha256: null };
  }
  const fileOutput = tryValue(() => deps.runText("file", ["-b", path]));
  const codesignOutput = tryValue(() => deps.runText("codesign", ["-dv", path]));
  const sha = tryValue(() => deps.sha256(path));
  return {
    exists: true,
    mode,
    architecture: parseArchitecture(fileOutput),
    signatureKind: parseSignatureKind(codesignOutput),
    sha256: sha,
  };
}

/** Real probe: stat for mode, file/codesign via spawnSync (codesign writes stderr), sha256 via crypto. */
export const defaultProbeDeps: SpawnHelperProbeDeps = {
  mode(path) {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
  runText(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  },
  sha256(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  },
};
