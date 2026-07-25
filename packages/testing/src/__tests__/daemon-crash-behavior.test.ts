import { describe, expect, it } from "vitest";
import { DAEMON_CRASH_BEHAVIOR_PROFILE } from "../fixtures/daemon-crash-behavior.js";

const MODES = ["exit-normal", "sigterm", "sigkill"] as const;

describe("R0-03 daemon crash behavior fixture", () => {
  it("covers all three Daemon death modes", () => {
    expect(DAEMON_CRASH_BEHAVIOR_PROFILE.crashModes.map((m) => m.mode)).toEqual([...MODES]);
  });

  it("in EVERY mode the child survives and is orphaned to pid 1 (RT-REC-07/08)", () => {
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

  it("captures the node-pty spawn-helper supply-chain finding (RT-DIST-01 / SV1-SUPPLY-02)", () => {
    const h = DAEMON_CRASH_BEHAVIOR_PROFILE.nodePtySpawnHelper;
    expect(h.shipsNonExecutable).toBe(true);
    expect(h.modeBeforeChmod).toBe("0o644");
    expect(h.modeAfterChmod).toBe("0o755");
    expect(h.npmAllowScriptsBlocksLifecycle).toBe(true);
    expect(h.posixSpawnpFailsWithoutChmod).toBe(true);
    expect(h.daemonMustVerifyHelperExecBitAndSignature).toBe(true);
  });

  it("derives Reconciliation / launch / distribution implications referenced by RT-REC / RT-LAUNCH / RT-STATE", () => {
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
});
