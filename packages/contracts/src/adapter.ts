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
