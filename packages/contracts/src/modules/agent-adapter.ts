// RT-MOD-05 / RT-ADAPTER-01..07 — Agent Adapter interface.
// Minimal for #1: enough for FakeAdapter (testing) to implement and for the
// smoke test to assert prepare() executes nothing. Later tickets expand it.

import type { AdapterCapability, DiscoveryResult } from "../adapter.js";

export interface PrepareInput {
  readonly taskSpecHash: string;
  readonly profileVersion: number;
  readonly environmentSnapshotHash: string;
}

// RT-ADAPTER-07 — prepare only normalizes verified metadata into a structured
// launch spec; it must NOT execute agent/shell/repo files or expand secrets.
export interface LaunchSpec {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentAdapter {
  readonly agentId: string;
  readonly capabilities: readonly AdapterCapability[];
  /** RT-ADAPTER-06 — host-level candidate metadata only, before Active Trust. */
  discoverCandidate(): Promise<{ readonly candidateExecutablePath: string }>;
  /** RT-ADAPTER-02 — verified discovery; only valid after Active Repository Trust. */
  discover(): Promise<DiscoveryResult>;
  /** RT-ADAPTER-07 — structured launch spec from bounded metadata; executes nothing. */
  prepare(input: PrepareInput): Promise<LaunchSpec>;
}
