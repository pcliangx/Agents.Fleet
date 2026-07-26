#!/usr/bin/env node
// #36 — Electron bundle layout check.
//
// pnpm's side-effects cache restores postinstall-created symlinks as regular
// files (upstream pnpm#12859). A warm-store install of electron@34 then
// materializes the framework's load-bearing symlinks as physical copies: the
// loader resolves `Electron Framework.framework/Electron Framework` while
// tooling (e.g. the SV1-ELECTRON-05 fuse fixture) edits
// `Versions/Current/Electron Framework` — a different inode. The bundle still
// boots, so the breakage only shows up as inexplicable fixture failures.
//
// This check fails early on that shape. The repo guard against the root cause
// is `sideEffectsCache: false` in pnpm-workspace.yaml; this verifier is the
// defense-in-depth for already-poisoned stores and future regressions.

import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// Symlinks the Electron framework bundle cannot function-correctly without.
// Each entry: path inside the .app, and why it is load-bearing.
const REQUIRED_SYMLINKS = [
  [
    join("Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
    "the dyld entry point of the framework",
  ],
  [
    join(
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "Current",
    ),
    "the version indirection every framework-relative lookup resolves through",
  ],
];

/**
 * Verify the load-bearing symlinks of an Electron.app bundle.
 * @param {string} appPath path to Electron.app
 * @returns {{ ok: true } | { ok: false, violations: Array<{ path: string, problem: "missing" | "not-a-symlink", detail: string }> }}
 */
export const checkElectronBundleLayout = (appPath) => {
  const violations = [];
  for (const [rel, why] of REQUIRED_SYMLINKS) {
    let st;
    try {
      st = lstatSync(join(appPath, rel));
    } catch {
      violations.push({ path: rel, problem: "missing", detail: `${why} — not found` });
      continue;
    }
    if (!st.isSymbolicLink()) {
      violations.push({
        path: rel,
        problem: "not-a-symlink",
        detail: `${why} — materialized as a ${st.isDirectory() ? "directory copy" : "regular file"} (side-effects-cache restore shape, upstream pnpm#12859)`,
      });
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
};

/**
 * Resolve the framework symlink chain to the physical binary it loads.
 * Exposed for diagnostics (e.g. which inode a fuse flip must edit).
 * @param {string} appPath
 * @returns {string | null} absolute path of the physical framework binary, or null when unresolvable
 */
export const resolveFrameworkBinary = (appPath) => {
  try {
    const entry = join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    );
    return join(
      appPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      readlinkSync(entry),
    );
  } catch {
    return null;
  }
};
