import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// R0-10 — node-pty may be loaded only by the Daemon's private
// ProcessSupervisor (RT-TERM-08 / SV1-AUTH-09).

const NODE_PTY_LITERAL_RE = /['"]node-pty['"]/;
const ALLOWED_LOADER = "packages/daemon/src/session-runtime/process-supervisor.ts";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const THIS_TEST = fileURLToPath(import.meta.url);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".html"];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const safeStat = (p: string): ReturnType<typeof statSync> | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

const walkSources = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    const s = safeStat(p);
    if (s === undefined) continue;
    if (s.isDirectory()) out.push(...walkSources(p));
    else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) out.push(p);
  }
  return out;
};

const workspaceManifestPaths = (): string[] => [
  "package.json",
  ...["packages", "apps"].flatMap((root) =>
    readdirSync(join(REPOSITORY_ROOT, root))
      .map((entry) => join(root, entry, "package.json"))
      .filter((path) => safeStat(join(REPOSITORY_ROOT, path))?.isFile()),
  ),
];

describe("node-pty package boundary", () => {
  it.each([
    'import pty from "node-pty";',
    'import type { IPty } from "node-pty";',
    'import "node-pty";',
    'await import("node-pty");',
    'require("node-pty");',
    'const load = createRequire(import.meta.url); load("node-pty");',
  ])("recognizes node-pty module literals: %s", (source) => {
    expect(NODE_PTY_LITERAL_RE.test(source)).toBe(true);
  });

  it("loads node-pty only in the Daemon ProcessSupervisor", () => {
    // Production-source boundary only. `src/__tests__/` and `src/prototypes/`
    // are dev scaffolding (run via vitest / tsx), never in the Daemon's
    // production import graph, so a prototype may legitimately reference
    // node-pty (e.g. the r0-22 spawn-helper verifier) without weakening the
    // RT-TERM-08 / SV1-AUTH-09 boundary the real loader must satisfy.
    const loaders: string[] = [];
    for (const root of ["packages", "apps"]) {
      for (const file of walkSources(join(REPOSITORY_ROOT, root))) {
        if (
          file === THIS_TEST ||
          file.includes(`${join("src", "__tests__")}/`) ||
          file.includes(`${join("src", "prototypes")}/`)
        ) {
          continue;
        }
        if (NODE_PTY_LITERAL_RE.test(readFileSync(file, "utf8"))) {
          loaders.push(relative(REPOSITORY_ROOT, file));
        }
      }
    }
    expect(loaders).toEqual([ALLOWED_LOADER]);
  });

  it("pins node-pty as a Daemon-only runtime dependency", () => {
    const declarations = workspaceManifestPaths().flatMap((manifestPath) => {
      const manifest = JSON.parse(
        readFileSync(join(REPOSITORY_ROOT, manifestPath), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      return DEPENDENCY_SECTIONS.flatMap((section) => {
        const version = manifest[section]?.["node-pty"];
        return version === undefined ? [] : [{ manifestPath, section, version }];
      });
    });

    expect(declarations).toEqual([
      {
        manifestPath: "packages/daemon/package.json",
        section: "dependencies",
        version: "1.1.0",
      },
    ]);
  });

  it("prevents the Desktop package from resolving node-pty or the Daemon package", () => {
    const resolution = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `
            const { createRequire } = require("node:module");
            const desktopRequire = createRequire(process.argv[1]);
            const result = ["node-pty", "@agents-fleet/daemon"].map((specifier) => {
              try {
                return { specifier, resolved: desktopRequire.resolve(specifier) };
              } catch {
                return { specifier, resolved: null };
              }
            });
            process.stdout.write(JSON.stringify(result));
          `,
          join(REPOSITORY_ROOT, "apps/desktop/package.json"),
        ],
        {
          encoding: "utf8",
          env: {
            HOME: process.env.HOME ?? "/tmp",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? "/tmp",
          },
        },
      ),
    );

    expect(resolution).toEqual([
      { specifier: "node-pty", resolved: null },
      { specifier: "@agents-fleet/daemon", resolved: null },
    ]);
  });
});
