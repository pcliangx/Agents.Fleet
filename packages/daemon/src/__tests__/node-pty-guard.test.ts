import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// D8 — node-pty must not be imported anywhere until #9/#10 introduce it
// (RT-TERM-08 / SV1-AUTH-09).

const IMPORT_RE = /from\s+['"]node-pty['"]|require\(\s*['"]node-pty['"]\s*\)/;

const safeStat = (p: string): ReturnType<typeof statSync> | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

const walkTs = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const p = join(dir, entry);
    const s = safeStat(p);
    if (s === undefined) continue;
    if (s.isDirectory()) out.push(...walkTs(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
};

describe("D8 node-pty guard", () => {
  it("no source file under packages/ or apps/ imports node-pty", () => {
    const offenders: string[] = [];
    for (const root of ["packages", "apps"]) {
      for (const file of walkTs(join(process.cwd(), root))) {
        if (IMPORT_RE.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
