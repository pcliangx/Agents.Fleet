#!/usr/bin/env node
// #36 — Electron bundle layout check.
//
// Guards the load-bearing framework symlinks against the dereferenced shape a
// warm-store pnpm install restores (root cause and repo policy: SV1-SUPPLY-02
// changelog for issue #36 in docs/specs/security-v1.md). A symlink must exist
// AND point at its bundle-relative target — a dangling or retargeted link is
// just as broken as a physical copy.

import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const FRAMEWORK_DIR = join("Contents", "Frameworks", "Electron Framework.framework");

// Symlinks the Electron framework bundle cannot function-correctly without.
// Each entry: path inside the .app, the required link target, and why the link
// is load-bearing.
const REQUIRED_SYMLINKS = [
  [
    join(FRAMEWORK_DIR, "Electron Framework"),
    join("Versions", "Current", "Electron Framework"),
    "the dyld entry point of the framework",
  ],
  [join(FRAMEWORK_DIR, "Versions", "Current"), "A", "the version indirection every framework-relative lookup resolves through"],
];

/**
 * Verify the load-bearing symlinks of an Electron.app bundle.
 * @param {string} appPath path to Electron.app
 * @returns {{ ok: true } | { ok: false, violations: Array<{ path: string, problem: "missing" | "not-a-symlink" | "wrong-target", detail: string }> }}
 */
export const checkElectronBundleLayout = (appPath) => {
  const violations = [];
  for (const [rel, expectedTarget, why] of REQUIRED_SYMLINKS) {
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
      continue;
    }
    const target = readlinkSync(join(appPath, rel));
    if (target !== expectedTarget) {
      violations.push({
        path: rel,
        problem: "wrong-target",
        detail: `${why} — symlink points at ${JSON.stringify(target)}, expected ${JSON.stringify(expectedTarget)}`,
      });
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
};
