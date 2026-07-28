# R1 exit test traceability

This document is a non-normative index for the R1 exit list in
[`docs/specs/v1.md`](specs/v1.md) and issue #53. The requirement text remains owned by the
canonical specs. Each row points to the primary executable fixtures that exercise the ID; a
requirement may be composed from more than one test file.

The mapped suite was run with:

- `pnpm test` — 95 test files, 782 tests passed
- `pnpm typecheck` — passed
- `pnpm lint` — passed with the repository's existing Biome schema notices and one existing
  `packages/terminal/browser/index.html` warning
- Node 24.18.0, pnpm 11.17.0, `matrixVersion = 4`, `runtimeLimitProfileVersion = 1`

## Runtime contract tests

| ID | Primary executable fixtures |
| --- | --- |
| RT-T-01 | `apps/desktop/src/__tests__/desktop-lifecycle-e2e.test.ts` |
| RT-T-02 | `apps/desktop/src/__tests__/desktop-lifecycle-e2e.test.ts` |
| RT-T-03 | `packages/daemon/src/session-runtime/session-runtime.test.ts`; `apps/desktop/src/main/reconnecting-attachment-stream.test.ts`; `apps/desktop/src/main/attachment-port-binding.test.ts` |
| RT-T-04 | `packages/daemon/src/__tests__/review-fixes.test.ts`; `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/worktree-manager/worktree-manager.test.ts` |
| RT-T-05 | `packages/daemon/src/session-runtime/session-runtime.test.ts`; `apps/desktop/src/main/attachment-port-binding.test.ts` |
| RT-T-06 | `packages/daemon/src/session-runtime/session-runtime.test.ts` |
| RT-T-07 | `packages/daemon/src/session-runtime/session-runtime.test.ts`; `packages/transport/src/__tests__/session-stream-consumer.test.ts` |
| RT-T-08 | `packages/daemon/src/__tests__/daemon-startup-reconciliation.test.ts`; `packages/testing/src/__tests__/daemon-crash-behavior.test.ts` |
| RT-T-09 | `packages/daemon/src/__tests__/daemon-startup-reconciliation.test.ts`; `packages/daemon/src/__tests__/command-surface.test.ts` |
| RT-T-10 | `packages/daemon/src/prototypes/r0-14-chunk-durability/crash-matrix.test.ts`; `packages/daemon/src/session-runtime/byte-journal.test.ts`; `packages/daemon/src/session-runtime/store-reconciliation.test.ts` |
| RT-T-11 | `packages/daemon/src/prototypes/r0-07-at-most-once-launch/crash-matrix.test.ts`; `packages/daemon/src/startup-reconciliation.test.ts` |
| RT-T-12 | `packages/daemon/src/__tests__/database.test.ts`; `packages/daemon/src/__tests__/review-fixes.test.ts`; `packages/daemon/src/session-runtime/store-reconciliation.test.ts`; `packages/daemon/src/session-runtime/session-runtime.test.ts` |
| RT-T-13 | `packages/contracts/src/lifecycle/__tests__/attempt.test.ts`; `packages/daemon/src/session-runtime/session-runtime.test.ts`; `packages/daemon/src/task-orchestrator/task-orchestrator.test.ts` |
| RT-T-14 | `packages/daemon/src/fleet-projection/fleet-projection.test.ts`; `packages/daemon/src/__tests__/task-store.test.ts` |
| RT-T-17 | `packages/daemon/src/session-runtime/session-runtime.test.ts` |
| RT-T-24 | `packages/daemon/src/prototypes/r0-14-chunk-durability/crash-matrix.test.ts`; `packages/daemon/src/session-runtime/input-intent-store.test.ts` |
| RT-T-25 | `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/__tests__/confirmation-e2e.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts` |
| RT-T-29 | `packages/daemon/src/__tests__/restricted-git.test.ts`; `packages/daemon/src/host-environment/host-environment.test.ts` |
| RT-T-32 | `packages/daemon/src/__tests__/node-pty-native.test.ts`; `packages/daemon/src/session-runtime/byte-journal.test.ts`; `packages/transport/src/__tests__/binary-frame.test.ts` |
| RT-T-36 | `packages/daemon/src/__tests__/trust-chain-e2e.test.ts`; `packages/daemon/src/__tests__/trust-service.test.ts`; `packages/daemon/src/__tests__/restricted-git.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts` |
| RT-T-37 | `packages/daemon/src/__tests__/task-store.test.ts`; `packages/daemon/src/storage/agent-profile-store.test.ts`; `packages/daemon/src/storage/environment-snapshot-store.test.ts`; `packages/daemon/src/agent-profile/profile-secret-resolver.test.ts` |
| RT-T-38 | `packages/daemon/src/worktree-manager/worktree-manager.test.ts`; `packages/daemon/src/__tests__/provision-worktree.test.ts`; `packages/daemon/src/session-runtime/session-runtime.test.ts` |
| RT-T-39 | `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/worktree-manager/worktree-manager.test.ts` |
| RT-T-41 | `packages/daemon/src/__tests__/command-surface.test.ts` |
| RT-T-46 | `packages/contracts/src/__tests__/limit-guard.test.ts`; `packages/contracts/src/__tests__/frozen-runtime-limit-profile.test.ts`; `apps/desktop/src/main/desktop-bridge.test.ts`; `packages/daemon/src/storage/agent-profile-store.test.ts` |

