// R0-07 — scenario directory layout for the at-most-once launch probe.
// Every durable artifact of the RT-LAUNCH-01..08 handshake is a file or a
// SQLite row under one scenario dir, so a NEW process (Reconciliation) can
// reconstruct the full state after a crash without talking to the old one.

export interface ScenarioPaths {
  readonly dir: string;
  readonly dbPath: string;
  /** External fact source (Worktree binding facts) revalidated per RT-CMD-16. */
  readonly factsPath: string;
  readonly coordinatorConfigPath: string;
  readonly coordinatorOutcomePath: string;
  readonly reconcileConfigPath: string;
  readonly reconcileOutcomePath: string;
}

export const scenarioPaths = (dir: string): ScenarioPaths => ({
  dir,
  dbPath: `${dir}/lifecycle.db`,
  factsPath: `${dir}/facts.json`,
  coordinatorConfigPath: `${dir}/coordinator-config.json`,
  coordinatorOutcomePath: `${dir}/coordinator-outcome.json`,
  reconcileConfigPath: `${dir}/reconcile-config.json`,
  reconcileOutcomePath: `${dir}/reconcile-outcome.json`,
});

/** RT-LAUNCH-02 — durable receipt, written O_EXCL by the inert bootstrap. */
export const receiptPath = (dir: string, nonce: string): string => `${dir}/receipt-${nonce}.json`;

/** RT-LAUNCH-03 — one-shot CommitLaunch, atomically renamed into place. */
export const commitPath = (dir: string, nonce: string): string => `${dir}/commit-${nonce}.json`;

/** RT-LAUNCH-08 — AbortLaunch, atomically renamed into place. */
export const abortPath = (dir: string, nonce: string): string => `${dir}/abort-${nonce}.json`;

/** Agent self-identity (fake agent), the observation anchor of RT-LAUNCH-04. */
export const agentIdentityPath = (dir: string, nonce: string): string =>
  `${dir}/agent-${nonce}.json`;

/** Agent heartbeat — lets an independent process confirm "exactly one agent". */
export const agentHeartbeatPath = (dir: string, nonce: string): string =>
  `${dir}/agent-${nonce}.hb`;

/** Bootstrap exit record — durable evidence of why the bootstrap went away. */
export const bootstrapExitPath = (dir: string, nonce: string): string =>
  `${dir}/bootstrap-exit-${nonce}.json`;
