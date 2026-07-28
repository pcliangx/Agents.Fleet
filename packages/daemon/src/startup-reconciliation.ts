// R1-09 / RT-REC-07..12 / RT-LAUNCH-05 — the one startup Reconciliation
// boundary. Durable facts are reconciled before the Daemon accepts commands.
// A Prepared launch is continued only with its persisted nonce and only after
// the production launch facts have been revalidated.

import type {
  LaunchSessionResult,
  RestartReconciliationReport,
  RestartSnapshotRebuildReport,
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
  readonly snapshotRebuild: RestartSnapshotRebuildReport;
  readonly resumedLaunches: readonly ResumedPreparedLaunch[];
  readonly hasFindings: boolean;
}

export const runStartupReconciliation = async (options: {
  readonly sessions: Pick<
    SessionRuntime,
    "launch" | "rebuildInvalidSnapshotsAfterRestart" | "reconcileAfterRestart"
  >;
  readonly revalidateAcceptedAttempt: (attemptId: string) => Promise<boolean>;
}): Promise<StartupReconciliationReport> => {
  const reconciliation = options.sessions.reconcileAfterRestart();
  const snapshotRebuild = await options.sessions.rebuildInvalidSnapshotsAfterRestart();
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
  const integrity = reconciliation.dataIntegrity;
  const hasFindings =
    reconciliation.actions.length > 0 ||
    resumedLaunches.length > 0 ||
    snapshotRebuild.rebuilt.length > 0 ||
    snapshotRebuild.skippedForDataGap.length > 0 ||
    integrity.adoptedOrphanCount > 0 ||
    integrity.isolatedOrphanCount > 0 ||
    integrity.dataGapCount > 0 ||
    integrity.uncertainInputIntentCount > 0 ||
    integrity.inputDataGapCount > 0 ||
    integrity.isolatedInputOrphanCount > 0;
  return { reconciliation, snapshotRebuild, resumedLaunches, hasFindings };
};
