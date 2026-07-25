import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_PACKAGE_SET } from "../allowlist.js";

// RT-TERM-01 / RT-T-35 / SV1-TERM-01 / SV1-T-24 — repo-wide @xterm/* deps must
// equal the pinned manifest: exactly the allowlisted packages, exact versions,
// no ranges (^/~/>*), no prereleases (-beta/-rc), and no addon-image or extra
// addon. The manifest is an independently authored oracle; the filesystem is
// the system under test, so drift between the two is a real failure.

interface PkgJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const readPkg = (p: string): PkgJson | undefined => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PkgJson;
  } catch {
    return undefined;
  }
};

const collectXtermDeps = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const visit = (pkgPath: string): void => {
    const pkg = readPkg(pkgPath);
    if (pkg === undefined) return;
    for (const section of [pkg.dependencies, pkg.devDependencies] as const) {
      if (section === undefined) continue;
      for (const [name, version] of Object.entries(section)) {
        if (name.startsWith("@xterm/")) out[name] = version;
      }
    }
  };
  visit(join(process.cwd(), "package.json"));
  for (const dir of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(process.cwd(), dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      visit(join(process.cwd(), dir, entry, "package.json"));
    }
  }
  return out;
};

describe("RT-TERM-01 terminal package allowlist", () => {
  it("repo @xterm/* deps equal the pinned manifest (exact versions, no ranges/prereleases)", () => {
    expect(collectXtermDeps()).toEqual(TERMINAL_PACKAGE_SET);
  });
});
