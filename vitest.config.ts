import { configDefaults, defineConfig } from "vitest/config";

// Vitest 4 removed `vitest.workspace.ts` / `defineWorkspace` (renamed to
// `test.projects`) and narrowed the default `exclude` to node_modules/.git
// only (no longer dist). Each package tests its own src; packages resolve from
// source (exports → ./src), so no pre-build is required. Global exclude adds
// dist back so the compiled `**/*.test.js` from `tsc -b` never runs alongside
// the source tests.
const projects: ReadonlyArray<readonly [string, string]> = [
  ["contracts", "packages/contracts/src/**/*.test.ts"],
  ["terminal", "packages/terminal/src/**/*.test.ts"],
  ["transport", "packages/transport/src/**/*.test.ts"],
  ["testing", "packages/testing/src/**/*.test.ts"],
  ["daemon", "packages/daemon/src/**/*.test.ts"],
  ["desktop", "apps/desktop/src/**/*.test.ts"],
  ["scripts", "scripts/**/*.test.mjs"],
];

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**"],
    projects: projects.map(([name, include]) => ({
      extends: true,
      test: { name, include },
    })),
  },
});
