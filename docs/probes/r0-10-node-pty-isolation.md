# R0-10 node-pty isolation

Issue: [#9](https://github.com/pcliangx/Agents.Fleet/issues/9)

## Question

Can Agents.Fleet keep `node-pty` inside the Daemon's private
`ProcessSupervisor`, preserve raw PTY byte semantics, and prevent Electron Main
or Renderer from acquiring the native addon through a package or source import?

## Canonical contracts

- `docs/specs/v1.md`: process model, Session Runtime, terminal architecture,
  R0 node-pty isolation deliverable
- `docs/specs/runtime-contracts-v1.md`: `RT-MOD-03`, `RT-MOD-13`,
  `RT-TERM-08`, `RT-T-32`
- `docs/specs/security-v1.md`: `SV1-AUTH-08`, `SV1-AUTH-09`, `SV1-T-14`
- `docs/adr/0003-upstream-first-terminal.md`

## Implementation

- `node-pty` is pinned to `1.1.0` as a runtime dependency of
  `@agents-fleet/daemon` only.
- The only source loader is
  `packages/daemon/src/session-runtime/process-supervisor.ts`.
- The loader is lazy. Importing the module or running unit tests does not load
  the native addon.
- The Daemon-private seam exposes app-owned request and process types. No
  `node-pty` type, PTY fd, socket, or native object crosses the seam.
- Spawn always supplies `encoding: null`.
- Output accepts only `Uint8Array` / `Buffer`. A decoded string fails closed by
  stopping publication and terminating that PTY.
- Input remains bytes through the seam. A successful write only means the PTY
  owner accepted the bytes; it does not claim that the Agent consumed them.
- Resize and terminate are owned by the supervised process handle.
- A production-source guard scans source plus available Desktop build output
  from a stable repository root and requires the `node-pty` module-literal set
  to equal the one allowed Daemon file.
- Every current workspace manifest, including the root, is checked across
  runtime, development, optional, and peer dependency sections. The only
  allowed declaration is the exact Daemon runtime dependency.
- A sanitized independent Node process rooted at the Desktop manifest proves
  that Desktop cannot resolve either `node-pty` or `@agents-fleet/daemon`.
- The typed preload capability object has exactly one command-named method and
  exposes no generic IPC, PTY, socket, fd, or native object.
- A real sandboxed, context-isolated Electron Renderer compromise fixture
  verifies that `require` and `process` are absent and dynamic
  `import("node-pty")` is rejected.

## TDD evidence

The implementation was built as vertical red-green slices against two
pre-agreed seams:

1. Daemon-private `ProcessSupervisor` behavior.
2. Repository package/import boundary.

Targeted result:

- 5 test files passed
- 18 tests passed
- raw NUL, invalid UTF-8, and a multibyte sequence split across chunks retain
  their exact bytes and chunk boundaries
- decoded text terminates the affected PTY and no later output is published
- write, resize, and terminate are observable only through the app-owned handle
- the loader and dependency ownership guards pass
- static import, type-only import, side-effect import, dynamic import, and
  CommonJS require syntax, including an aliased loader call, are detected by
  the boundary guard
- a real node-pty process emits the hostile Buffer fixture without byte loss;
  its raw SHA-256 remains
  `0e94bd7e52cb67fb1255a75a0c98112b748d360fa14d96a278a22828aa26ccf8`
  before and after display decoding introduces replacement characters
- the independent Desktop resolver, typed preload surface, and real sandboxed
  Renderer compromise fixture all reject native capability acquisition

Machine-readable observations are in
`docs/probes/r0-10/evidence.json`.

Full repository verification:

- `pnpm typecheck`: PASS
- `pnpm test`: PASS — 22 files / 110 tests
- `pnpm lint`: PASS — only the pre-existing repository warning and infos
- `git diff --check`: PASS

## Native artifact observation

Environment:

- macOS 26.5.2 (25F84), Apple Silicon
- Node v26.4.0
- pnpm 10.33.2
- Electron 34.5.8
- `node-pty` 1.1.0

The native module loads and exposes `spawn`. The installed
`prebuilds/darwin-arm64/spawn-helper` is a thin arm64 Mach-O with an ad-hoc
linker signature, but is installed with mode `0644`. A real
`pty.spawn("/bin/echo", ...)` therefore fails with `posix_spawnp failed.`

This reproduces the independent supply-chain finding tracked by
[#22](https://github.com/pcliangx/Agents.Fleet/issues/22). This slice does not
apply `chmod` to the installed package, mutate the pnpm store, or claim release
spawn readiness.

For the #9 runtime proof only, the test copies the installed `node-pty` package
to a unique temporary directory, changes the copied helper to `0755`, runs a
real Apple Silicon PTY, verifies hostile bytes and checksum, then removes the
copy. The source package and pnpm store remain unchanged. This proves the
runtime byte boundary without pretending that the release installer has fixed
#22.

## Verdict

The #9 isolation boundary is **PASS**:

- native PTY ownership is confined to the Daemon ProcessSupervisor;
- Electron Main and Renderer cannot acquire it through production source,
  workspace dependencies, Node package resolution, the typed preload surface,
  or a real sandboxed Renderer;
- real node-pty output preserves the hostile raw Buffer and checksum; display
  replacement does not mutate the recovery source;
- the seam fails closed on decoded output.

Native artifact spawn readiness remains **BLOCKED BY #22** until installation
and release validation explicitly prove executable mode, signature, hash,
architecture, and notarization.

## Non-guarantees

This slice does not prove:

- at-most-once launch or duplicate-spawn recovery — #7;
- Session lifecycle persistence, reconciliation, or process identity
  re-identification;
- Input Intent durability and crash boundaries — #16;
- FileBroker or Electron control boundary hardening — #10;
- release artifact installation, signing, or helper repair — #22;
- frozen SupportedPlatformMatrix acceptance — #14.
