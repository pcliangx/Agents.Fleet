# R0-07 At-most-once Launch Prototype

> PROTOTYPE — throwaway evidence code, not the R1 Session Runtime.

This prototype asks whether the RT-LAUNCH-01..08 handshake (inert bootstrap +
one-shot `CommitLaunch` + durable receipt) survives a Daemon crash at any
protocol boundary: no partial Attempt / Worktree binding, no duplicate Agent,
and no resurrection of an Aborted nonce (RT-T-11).

Layout:

- `schema.ts` — authoritative store DDL (real `node:sqlite`, WAL + FULL).
- `coordinator.ts` — Daemon-side protocol steps; one SQLite transaction per
  step, spawn/CommitLaunch strictly between transactions, 8 crash points.
- `reconcile.ts` — Reconciliation run from a NEW process after the crash.
- `children/bootstrap.mjs` — inert bootstrap (plain node; atomic O_EXCL
  receipt; waits for one-shot CommitLaunch; self-times-out when the Daemon
  disappears). CommitLaunch/AbortLaunch IPC is atomic-rename files: a FIFO
  would couple the writer to the reader's poll loop, a signal can't carry the
  nonce, and rename atomicity lets Reconciliation distinguish "CommitLaunch
  definitely not sent" (file absent) from "delivery unknown" (file present) —
  the exact distinction RT-LAUNCH-08 requires.
- `children/fake-agent.mjs` — heartbeat agent for "exactly one agent" checks.
- `children/coordinator-child.ts` / `children/reconcile-child.ts` — the two
  real processes the crash harness drives.
- `driver.ts` — scenario runner (seed → doomed coordinator → new-process
  Reconciliation → independent assertion).
- `evidence.ts` — writes `docs/probes/r0-07/evidence-at-most-once-launch.json`.

Run the full 30-scenario crash matrix and regenerate evidence:

```sh
pnpm prototype:r0-07
```

Run the tests:

```sh
pnpm test
```
