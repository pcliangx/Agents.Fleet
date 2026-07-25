// RT-TERM-01 — the only @xterm/* packages the repo may depend on, at exact
// pinned versions. This is the single source of truth the package-allowlist
// guard checks every package.json against.
//
// Versions are a reviewed, mutually aligned set. xterm.js addons declare no
// peerDependencies on @xterm/xterm, so core/addon alignment is by the
// project's release coordination rather than a machine-checked range — the
// pinning itself (plus the dual-path + Snapshot fixtures) is what makes the
// alignment verifiable. Prereleases are forbidden (RT-TERM-01
// "不跟随未锁定的 prerelease").
//
// addon-unicode11 is load-bearing: xterm 6 core width tables mark some emoji
// (e.g. 😀) as width 1, which misaligns the terminal; this addon supplies the
// Unicode 11 width/grapheme tables. The live Terminal and the headless
// Snapshot Worker must load the same version or their grids diverge.
//
// DEFERRED — RT-TERM-01 also requires the build manifest to record
// terminalSchemaVersion and any patch-set hash, and SV1-TERM-01 requires an
// SBOM. Those are owned by the build / release-manifest task (RT-DIST-01 /
// SV1-SUPPLY-01) and are NOT produced by this slice; this file pins versions +
// lockfile integrity only. There is currently no downstream xterm patch, so
// no patch-set hash applies yet.

export const TERMINAL_PACKAGE_SET = {
  "@xterm/xterm": "6.0.0",
  "@xterm/headless": "6.0.0",
  "@xterm/addon-webgl": "0.19.0",
  "@xterm/addon-serialize": "0.14.0",
  "@xterm/addon-unicode11": "0.9.0",
} as const satisfies Readonly<Record<string, string>>;
