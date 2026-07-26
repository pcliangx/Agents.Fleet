# R0-15 SupportedPlatformMatrix freeze

Issue: [#14](https://github.com/pcliangx/Agents.Fleet/issues/14)

## Question

Can Agents.Fleet freeze a versioned `SupportedPlatformMatrix` for R0 — pinning
architecture, minimum macOS, minimum hardware, runtime / native / terminal
identity, renderer paths and policy versions — and prove an RT-DIST-09 host gate
that fail-closes with `UnsupportedPlatform` before any install / upgrade / launch
write when the host is below the floor?

## Canonical contracts

- `docs/specs/v1.md`: PLATFORM-1, R0 freeze of `SupportedPlatformMatrix`, R0
  Baseline exit gate
- `docs/specs/runtime-contracts-v1.md`: §11 `SupportedPlatformMatrix` schema,
  RT-DIST-08, RT-DIST-09, RT-PERF-08
- `docs/specs/security-v1.md`: SV1-SUPPLY-01, SV1-SUPPLY-02, SV1-T-21

## Frozen matrix (matrixVersion 1)

`packages/contracts/src/frozen-platform-matrix.ts` freezes:

| Field | Value | Provenance |
| --- | --- | --- |
| `matrixVersion` | `1` | this slice |
| `architecture` | `arm64` | PLATFORM-1 |
| `minimumMacOSVersion` | `"26"` (Tahoe) | product decision; current-only target |
| `minimumHardware` | `MacBookAir10,1` / `M1` / `apple-integrated` / `8589934592` (8 GiB) | M1 MacBook Air = lowest-config Apple Silicon; RT-PERF-08 budget floor |
| `electronVersion` | `"43.2.0"` | R0-10 (#57) |
| `nodeRuntimeVersion` | `"22.17.1"` | R0-10 (managed runtime) |
| `nodePtyArtifactIdentity` | `"node-pty@1.1.0;darwin-arm64"` | R0-10 |
| `terminalPackageSetIdentity` | 5-package canonical string (SHA-256 `022372a2…8b4546`) | R0-09; verified against `packages/terminal/package.json` |
| `runtimeLimitProfileVersion` | `0` | pending R0-16 (#15) — see Pending fields |
| `rendererPaths` | `["WebGL2","DOM"]` | spec |
| `keychainPolicyVersion` | `1` | R0-12 capability-proof scheme (#11); version pinned here |
| `signingAndNotarizationPolicyVersion` | `0` | pending R5 distribution |
| `evidenceRefs` | RT-DIST-08/09, PLATFORM-1, RT-T-45 + probe paths | spec |

`PLATFORM_MATRIX_VERSION` (= 1) replaces the former placeholder and is now the
value carried by the daemon handshake config, the Electron Main `ClientHello`
(`expectedPlatformMatrixVersion`), the capability-proof transcript, and the R0-06
benchmark provenance.

## Implementation

- `packages/contracts/src/platform-gate.ts` — pure, Node-free gate:
  - `checkPlatform(host, matrix) → { ok: true } | { ok: false, reason, detail }`.
    Checks, in order: architecture, operating system (darwin), macOS version
    floor, Apple-Silicon cpu generation, and memory floor. A below-floor host
    returns a typed `UnsupportedPlatformReason` the integration layer surfaces as
    the existing `UnsupportedPlatform` error code.
  - `appleSiliconGeneration(brand)` parses the M-generation from a cpu brand
    string (`"Apple M5 Pro" → 5`, `"M1" → 1`); M1 is generation 1, so any arm64
    Apple Mac is ≥ floor by construction — the real rejections are Intel, old
    macOS, low memory, non-Apple arm64, or non-darwin.
  - `sampleHostPlatform(runner, arch, osPlatform)` samples `sw_vers` /
    `sysctl` via an injectable `HostCommandRunner`. The module imports no Node
    builtins; the concrete `execFileSync` runner lives in the prototype below.
- `packages/contracts/src/frozen-platform-matrix.ts` — `FROZEN_PLATFORM_MATRIX`
  and `PLATFORM_MATRIX_VERSION` (above). The type stays in `platform.ts`.
- `packages/contracts/src/version.ts` — re-exports `PLATFORM_MATRIX_VERSION`;
  the limit-profile placeholder remains until R0-16.
- `packages/transport/src/prototypes/r0-06-binary-stream/{scenario,benchmark}.ts`
  — R0-06 provenance advanced from `unfrozen-r0-placeholder` to
  `matrix-frozen-limit-profile-pending`; results stay non-reusable until R0-16.
- `packages/transport/src/prototypes/r0-15-supported-platform-matrix/evidence.ts`
  — `pnpm prototype:r0-15`: samples this host with the real runner, runs the
  gate, verifies the frozen terminal identity against the declared
  `packages/terminal` dependencies, replays five synthetic below-floor hosts, and
  writes `docs/probes/r0-15/evidence.json`.

## TDD evidence

Two pre-agreed seams, both pure and tested through their public surface:

1. `checkPlatform` — accept/reject contract (RT-DIST-09 / RT-T-45).
2. `sampleHostPlatform` — parsing of real `sw_vers` / `sysctl` output via an
   injected runner.

Targeted results (`packages/contracts/src/__tests__/`):

- 2 test files / 26 tests passed
- the at-floor host (M1, 8 GiB, macOS 26.0) and the above-floor host (M5 Pro,
  48 GiB, macOS 26.5.2) both pass
- Intel x64 → `architecture`; macOS 15 → `macOSVersion`; 4 GiB → `memory`;
  non-Apple arm64 cpu → `cpuClass`; non-darwin → `operatingSystem`
- `appleSiliconGeneration` parses `Apple M1`/`M1 Pro`/`Apple M5 Pro`/`M2` and
  rejects Intel / Qualcomm / null
- the sampler parses real captured outputs and yields null macOS fields off darwin
- the frozen matrix round-trips: a host built from the matrix's own declared floor
  passes the gate; `matrixVersion === 1`; the terminal identity equals the
  R0-09 5-package set

Machine-readable observations are in `docs/probes/r0-15/evidence.json`.

Full repository verification:

- `pnpm typecheck`: PASS
- `pnpm test`: PASS — 36 files / 238 tests
- `pnpm prototype:r0-15`: PASS — host gate PASS, terminal identity matches
  declared deps
- `pnpm lint`: R0-15 files PASS. The repo carries pre-existing formatter
  diagnostics in two R0-09 terminal files (`packages/terminal/src/__browser__/
  webgl-dual-path.ts`, `packages/terminal/src/__tests__/fixtures.ts`) that this
  slice does not touch; they are left as-is to keep the diff scoped.

## Host sample observation

Environment (this Mac, above the floor):

- macOS 26.5.2 (25F84), Apple Silicon
- `Apple M5 Pro`, `Mac17,8`, 48 GiB (51539607552 bytes), arm64
- Electron 43.2.0, project Node v22.17.1, pnpm 10.33.2

The sampled host passes the gate. The frozen floor itself (M1 / 8 GiB / macOS 26)
is below this machine; RT-PERF-08 acceptance must be re-run on a real
lowest-config fixture before R1 (single-host sample here is not that fixture).

## Verdict

The R0-15 freeze is **PASS**:

- a versioned `SupportedPlatformMatrix` (v1) is frozen with concrete values and
  `evidenceRefs`, and is carried by the live handshake / capability proof /
  daemon config rather than a placeholder;
- the RT-DIST-09 host gate is pure, deterministic, fail-closed, and rejects every
  below-floor shape with a distinct `UnsupportedPlatformReason`;
- the frozen terminal identity is verified against the declared
  `packages/terminal` dependencies at evidence time;
- the contracts package stays free of Node-only imports.

## Pending fields (not gaps in this slice)

Per RT-DIST-08, freezing a pending field later produces a **new** `matrixVersion`
and re-runs affected fixtures; old results do not carry forward.

- `runtimeLimitProfileVersion` → R0-16 (issue #15). The matrix records `0`; when
  R0-16 freezes the limit profile, the matrix bumps to v2.
- `signingAndNotarizationPolicyVersion` → R5 distribution.

## Non-guarantees

This slice does not prove:

- installer / LaunchAgent / migration integration of the gate (RT-DIST-09 wiring
  into the real bootstrap path) — R5;
- real code signing / notarization policy — R5;
- frozen `RuntimeLimitProfile` values — R0-16 (#15);
- node-pty `spawn-helper` release readiness (executable mode, signature,
  notarization) — #22;
- lowest-config hardware acceptance — RT-PERF-08 must run on a real M1 / 8 GiB
  fixture; this Mac is above the floor.
