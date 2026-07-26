// S1 — Electron bundle layout check (issue #36).
//
// pnpm's side-effects cache restores postinstall-created symlinks as regular
// files (upstream pnpm#12859). The load-bearing framework symlinks then point
// at one physical copy while any tooling that edits `Versions/Current/...`
// touches another — e.g. the fuse fixture flips a binary the loader never
// reads. This verifier fails early on that shape.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkElectronBundleLayout } from "../electron-bundle-layout.mjs";

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const FRAMEWORK = join(
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
);

const makeApp = (layout) => {
  dir = mkdtempSync(join(tmpdir(), "af-e36-layout-"));
  const app = join(dir, "Electron.app");
  const framework = join(app, FRAMEWORK);
  mkdirSync(join(framework, "Versions", "A"), { recursive: true });
  writeFileSync(join(framework, "Versions", "A", "Electron Framework"), "mach-o");

  if (layout === "proper") {
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync(
      join("Versions", "Current", "Electron Framework"),
      join(framework, "Electron Framework"),
    );
  } else if (layout === "dereferenced") {
    // The side-effects-cache restore shape: every symlink materialized as a
    // full copy of its target.
    mkdirSync(join(framework, "Versions", "Current"));
    writeFileSync(join(framework, "Versions", "Current", "Electron Framework"), "mach-o");
    writeFileSync(join(framework, "Electron Framework"), "mach-o");
  }
  return app;
};

describe("checkElectronBundleLayout (#36)", () => {
  it("accepts a properly symlinked framework bundle", () => {
    expect(checkElectronBundleLayout(makeApp("proper"))).toEqual({ ok: true });
  });

  it("rejects the dereferenced (side-effects-cache restore) shape", () => {
    const result = checkElectronBundleLayout(makeApp("dereferenced"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.problem)).toEqual([
      "not-a-symlink",
      "not-a-symlink",
    ]);
    const paths = result.violations.map((v) => v.path).join("\n");
    expect(paths).toContain(join("Electron Framework.framework", "Electron Framework"));
    expect(paths).toContain(join("Versions", "Current"));
  });

  it("reports missing paths instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "af-e36-layout-"));
    const result = checkElectronBundleLayout(join(dir, "Electron.app"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.every((v) => v.problem === "missing")).toBe(true);
  });
});
