# R0-22 node-pty spawn-helper exec-bit + signature verifier

Issue: [#22](https://github.com/pcliangx/Agents.Fleet/issues/22)

## Question

node-pty 1.1.0 ships its prebuilt `spawn-helper` with mode `0644` (no executable
bit), and npm 11 `allow-scripts` blocks the lifecycle script that would restore
`+x`, so `pty.spawn` fails with `posix_spawnp failed.` (EACCES). Can Agents.Fleet
explicitly verify the helper's executable bit, architecture, **deployment target**,
signature and hash, and apply a `chmod` repair as an owned downstream patch
(SV1-SUPPLY-02) without relying on an npm lifecycle — fail-closed on a wrong-arch,
wrong-deployment-target, tampered, or under-signed binary?

## Decision (issue #22 待决)

Issue #22 asked whether to ship a standalone R0 prototype or fold the work into
#9/#10. **Standalone prototype**, because #9 (R0-10 node-pty isolation) is already
merged and RT-DIST-01 release-manifest work is R5; the spawn-helper verification
is a distinct, lifecycle-independent concern that needs its own regression fixture
now, with installer integration deferred to R5.

## Canonical contracts

- `docs/specs/runtime-contracts-v1.md`: RT-DIST-01 (release manifest locks + signs
  native artifacts incl. `spawn-helper`)
- `docs/specs/security-v1.md`: SV1-SUPPLY-02 (verify package integrity, native
  architecture, deployment target, minimum OS, no install-time network/script;
  downstream patch has owner, source, hash, regression fixture, deletion
  condition), SV1-SUPPLY-03 (code-signing, notarization, hardened runtime)
- `SupportedPlatformMatrix.nodePtyArtifactIdentity` + `minimumMacOSVersion`
  (RT-DIST-08, frozen in R0-15)

## Implementation

- `packages/daemon/src/native-artifact/spawn-helper-verifier.ts` — pure verifier:
  - `verifySpawnHelper(observed, expected) → { ready, problems[] }`. Checks the
    executable bit (`mode & 0o111`), architecture (`Architecture` union), Mach-O
    **deployment target ≤ matrix minimum macOS version** (so the binary loads on
    the lowest supported host), signature strength, and (when pinned) hash.
    Problems: `missing`, `missingExecutableBit`, `architectureMismatch`,
    `deploymentTargetAboveHostFloor`, `signatureMissing`, `signatureTooWeak`,
    `hashMismatch`.
  - `repairSpawnHelper(verdict) → { permitted, action? }`. The `chmod 0755` repair
    is permitted **only** when the executable bit is the sole problem — never for
    a wrong-arch, wrong-deployment-target, tampered, or under-signed helper.
    Release (adhoc vs developer-id) therefore fail-closes to chmod.
  - `SPAWN_HELPER_REPAIR_PATCH` — the SV1-SUPPLY-02 downstream-patch record
    (owner / source / patch / regression fixture / deletion condition /
    does-not-rely-on-npm-lifecycle), co-located with the repair it describes;
    `hash` is filled at runtime from the observed helper.
- `packages/daemon/src/native-artifact/spawn-helper-sampler.ts` — pure, Node-free
  (R0-15 platform-gate pattern). `sampleSpawnHelper` observes via an injectable
  probe; pure parsers `parseArchitecture` (`file -b`), `parseDeploymentTarget`
  (`vtool -show-build` LC_BUILD_VERSION `minos`), `parseSignatureKind`
  (`codesign -dv`).
- `packages/daemon/src/native-artifact/spawn-helper-probe.ts` — the real Node
  probe (`defaultProbeDeps`: stat / `spawnSync` for file+vtool+codesign / sha256),
  split out so the sampler imports no Node builtins.
- `packages/daemon/src/native-artifact/temp-node-pty-copy.ts` — shared
  `copyNodePtyWithHelperMode(mode)` helper (cp → chmod → require from a temp
  copy), used by both this prototype and the R0-10 native byte-boundary test.
- `packages/daemon/src/prototypes/r0-22-spawn-helper/evidence.ts` — `pnpm
  prototype:r0-22`: samples the real installed helper, runs the verifier against
  the frozen matrix floor, reproduces the pre-repair `posix_spawnp failed.` on a
  disposable copy, proves the `chmod 0755` repair enables a real `pty.spawn`, and
  records the patch (hash from the observed helper). The installed package and
  pnpm store are never mutated.
- `packages/daemon/src/__tests__/node-pty-guard.test.ts` — the R0-10
  production-source boundary now also excludes `src/prototypes/` (dev scaffolding,
  like `src/__tests__/`); the RT-TERM-08 / SV1-AUTH-09 boundary the real loader
  must satisfy is unchanged.

## TDD evidence

Two pre-agreed seams, both tested through their public surface:

1. `verifySpawnHelper` / `repairSpawnHelper` — accept/reject + repair policy.
2. `sampleSpawnHelper` (+ pure parsers) — parsing of real `file` / `vtool` /
   `codesign` output via an injected probe.

Targeted results (`packages/daemon/src/__tests__/`):

- verifier 17 tests, sampler 19 tests (36 total) passed
- the shipped `0o644` helper is diagnosed `not ready` with the sole problem
  `missingExecutableBit` (deployment target `11.0` ≤ matrix floor `26` → within
  floor), and the repair is permitted (`chmod 0755`)
- a launch-ready helper (exec bit + arm64 + minos 11.0 + adhoc) passes
- `deploymentTargetAboveHostFloor` fires when minos > floor (e.g. 27 > 26) and
  blocks the repair; a null deployment target is non-blocking (caller's gap)
- `architectureMismatch` (incl. the typed `Architecture` union), `signatureMissing`,
  `signatureTooWeak` (adhoc vs developer-id), and `hashMismatch` each report
  correctly; repair is blocked for any non-exec problem
- the sampler parses real captured outputs and yields null fields for a missing or
  unreadable helper
- the co-located `SPAWN_HELPER_REPAIR_PATCH` carries all five SV1-SUPPLY-02 fields
- the refactored R0-10 native byte-boundary test still passes via the shared helper

Machine-readable observations are in `docs/probes/r0-22/evidence.json`.

Full repository verification:

- `pnpm typecheck`: PASS
- `pnpm test`: all daemon / transport / contracts / terminal tests pass; the only
  failure is the pre-existing `apps/desktop/src/__tests__/fuses.test.ts`
  Electron-fuse test, unchanged by this slice (no `apps/desktop` change; fails
  identically on `main`).
- `pnpm prototype:r0-22`: PASS — installed helper `0o644` / arm64 / minos 11.0 /
  adhoc → verdict `missingExecutableBit` → repair permitted → pre-repair spawn
  fails with `posix_spawnp failed.` → post-`chmod 0755` spawn PASS
- `pnpm lint`: R0-22 files PASS (pre-existing formatter notices in two R0-09
  terminal files left untouched).

## Verdict

The #22 spawn-helper verification is **PASS**:

- a pure verifier diagnoses the shipped `0644` helper as not launch-ready
  (`missingExecutableBit`) and permits the `chmod 0755` repair as the owned
  downstream patch;
- the verifier now covers the full SV1-SUPPLY-02 native-artifact triplet checked
  here — architecture + deployment target (≤ matrix minimum macOS) — plus
  executable bit, signature strength and hash;
- the repair is fail-closed for any other problem (wrong arch, wrong deployment
  target, tampered hash, under-signed), so release cannot chmod around a missing
  developer-id signature;
- a real `pty.spawn` is reproduced to fail pre-repair and succeed post-repair on a
  disposable copy, without mutating the installed package or pnpm store;
- the verifier + sampler + regression proof give the Daemon install/upgrade path a
  lifecycle-independent way to validate and repair the helper (RT-DIST-01 /
  SV1-SUPPLY-02).

## Non-guarantees

This slice does not prove:

- real developer-id signing + notarization of the helper (SV1-SUPPLY-03) — adhoc
  only today;
- a release-manifest hash pin (RT-DIST-01) — the SHA-256 is recorded but not
  pinned; pinning is R5;
- installer / LaunchAgent / migration integration of the verify + repair step
  (RT-DIST-09 / RT-DIST-04 drain) — R5;
- that the Daemon actually applies the repair to the installed location at runtime
  (this slice proves the verifier + a controlled repair; the live wiring is R5);
- removal of the patch — its deletion condition is recorded but not yet automated.
