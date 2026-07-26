#!/usr/bin/env node
// SV1-SUPPLY-02 — verify a cached Electron download artifact (dev/test
// lifecycle provisioning) against the locked checksum in
// config/electron-artifact-checksums.json. Run via `pnpm verify:electron`.
//
// @electron/get caches downloads as <cacheDir>/<url-hash>/electron-v<version>-<os>-<arch>.zip;
// this script walks that layout (one level deep). Best-effort: if no cached zip
// matches, it warns and exits 0 — the locked checksum in the store is the
// contract; this script only verifies a present cached artifact matches it.
// NOT a release input (see SV1-SUPPLY-02).
//
// #36 — additionally asserts the INSTALLED bundle keeps its framework
// symlinks: pnpm's side-effects cache restores them as physical copies on
// warm-store installs (upstream pnpm#12859), which silently breaks any tooling
// that edits `Versions/Current/...` (e.g. the fuse fixture). Violations exit 1
// with a repair hint; the root-cause guard is `sideEffectsCache: false`.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkElectronBundleLayout } from "./electron-bundle-layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const store = JSON.parse(
  await readFile(join(root, "config", "electron-artifact-checksums.json"), "utf8"),
);

const cacheDir =
  process.env.ELECTRON_CACHE ??
  (platform() === "darwin"
    ? join(homedir(), "Library", "Caches", "electron")
    : platform() === "win32"
      ? join(homedir(), "AppData", "Local", "electron", "Cache")
      : join(homedir(), ".cache", "electron"));

const sha256 = (p) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

// Collect every electron-v*.zip under cacheDir, one level deep
// (<cacheDir>/<url-hash>/electron-v*.zip), de-duplicating mirror copies by name.
const zips = [];
let top;
try {
  top = await readdir(cacheDir);
} catch {
  console.warn(
    `[verify:electron] @electron/get cache not found (${cacheDir}); run \`pnpm install\` first. Locked checksum unchanged — skipping.`,
  );
  process.exit(0);
}
for (const f of top) {
  const sub = join(cacheDir, f);
  let st;
  try {
    st = await stat(sub);
  } catch {
    continue;
  }
  if (st.isDirectory()) {
    let subFiles;
    try {
      subFiles = await readdir(sub);
    } catch {
      continue;
    }
    for (const sf of subFiles) {
      if (/^electron-v.*\.zip$/.test(sf)) zips.push({ name: sf, path: join(sub, sf) });
    }
  } else if (/^electron-v.*\.zip$/.test(f)) {
    zips.push({ name: f, path: sub });
  }
}

let checked = 0;
let failed = 0;
const seen = new Set();
for (const z of zips) {
  if (seen.has(z.name)) continue;
  seen.add(z.name);
  const m = z.name.match(/^electron-v(\d+\.\d+\.\d+)-([^-]+)-([^.]+)\.zip$/);
  if (!m) continue;
  const [, version, os, arch] = m;
  const expected = store[`electron@${version}`]?.[`${os}-${arch}`];
  if (!expected) continue;
  const actualSha = await sha256(z.path);
  const actualSize = (await stat(z.path)).size;
  const ok = actualSha === expected.sha256 && actualSize === expected.size;
  checked++;
  if (!ok) failed++;
  console.log(
    `${ok ? "✓" : "✗"} ${z.name} — sha256=${actualSha === expected.sha256} size=${actualSize === expected.size}`,
  );
}

// #36 — the installed bundle must keep its framework symlinks; a warm-store
// side-effects-cache restore materializes them as copies (pnpm#12859).
let layoutFailed = 0;
const requireFromDesktop = createRequire(join(root, "apps", "desktop", "package.json"));
let electronExe = null;
try {
  electronExe = requireFromDesktop("electron");
} catch {
  console.warn(
    "[verify:electron] electron package not installed — skipping bundle layout check.",
  );
}
if (electronExe) {
  // <pkg>/dist/Electron.app/Contents/MacOS/Electron → Electron.app
  const appPath = dirname(dirname(dirname(electronExe)));
  const layout = checkElectronBundleLayout(appPath);
  if (layout.ok) {
    console.log("✓ Electron.app framework symlinks intact");
  } else {
    layoutFailed = layout.violations.length;
    for (const v of layout.violations) console.log(`✗ ${v.path} — ${v.detail}`);
    console.log(
      "[verify:electron] repair: remove the electron package's dist + path.txt and re-run its install hook under the pnpm-managed Node (`pnpm rebuild electron` with sideEffectsCache=false); see issue #36 / upstream pnpm#12859.",
    );
  }
}

console.log(
  checked === 0
    ? "[verify:electron] no cached Electron zip matched the store. Locked checksum unchanged."
    : failed === 0
      ? `[verify:electron] ${checked} artifact(s) match locked checksums.`
      : `[verify:electron] ${failed}/${checked} artifact(s) MISMATCH.`,
);
process.exit(failed === 0 && layoutFailed === 0 ? 0 : 1);
