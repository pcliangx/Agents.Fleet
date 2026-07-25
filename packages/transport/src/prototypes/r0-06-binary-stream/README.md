# R0-06 Binary Stream Backpressure Prototype

> PROTOTYPE — throwaway evidence code, not a production stream implementation.

This prototype asks whether a per-Attachment bounded live queue can keep ten
Session streams isolated under the `RT-PERF-08` load, move a slow or hidden
Renderer onto an explicit Snapshot + delta resync path, and let healthy
Sessions continue consuming. It assumes every input frame is already durable;
it does not answer chunk fsync/crash recovery, terminal rendering, Snapshot
parser safety, or the final `RuntimeLimitProfile` values.

Run the interactive state model:

```sh
pnpm prototype:r0-06
```

Run the fixed 60-second benchmark:

```sh
pnpm prototype:r0-06:benchmark
```

For a short development pass or to capture JSON evidence:

```sh
pnpm --filter @agents-fleet/daemon exec tsx \
  ../transport/src/prototypes/r0-06-binary-stream/benchmark.ts \
  --duration 3 --out ../../docs/probes/r0-06/evidence-short.json
```

The portable part is `model.ts`. The TUI and benchmark are disposable shells
used to expose its state and measure the design.
