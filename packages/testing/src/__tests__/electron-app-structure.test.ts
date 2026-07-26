// #36 — verifyElectronFrameworkStructure detects the pnpm side-effects-cache
// corruption where Electron.app's framework symlinks are restored as
// dereferenced real files/dirs (which makes apps/desktop fuses.test.ts flip the
// wrong copy). Pure fs check, fixture-driven.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const importStructure = async (): Promise<
  (frameworkPath: string) => Promise<{ ok: boolean; problems: readonly string[] }>
> => {
  // @ts-expect-error — the .mjs has no declaration; the cast below carries the type.
  const mod = await import("../../../../scripts/verify-electron-structure.mjs");
  return mod.verifyElectronFrameworkStructure as (
    frameworkPath: string,
  ) => Promise<{ ok: boolean; problems: readonly string[] }>;
};

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

// A correct framework: Versions/Current -> A (symlink), top-level
// "Electron Framework" -> Versions/Current/Electron Framework (symlink).
const makeCorrectFramework = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "af-fw-correct-"));
  dirs.push(root);
  const fw = join(root, "Electron Framework.framework");
  await mkdir(join(fw, "Versions", "A"), { recursive: true });
  await writeFile(join(fw, "Versions", "A", "Electron Framework"), "binary");
  await symlink("A", join(fw, "Versions", "Current"));
  await symlink("Versions/Current/Electron Framework", join(fw, "Electron Framework"));
  return fw;
};

// A dereferenced framework (the #36 corruption): Versions/Current is a real
// directory, "Electron Framework" is a real file — no symlinks.
const makeDereferencedFramework = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "af-fw-broken-"));
  dirs.push(root);
  const fw = join(root, "Electron Framework.framework");
  await mkdir(join(fw, "Versions", "Current"), { recursive: true });
  await writeFile(join(fw, "Versions", "Current", "Electron Framework"), "binary");
  await writeFile(join(fw, "Electron Framework"), "binary");
  return fw;
};

describe("#36 verifyElectronFrameworkStructure", () => {
  it("accepts a correct symlink structure", async () => {
    const verify = await importStructure();
    const r = await verify(await makeCorrectFramework());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("rejects a dereferenced structure (Versions/Current real dir, Electron Framework real file)", async () => {
    const verify = await importStructure();
    const r = await verify(await makeDereferencedFramework());
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBe(2);
    expect(r.problems.some((p) => p.includes("Versions/Current"))).toBe(true);
    expect(r.problems.some((p) => p.includes("Electron Framework"))).toBe(true);
  });
});