## Security contract tests

| ID | Primary executable fixtures |
| --- | --- |
| SV1-T-01 | `packages/daemon/src/__tests__/restricted-git.test.ts`; `packages/daemon/src/__tests__/trust-service.test.ts`; `packages/daemon/src/__tests__/trust-chain-e2e.test.ts` |
| SV1-T-02 | `packages/daemon/src/worktree-manager/filebroker.test.ts` |
| SV1-T-03 | `packages/daemon/src/__tests__/handshake-e2e.test.ts`; `packages/daemon/src/__tests__/keychain-capability-proof-verifier.test.ts`; `packages/transport/src/__tests__/capability-proof.test.ts`; `packages/transport/src/__tests__/handshake-state.test.ts` |
| SV1-T-04 | `apps/desktop/src/__tests__/electron-boundary.test.ts`; `apps/desktop/src/main/desktop-bridge-ipc.test.ts`; `packages/daemon/src/__tests__/control-dispatcher-routing.test.ts` |
| SV1-T-05 | `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/storage/agent-profile-store.test.ts`; `packages/daemon/src/host-environment/host-environment.test.ts` |
| SV1-T-06 | `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/__tests__/confirmation-e2e.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts` |
| SV1-T-07 | `packages/daemon/src/agent-adapters/claude-code-adapter.test.ts`; `packages/terminal/src/__tests__/headless-surface.test.ts`; `apps/desktop/src/main/desktop-bridge.test.ts` |
| SV1-T-08 | `packages/daemon/src/agent-profile/profile-secret-resolver.test.ts`; `packages/daemon/src/storage/agent-profile-store.test.ts`; `packages/daemon/src/agent-adapters/claude-code-adapter.test.ts`; `packages/daemon/src/__tests__/command-surface.test.ts` |
| SV1-T-17 | `packages/daemon/src/worktree-manager/filebroker.test.ts` |
| SV1-T-18 | `packages/daemon/src/worktree-manager/worktree-manager.test.ts` |
| SV1-T-19 | `packages/daemon/src/__tests__/node-pty-native.test.ts`; `packages/daemon/src/session-runtime/byte-journal.test.ts`; `packages/daemon/src/session-runtime/input-intent-store.test.ts`; `packages/daemon/src/session-runtime/session-runtime.test.ts` |
| SV1-T-20 | `packages/daemon/src/session-runtime/input-intent-store.test.ts`; `packages/daemon/src/session-runtime/session-runtime.test.ts`; `packages/daemon/src/fleet-projection/fleet-projection.test.ts` |
| SV1-T-22 | `packages/daemon/src/__tests__/restricted-git.test.ts`; `packages/daemon/src/host-environment/host-environment.test.ts`; `packages/daemon/src/agent-adapters/claude-code-adapter.test.ts`; `packages/daemon/src/__tests__/trust-service.test.ts` |
| SV1-T-25 | `packages/daemon/src/__tests__/command-surface.test.ts`; `packages/daemon/src/__tests__/confirmation-e2e.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts` |
| SV1-T-26 | `packages/daemon/src/worktree-manager/filebroker.test.ts`; `packages/daemon/src/__tests__/provision-worktree.test.ts`; `packages/daemon/src/__tests__/restricted-git.test.ts`; `packages/daemon/src/__tests__/command-surface.test.ts` |
| SV1-T-27 | `packages/daemon/src/__tests__/provision-worktree.test.ts` |
| SV1-T-28 | `packages/daemon/src/__tests__/confirmation-e2e.test.ts`; `packages/transport/src/__tests__/confirmation-broker.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts`; `packages/daemon/src/__tests__/command-surface.test.ts` |
| SV1-T-29 | `packages/daemon/src/__tests__/trust-chain-e2e.test.ts`; `packages/daemon/src/__tests__/trust-service.test.ts`; `apps/desktop/src/main/confirmation-ipc.test.ts`; `packages/daemon/src/__tests__/restricted-git.test.ts` |

## Qualification boundary

This index makes the automated R1 evidence reviewable, but it does not turn `pnpm test` into
hardware qualification. RT-PERF budgets and any acceptance that explicitly requires the lowest
SupportedPlatformMatrix hardware still need a separately captured run on that target.
