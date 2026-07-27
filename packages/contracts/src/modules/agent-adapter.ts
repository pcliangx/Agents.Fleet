// RT-MOD-05 / RT-ADAPTER-01..07 — Agent Adapter interface.
import type {
  AdapterCapability,
  AdapterObservation,
  AdapterObservationInput,
  DiscoveryResult,
  PermissionMapping,
} from "../adapter.js";
import type { CandidateExecutable, RepositoryTrustProbeAuthorization } from "../environment.js";
import type { WorktreeTargetBinding } from "../lifecycle/worktree.js";
import type { AgentProfileSnapshot } from "../profile.js";

export interface PrepareInput {
  readonly taskSpecHash: string;
  readonly discovery: DiscoveryResult;
  readonly profileSnapshot: AgentProfileSnapshot;
  readonly worktreeTarget: WorktreeTargetBinding;
}

export interface VerifiedDiscoveryInput {
  readonly authorization: RepositoryTrustProbeAuthorization;
  readonly candidate: CandidateExecutable;
}

// RT-ADAPTER-07 — prepare only normalizes verified metadata into a structured
// launch spec; it must NOT execute agent/shell/repo files or expand secrets.
export interface LaunchSpec {
  readonly executablePath: string;
  /** Arguments only; executablePath is never concatenated into a shell string. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly channel: "interactive-pty";
  readonly capabilities: readonly AdapterCapability[];
  readonly permissionMapping: PermissionMapping;
  readonly secretReferenceIdentities: readonly string[];
}

export interface AgentAdapter {
  readonly agentId: string;
  /** RT-ADAPTER-06 — host-level candidate metadata only, before Active Trust. */
  discoverCandidate(): Promise<CandidateExecutable>;
  /** RT-ADAPTER-02 — verified discovery; only valid after Active Repository Trust. */
  discover(input: VerifiedDiscoveryInput): Promise<DiscoveryResult>;
  /** RT-ADAPTER-07 — structured launch spec from bounded metadata; executes nothing. */
  prepare(input: PrepareInput): Promise<LaunchSpec>;
  /** RT-ADAPTER-04 — enhancement failures return inferred diagnostics, never lifecycle facts. */
  ingestObservation(input: AdapterObservationInput): readonly AdapterObservation[];
}
