import { describe, expect, it } from "vitest";
import { AT_MOST_ONCE_LAUNCH_PROFILE } from "../fixtures/at-most-once-launch.js";

describe("R0-07 at-most-once launch fixture", () => {
  it("covers every boundary between two RT-LAUNCH-01..08 steps", () => {
    expect(AT_MOST_ONCE_LAUNCH_PROFILE.crashPoints.map((c) => c.crashPoint)).toEqual([
      "afterCommandTx",
      "afterLaunchTx",
      "afterBootstrapSpawn",
      "afterAuthorizeTx",
      "afterRevalidationPass",
      "afterRevalidationFail",
      "afterCommitSent",
      "afterAgentObserved",
    ]);
  });

  it("in EVERY crash point there is exactly one agent and no partial state (RT-T-11)", () => {
    for (const c of AT_MOST_ONCE_LAUNCH_PROFILE.crashPoints) {
      expect(c.exactlyOneAgent).toBe(true);
      expect(c.noPartialAttemptOrBinding).toBe(true);
      expect(c.idempotentReissue).toBe(true);
    }
  });

  it("records the RT-LAUNCH-08 tail: delivery unknown ⇒ Uncertain, never Aborted", () => {
    const i = AT_MOST_ONCE_LAUNCH_PROFILE.invariants;
    expect(i.deliveryUnknownYieldsUncertainNotAborted).toBe(true);
    expect(i.abortRefusedWhenCommitMayBeDelivered).toBe(true);
    expect(i.noAutoReplacementForUncertain).toBe(true);
    expect(i.abortedNonceNeverResurrected).toBe(true);
  });

  it("records bootstrap self-timeout and one-shot authorization (RT-LAUNCH-02/04/06)", () => {
    const b = AT_MOST_ONCE_LAUNCH_PROFILE.bootstrap;
    expect(b.receiptWrittenAtomicallyBeforeAuthorization).toBe(true);
    expect(b.duplicateNonceFailsOnExclusiveReceipt).toBe(true);
    expect(b.selfTimeoutOnDaemonGone).toBe(true);
    expect(b.acceptsAtMostOneCorrectAuthorization).toBe(true);
    expect(b.abortLaunchNeverExecs).toBe(true);
  });

  it("separates inferred implications and keeps them a subset of implications", () => {
    const all = AT_MOST_ONCE_LAUNCH_PROFILE.implications as readonly string[];
    const inferred = AT_MOST_ONCE_LAUNCH_PROFILE.inferredImplications;
    for (const key of inferred) expect(all).toContain(key);
    // directly-measured protocol facts are NOT in the inferred subset
    expect(inferred).not.toContain("command-and-launch-transactions-are-crash-atomic");
    expect(inferred).not.toContain("delivery-unknown-forbids-aborted-use-uncertain");
    expect(inferred).not.toContain("aborted-nonce-never-resurrected");
  });
});
