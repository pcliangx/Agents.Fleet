// R1-09 / RT-REC-07..12 / RT-LAUNCH-05 — the one startup Reconciliation
// boundary. Durable facts are reconciled before the Daemon accepts commands.
// A Prepared launch is continued only with its persisted nonce and only after
// the production launch facts have been revalidated.

import type {
  LaunchSessionResult,
  RestartReconciliationReport,
  RestartSnapshotRecoveryReport,
  SessionRuntime,
} from "@agents-fleet/contracts";

export interface ResumedPreparedLaunch {
  readonly action: "resumed-prepared";
  readonly attemptId: string;
  readonly launchNonce: string;
  readonly result: LaunchSessionResult;
}

export interface StartupReconciliationReport {
  readonly reconciliation: RestartReconciliationReport;
  readonly snapshotRecovery: RestartSnapshotRecoveryReport;
  readonly resumedLaunches: readonly ResumedPreparedLaunch[];
}

export const runStartupReconciliation = async (options: {
  readonly sessions: Pick<
    SessionRuntime,
    "launch" | "rebuildInvalidSnapshotsAfterRestart" | "reconcileAfterRestart"
  >;
  readonly revalidateAcceptedAttempt: (attemptId: string) => Promise<boolean>;
}): Promise<StartupReconciliationReport> => {
  const reconciliation = options.sessions.reconcileAfterRestart();
  const snapshotRecovery = await options.sessions.rebuildInvalidSnapshotsAfterRestart();
  const resumedLaunches: ResumedPreparedLaunch[] = [];
  for (const item of reconciliation.actions) {
    if (item.action !== "resume-prepared") continue;
    const result = await options.sessions.launch(item.preparedLaunch, {
      revalidate: async () => await options.revalidateAcceptedAttempt(item.attemptId),
    });
    resumedLaunches.push({
      action: "resumed-prepared",
      attemptId: item.attemptId,
      launchNonce: item.launchNonce,
      result,
    });
  }
  return { reconciliation, snapshotRecovery, resumedLaunches };
};
