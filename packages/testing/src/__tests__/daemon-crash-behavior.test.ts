import { describe, expect, it } from "vitest";
import { DAEMON_CRASH_BEHAVIOR_PROFILE } from "../fixtures/daemon-crash-behavior.js";

const MODES = ["exit-normal", "sigterm", "sigkill"] as const;

describe("R0-03 daemon crash behavior fixture", () => {
  it("covers all three Daemon death modes", () => {
    expect(DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes.map((m) => m.mode)).toEqual([...MODES]);
  });

  it("in EVERY mode the child survives and is orphaned to pid 1 (RT-REC-07 Daemon crash)", () => {
    for (const m of DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes) {
      expect(m.childSurvived).toBe(true);
      expect(m.orphanedToPid1).toBe(true);
      expect(m.heartbeatContinued).toBe(true);
    }
  });

  it("proves even SIGKILL of the Daemon leaves the child alive (the strongest case)", () => {
    const sigkill = DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes.find((m) => m.mode === "sigkill");
    expect(sigkill?.childSurvived).toBe(true);
    expect(sigkill?.orphanedToPid1).toBe(true);
  });

  it("records SIGHUP delivery on PTY master close but not as a reliable kill (RT-REC-12 / RT-LAUNCH-06)", () => {
    for (const m of DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes) expect(m.sighupDelivered).toBe(true);
    const s = DAEMON_CRASH_BEHAVIOR_PROFILE.signalDelivery;
    expect(s.sighupDeliveredOnMasterClose).toBe(true);
    expect(s.sighupDoesNotGuaranteeChildDeath).toBe(true);
    expect(s.childDetectsMasterGoneViaStdoutError).toBe(true);
    // Real-agent survival is honestly unverified — marked inferred, not measured safe.
    expect(s.realAgentSurvivalDependsOnAgentSignalHandling).toBe(true);
  });

  it("records process-group semantics (pgid==pid, negative-pgid signal reaches child)", () => {
    const g = DAEMON_CRASH_BEHAVIOR_PROFILE.processGroupSemantics;
    expect(g.childIsOwnProcessGroupLeader).toBe(true);
    expect(g.pgidEqualsChildPid).toBe(true);
    expect(g.negativePgidSignalReachesChild).toBe(true);
    expect(g.sidSemanticsNotIndependentlyVerified).toBe(true);
  });

  it("requires pid+lstart re-identification; pid-alone stays unsafe (RT-REC-12)", () => {
    const r = DAEMON_CRASH_BEHAVIOR_PROFILE.reidentification;
    expect(r.fullIdentityPidPlusLstartReliable).toBe(true);
    expect(r.lstartStableAcrossCrash).toBe(true);
    // Not observed in window, but the risk is explicitly retained (can't prove a negative).
    expect(r.pidReuseNotObservedInProbeWindow).toBe(true);
    expect(r.pidReuseRemainsRiskDespiteNoObservation).toBe(true);
    expect(r.orphanStoppableFromNewProcess).toBe(true);
  });

  it("orphan stop escalates to SIGKILL (RT-STATE-22/23 StopRequested→ConfirmedStopped)", () => {
    const s = DAEMON_CRASH_BEHAVIOR_PROFILE.orphanStop;
    expect(s.sigtermByPidReached).toBe(true);
    expect(s.sigtermByPgidReached).toBe(true);
    expect(s.sigtermDidNotTerminateTrappingChild).toBe(true);
    expect(s.sigkillByPidTerminated).toBe(true);
    for (const m of DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes)
      expect(m.stopRequiredSigkill).toBe(true);
  });

  it("records the node-pty spawn-helper finding as MEASURED but out-of-scope for #3 (issue #22)", () => {
    const h = DAEMON_CRASH_BEHAVIOR_PROFILE.nodePtySpawnHelper;
    expect(h.outOfScopeForR003).toBe(true);
    expect(h.trackedInIssue).toBe(22);
    expect(h.shipsNonExecutable).toBe(true);
    expect(h.modeBeforeChmod).toBe("0o644");
    expect(h.modeAfterChmod).toBe("0o755");
    expect(h.npmAllowScriptsBlocksLifecycle).toBe(true);
    // MEASURED: a pre-chmod pty.spawn reproduced posix_spawnp failure (not inferred).
    expect(h.posixSpawnpFailsWithoutChmod).toBe(true);
    expect(h.posixSpawnpErrorObserved).toBe("posix_spawnp failed.");
    expect(h.daemonMustVerifyHelperExecBitAndSignature).toBe(true);
  });

  it("derives Reconciliation / launch / distribution implications", () => {
    const i = DAEMON_CRASH_BEHAVIOR_PROFILE.implications;
    expect(i).toContain("daemon-crash-leaves-orphan-process");
    expect(i).toContain("orphan-survives-sigkill-of-daemon");
    expect(i).toContain("must-not-auto-spawn-replacement-after-crash");
    expect(i).toContain("reconciliation-must-reidentify-by-pid-plus-lstart");
    expect(i).toContain("pid-alone-not-safe-pid-reuse-remains-risk");
    expect(i).toContain("pty-master-close-delivers-sighup");
    expect(i).toContain("inert-bootstrap-must-self-timeout-not-rely-on-daemon");
    expect(i).toContain("stopping-orphan-may-require-sigkill-escalation");
    expect(i).toContain("node-pty-spawn-helper-ships-non-executable");
    // Must NOT claim the child dies with the daemon — that would contradict every measured mode.
    expect(i).not.toContain("child-dies-with-daemon");
  });

  it("separates inferred implications and keeps them a subset of implications", () => {
    const all = DAEMON_CRASH_BEHAVIOR_PROFILE.implications as readonly string[];
    const inferred = DAEMON_CRASH_BEHAVIOR_PROFILE.inferredImplications;
    // every inferred entry must also appear in the main implications list
    for (const key of inferred) expect(all).toContain(key);
    // the explicitly-inferred subset is present and non-empty
    expect(inferred).toContain("must-not-auto-spawn-replacement-after-crash");
    expect(inferred).toContain("pid-alone-not-safe-pid-reuse-remains-risk");
    expect(inferred).toContain("inert-bootstrap-must-self-timeout-not-rely-on-daemon");
    // the directly-measured orphan facts are NOT in the inferred subset
    expect(inferred).not.toContain("orphan-survives-sigkill-of-daemon");
    expect(inferred).not.toContain("pty-master-close-delivers-sighup");
  });
});
