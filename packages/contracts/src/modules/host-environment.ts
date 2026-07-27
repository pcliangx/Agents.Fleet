// RT-MOD-12 — the Host Environment Module Interface.

import type {
  CandidateExecutable,
  EnvironmentSnapshotRecord,
  EnvironmentSnapshotVerification,
  ExecutableProbeResult,
  RepositoryTrustProbeAuthorization,
} from "../environment.js";
import type { WorktreeTargetBinding } from "../lifecycle/worktree.js";

export interface ExecutableProbeInput {
  readonly authorization: RepositoryTrustProbeAuthorization;
  readonly candidate: CandidateExecutable;
  readonly versionArguments: readonly string[];
}

export interface CreateEnvironmentSnapshotInput {
  readonly probe: ExecutableProbeResult;
  readonly cliVersion: string;
  readonly launchArguments: readonly string[];
  readonly worktreeTarget: WorktreeTargetBinding;
  readonly secretReferenceIdentities: readonly string[];
}

export interface HostEnvironment {
  /** RT-ENV-01 / RT-ADAPTER-06 — metadata-only, pre-Trust discovery. */
  discoverCandidate(explicitEntryPath: string): Promise<CandidateExecutable>;
  /** RT-ENV-02/05/06 — Active-only, neutral-cwd verified probe. */
  probe(input: ExecutableProbeInput): Promise<ExecutableProbeResult>;
  /** RT-ENV-03 — copies + freezes the immutable facts bound to launch. */
  createSnapshot(input: CreateEnvironmentSnapshotInput): EnvironmentSnapshotRecord;
  /** RT-ENV-04/06 — re-samples identity without executing the Agent. */
  verifySnapshot(record: EnvironmentSnapshotRecord): Promise<EnvironmentSnapshotVerification>;
}
