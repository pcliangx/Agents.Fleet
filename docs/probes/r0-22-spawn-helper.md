# R0-22 node-pty spawn-helper exec-bit + signature verifier

Issue: [#22](https://github.com/pcliangx/Agents.Fleet/issues/22)

## Question

node-pty 1.1.0 ships its prebuilt `spawn-helper` with mode `0644` (no executable
bit), and npm 11 `allow-scripts` blocks the lifecycle script that would restore
`+x`, so `pty.spawn` fails with `posix_spawnp failed.` (EACCES). Can Agents.Fleet
explicitly verify the helper's executable bit, architecture, signature and hash,
and apply a `chmod` repair as an owned downstream patch (SV1-SUPPLY-02) without
relying on an npm lifecycle — fail-closed on a wrong-arch, tampered, or under-signed binary?

## Canonical contracts

- `docs/specs/runtime-contracts-v1.md`: RT-DIST-01 (release manifest locks + signs
  native artifacts incl. `spawn-helper`)
- `docs/specs/security-v1.md`: SV1-SUPPLY-02 (downstream patch has owner, source,
  hash, regression fixture, deletion condition), SV1-SUPPLY-03 (code-signing,
  notarization, hardened runtime)
- `SupportedPlatformMatrix.nodePtyArtifactIdentity` (RT-DIST-08, frozen in R0-15)

## Implementation

- `packages/daemon/src/native-artifact/spawn-helper-verifier.ts` — pure verifier:
  - `verifySpawnHelper(observed, expected) → { ready, problems[] }`. Checks the
    executable bit (`mode & 0o111`), architecture, signature strength, and
    (when pinned) hash. Problems: `missing`, `missingExecutableBit`,
    `architectureMismatch`, `signatureMissing`, `signatureTooWeak`, `hashMismatch`.
  - `repairSpawnHelper(verdict) → { permitted, action? }`. The `chmod 0755` repair
    is permitted **only** when the executable bit is the sole problem — never for
    a wrong-architecture, tampered (hash mismatch), or under-signed helper, and
    never when already launch-ready. This makes release (adhoc vs developer-id)
    fail-closed to chmod: a release adhoc helper must be re-signed, not chmod'd.
- `packages/daemon/src/native-artifact/spawn-helper-sampler.ts` — observes the
  installed helper via an injectable probe (`stat` mode, `file -b` architecture,
  `codesign -dv` signature kind, SHA-256) and pure parsers
  (`parseArchitecture`, `parseSignatureKind`). `codesign` writes to stderr, so the
  real runner uses `spawnSync` and merges streams.
- `packages/daemon/src/prototypes/r0-22-spawn-helper/evidence.ts` — `pnpm
  prototype:r0-22`: samples the real installed helper, runs the verifier,
  reproduces the pre-repair `posix_spawnp failed.` on a disposable copy, proves
  the `chmod 0755` repair enables a real `pty.spawn`, and records the
  SV1-SUPPLY-02 downstream patch. The installed package and pnpm store are never
  mutated (the repair proof uses a temporary copy, as in r0-10).
- `packages/daemon/src/__tests__/node-pty-guard.test.ts` — the R0-10
  production-source boundary now also excludes `src/prototypes/` (dev scaffolding,
  like `src/__tests__/`), since a prototype legitimately references `node-pty`
  without entering the Daemon's production import graph. The boundary the real
  loader must satisfy (RT-TERM-08 / SV1-AUTH-09) is unchanged.

## TDD evidence

Two pre-agreed seams, both tested through their public surface:

1. `verifySpawnHelper` / `repairSpawnHelper` — accept/reject + repair policy.
2. `sampleSpawnHelper` (+ pure parsers) — parsing of real `file` / `codesign`
   output via an injected probe.

Targeted results (`packages/daemon/src/__tests__/`):

- 3 test files / 26 tests passed (verifier 13, sampler 13)
- the shipped `0o444` helper is diagnosed `not ready` with the sole problem
  `missingExecutableBit`, and the repair is permitted (`chmod 0755`)
- a launch-ready helper (exec bit + arm64 + adhoc + matching hash) passes
- `missing`, `missingExecutableBit`, `architectureMismatch`, `signatureMissing`,
  `signatureTooWeak` (adhoc vs developer-id), and `hashMismatch` each report
  correctly
- repair is blocked when any non-exec problem is present (architecture, hash,
  release-signature); not-needed when ready
- the sampler parses real captured outputs and yields `exists=false` / null fields
  for a missing or unreadable helper
- the node-pty package boundary guard still passes (9/9) with prototypes excluded

Machine-readable observations are in `docs/probes/r0-22/evidence.json`.

Full repository verification:

- `pnpm typecheck`: PASS
- `pnpm test`: **386 passed / 1 failed** — the single failure is the pre-existing
  `apps/desktop/src/__tests__/fuses.test.ts` Electron-fuse test, unchanged by this
  slice (no `apps/desktop` change; fails identically on `main`). All daemon,
  transport, contracts and terminal tests pass.
- `pnpm prototype:r0-22`: PASS — installed helper `0o644`/arm64/adhoc → verdict
  `missingExecutableBit` → repair permitted → pre-repair spawn fails with
  `posix_spawnp failed.` → post-`chmod 0755` spawn PASS
- `pnpm lint`: R0-22 files PASS (pre-existing formatter notices in two R0-09
  terminal files left untouched).

## Verdict

The #22 spawn-helper verification is **PASS**:

- a pure verifier diagnoses the shipped `0644` helper as not launch-ready
  (`missingExecutableBit`) and permits the `chmod 0755` repair as the owned
  downstream patch;
- the repair is fail-closed for any other problem (wrong arch, tampered hash,
  under-signed), so release cannot chmod around a missing developer-id signature;
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
