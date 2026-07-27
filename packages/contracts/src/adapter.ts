// RT-ADAPTER-01..07 — adapter capability & discovery shapes.

import type { ExecutableIdentity, ProbeEnvironment } from "./environment.js";

export type AdapterCapability =
  | "Discovery"
  | "Hook"
  | "Transcript"
  | "Resume"
  | "PermissionMapping";

// RT-ADAPTER-03 — core flow decides by Capability, never by agent name or tier.
// Full / Launch-level is a UI summary label only.
export type AdapterTier = "Full" | "Launch-level";

// RT-ADAPTER-02 — verified discovery (Active Trust only).
export interface DiscoveryResult {
  readonly agentId: string;
  readonly executableIdentity: ExecutableIdentity;
  readonly cliVersion: string;
  readonly supportedVersionRange: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly tier: AdapterTier;
  readonly permissionMappings: readonly PermissionMapping[];
  readonly probeEnvironment: ProbeEnvironment;
}

// SV1-PERM-05 — PermissionMode is user intent, NOT a uniform cross-agent safety level.
export type PermissionMode = "Manual" | "Balanced" | "YOLO";

// SV1-PERM-05 — the canonical permission mapping an Adapter returns.
export interface PermissionMapping {
  readonly requestedMode: PermissionMode;
  readonly effectiveMode: PermissionMode;
  // SV1-PERM-03 — redacted/structured argv preview; the actual launch uses an argv array, not a shell string.
  readonly launchArgumentsPreview: readonly string[];
  readonly enforcedCapabilities: readonly string[];
  // SV1-PERM-02 — controls whose enforcement cannot be confirmed are listed here, never defaulted to safe.
  readonly unsupportedControls: readonly string[];
  readonly warnings: readonly string[];
}

export type AdapterObservationSource = "Hook" | "Transcript" | "StreamJson";

export interface AdapterObservationInput {
  readonly source: AdapterObservationSource;
  readonly bytes: Uint8Array;
  readonly observedAt: string;
}

export type AdapterObservationDiagnosticCode =
  | "observation-limit-exceeded"
  | "invalid-utf8"
  | "malformed-json";

export interface AdapterObservation {
  readonly kind: "AgentEvent" | "Diagnostic";
  readonly source: AdapterObservationSource;
  readonly confidence: "authoritative" | "inferred";
  readonly observedAt: string;
  readonly payload: unknown;
  readonly diagnosticCode: AdapterObservationDiagnosticCode | null;
}

const PERMISSION_BREADTH: Readonly<Record<PermissionMode, number>> = {
  Manual: 0,
  Balanced: 1,
  YOLO: 2,
};

// SV1-PERM-01 — an Adapter mapping may be equally or more restrictive than
// requested, but never silently broader.
export const isPermissionExpansion = (mapping: PermissionMapping): boolean =>
  PERMISSION_BREADTH[mapping.effectiveMode] > PERMISSION_BREADTH[mapping.requestedMode];
