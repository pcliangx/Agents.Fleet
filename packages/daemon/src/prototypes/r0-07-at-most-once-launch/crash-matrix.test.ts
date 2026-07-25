// R0-07 — RT-T-11 crash matrix: start / retry / resume × every boundary
// between two RT-LAUNCH-01..08 steps + the RT-LAUNCH-08 verification-failure
// and CommitLaunch-delivery-unknown boundaries. The coordinator is SIGKILLed
// as a real process; Reconciliation runs from a NEW process; assertions are
// made from this independent orchestrator (global ps scan + durable files).

import { describe, expect, it } from "vitest";
import { type CommandKind, CRASH_POINTS, type CrashPoint } from "./coordinator.js";
import { allChecksPass, runScenario } from "./driver.js";

const KINDS: readonly CommandKind[] = ["start", "retry", "resume"];

/** Expected convergence shape per crash point (see probe doc matrix). */
const CONTINUED: readonly CrashPoint[] = ["afterCommandTx", "afterLaunchTx"];
const FAILED_THEN_RETRIED: readonly CrashPoint[] = [
  "afterBootstrapSpawn",
  "afterAuthorizeTx",
  "afterRevalidationPass",
  "afterRevalidationFail",
];
const RESOLVED_RUNNING: readonly CrashPoint[] = ["afterCommitSent", "afterAgentObserved"];

const TIMEOUT = 90_000;

describe("R0-07 at-most-once launch — RT-T-11 crash matrix", () => {
  for (const kind of KINDS) {
    describe(`kind=${kind}`, () => {
      it.concurrent(
        "baseline: no crash → Running, exactly one agent",
        async () => {
          const e = await runScenario({ kind, crashPoint: null });
          expect(allChecksPass(e), JSON.stringify(e.checks)).toBe(true);
          expect(e.reconcileActions.map((a) => a.action)).toContain("already-running");
        },
        TIMEOUT,
      );

      for (const crashPoint of CRASH_POINTS) {
        it.concurrent(
          `crash ${crashPoint}`,
          async () => {
            const e = await runScenario({ kind, crashPoint });
            expect(allChecksPass(e), JSON.stringify(e.checks)).toBe(true);
            expect(e.crashedAtMarker).toBe(`crashed-at-${crashPoint}`);

            const actions = e.reconcileActions.map((a) => a.action);
            if (CONTINUED.includes(crashPoint)) {
              // RT-LAUNCH-05 — the SAME handshake continues; no second Attempt.
              const expected =
                crashPoint === "afterCommandTx"
                  ? "continued-from-queued"
                  : "continued-from-prepared";
              expect(actions).toContain(expected);
              const original = e.dbDump.attempts.find((a) => a.attempt_id === `att-cmd-${kind}-1`);
              expect(original?.status).toBe("Running");
            }
            if (FAILED_THEN_RETRIED.includes(crashPoint)) {
              if (crashPoint === "afterRevalidationFail") {
                // The abort tx committed BEFORE the crash (RT-LAUNCH-08):
                // Reconciliation has nothing to undo — the Aborted intent and
                // Failed attempt are already durable; the orphaned bootstrap
                // is left to self-timeout (no AbortLaunch was ever sent).
                const intent = e.dbDump.launchIntents.find(
                  (i) => i.attempt_id === `att-cmd-${kind}-1`,
                );
                expect(intent?.status).toBe("Aborted");
                expect(intent?.abort_reason).toBe("fact-drift");
                expect(e.bootstrapExits.some((b) => b.reason === "daemon-gone-timeout")).toBe(true);
              } else {
                expect(
                  actions.some(
                    (a) => a === "aborted-bootstrap-lost" || a === "aborted-commit-never-sent",
                  ),
                ).toBe(true);
              }
              // Aborted nonce evidence: the orphaned bootstrap self-timed-out
              // or took the AbortLaunch; it never exec'd an agent.
              expect(e.bootstrapExits.length).toBeGreaterThan(0);
              expect(
                e.bootstrapExits.every((b) => b.exitCode !== 0 || b.reason === "committed"),
              ).toBe(true);
            }
            if (RESOLVED_RUNNING.includes(crashPoint)) {
              // RT-LAUNCH-06 — resolved by receipt + full-identity probe.
              expect(actions).toContain("resolved-running-via-probe");
            }
          },
          TIMEOUT,
        );
      }

      it.concurrent(
        "crash afterCommitSent + agent killed → Uncertain, never Aborted, no replacement",
        async () => {
          const e = await runScenario({
            kind,
            crashPoint: "afterCommitSent",
            killAgentBeforeReconcile: true,
          });
          expect(allChecksPass(e), JSON.stringify(e.checks)).toBe(true);
          expect(e.reconcileActions.map((a) => a.action)).toContain(
            "uncertain-commit-delivery-unknown",
          );
          const intent = e.dbDump.launchIntents.find((i) => i.attempt_id === `att-cmd-${kind}-1`);
          expect(intent?.status).toBe("Authorized"); // RT-LAUNCH-08 tail: NOT Aborted
        },
        TIMEOUT,
      );
    });
  }
});
