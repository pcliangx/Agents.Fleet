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

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyElectronFrameworkStructure } from "./verify-electron-structure.mjs";

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

// #36 — the cache-zip checksum alone misses pnpm side-effects-cache corruption:
// on a warm-store install electron's postinstall is skipped and the framework
// symlinks are restored as dereferenced real files/dirs. Verify the EXTRACTED
// Electron.app structure too, so verify:electron fails early instead of
// surfacing as a flaky apps/desktop fuses.test.ts.
const pnpmDir = join(root, "node_modules", ".pnpm");
let pnpmTop = [];
try {
  pnpmTop = await readdir(pnpmDir);
} catch {
  pnpmTop = [];
}
let structureFailures = 0;
for (const e of pnpmTop) {
  if (!/^electron@/.test(e)) continue;
  const fw = join(
    pnpmDir,
    e,
    "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework",
  );
  let fwStat;
  try {
    fwStat = await stat(fw);
  } catch {
    continue; // extracted app not present in this install → skip
  }
  if (!fwStat.isDirectory()) continue;
  const struct = await verifyElectronFrameworkStructure(fw);
  if (struct.ok) {
    console.log(`✓ ${e} — framework symlink structure intact.`);
    continue;
  }
  structureFailures += 1;
  console.log(`✗ ${e} — framework symlink structure corrupted (#36):`);
  for (const p of struct.problems) console.log(`    ${p}`);
  console.log(
    `    re-extract with the managed Node (NOT host Node — see #28): cd node_modules/.pnpm/${e}/node_modules/electron && rm -rf dist path.txt && ~/Library/pnpm/nodejs/22.17.1/bin/node install.js`,
  );
}

const zipMsg =
  checked === 0
    ? "no cached Electron zip matched the store (locked checksum unchanged)"
    : failed === 0
      ? `${checked} zip artifact(s) match locked checksums`
      : `${failed}/${checked} zip artifact(s) MISMATCH`;
const structMsg =
  structureFailures === 0 ? "" : `; ${structureFailures} extracted framework(s) CORRUPTED (#36)`;
console.log(`[verify:electron] ${zipMsg}${structMsg}.`);
process.exit(failed === 0 && structureFailures === 0 ? 0 : 1);
