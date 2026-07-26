// #36 — detect pnpm side-effects-cache corruption of Electron.app's framework
// symlinks. On a warm-store install pnpm restores electron's postinstall result
// from its side-effects cache WITHOUT preserving symlinks, so `Versions/Current`
// and the top-level `Electron Framework` become dereferenced real files/dirs —
// which makes apps/desktop fuses.test.ts flip the wrong copy (the dynamic
// loader reads the top-level dereferenced file, not the symlink target). This
// pure check is imported by scripts/verify-electron-artifact.mjs to fail early.

import { lstat } from "node:fs/promises";
import { join } from "node:path";

// Paths that MUST be symbolic links in a correctly-extracted Electron
// Framework.framework (probed on a healthy install; both are dereferenced real
// files/dirs under the #36 corruption).
const SYMLINK_PATHS = ["Versions/Current", "Electron Framework"];

/**
 * @param {string} frameworkPath — path to `Electron Framework.framework`.
 * @returns {Promise<{ ok: boolean, problems: readonly string[] }>}
 */
export const verifyElectronFrameworkStructure = async (frameworkPath) => {
  const problems = [];
  for (const rel of SYMLINK_PATHS) {
    const p = join(frameworkPath, rel);
    let st;
    try {
      st = await lstat(p);
    } catch {
      problems.push(`${rel}: missing`);
      continue;
    }
    if (!st.isSymbolicLink()) {
      problems.push(
        `${rel}: not a symlink (dereferenced ${st.isDirectory() ? "directory" : "file"} — pnpm side-effects-cache corruption, see #36)`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
};
