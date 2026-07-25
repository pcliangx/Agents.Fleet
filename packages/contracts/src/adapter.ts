// RT-ADAPTER-01..07 — adapter capability & discovery shapes.

export type AdapterCapability =
  | "Discovery"
  | "Hook"
  | "Transcript"
  | "Resume"
  | "PermissionMapping";

// RT-ADAPTER-03 — core flow decides by Capability, never by agent name or tier.
// Full / Launch-level is a UI summary label only.
export type AdapterTier = "Full" | "Launch-level";

export interface ExecutableIdentity {
  readonly canonicalEntryPath: string;
  readonly filesystemIdentity: string;
  readonly entryContentHash: string;
  readonly interpreterIdentity: string | undefined;
  readonly codeSigningIdentity: string | undefined;
  readonly observedAt: number;
  readonly identityCoverage: readonly string[];
}

// RT-ADAPTER-02 — verified discovery (Active Trust only).
export interface DiscoveryResult {
  readonly executableIdentity: ExecutableIdentity;
  readonly cliVersion: string;
  readonly supportedVersionRange: string;
  readonly capabilities: readonly AdapterCapability[];
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
