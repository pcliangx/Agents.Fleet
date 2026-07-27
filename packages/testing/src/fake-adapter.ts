// FakeAdapter — implements RT-MOD-05 AgentAdapter for tests. RT-ADAPTER-06/07:
// candidate discovery returns host metadata only; prepare() normalizes metadata
// into a structured launch spec and executes NOTHING.

import type {
  AdapterCapability,
  AdapterObservation,
  AdapterObservationInput,
  AgentAdapter,
  CandidateExecutable,
  DiscoveryResult,
  LaunchSpec,
  PermissionMapping,
  PrepareInput,
  VerifiedDiscoveryInput,
} from "@agents-fleet/contracts";

export interface FakeAdapterOptions {
  readonly agentId?: string;
  readonly capabilities?: readonly AdapterCapability[];
}

export class FakeAdapter implements AgentAdapter {
  readonly agentId: string;
  readonly capabilities: readonly AdapterCapability[];
  private readonly prepareCalls: PrepareInput[] = [];

  constructor(opts: FakeAdapterOptions = {}) {
    this.agentId = opts.agentId ?? "fake";
    this.capabilities = opts.capabilities ?? ["Discovery", "PermissionMapping"];
  }

  async discoverCandidate(): Promise<CandidateExecutable> {
    return {
      explicitEntryPath: "/usr/local/bin/fake-agent",
      canonicalEntryPath: "/usr/local/bin/fake-agent",
      symlinkFilesystemIdentity: null,
      entryFilesystemIdentity: { dev: 1, ino: 1, mode: 0o100755, size: 4 },
      observedAt: new Date(0).toISOString(),
    };
  }

  async discover(_input: VerifiedDiscoveryInput): Promise<DiscoveryResult> {
    const permissionMappings: readonly PermissionMapping[] = [
      {
        requestedMode: "Manual",
        effectiveMode: "Manual",
        launchArgumentsPreview: ["--manual"],
        enforcedCapabilities: [],
        unsupportedControls: [],
        warnings: [],
      },
      {
        requestedMode: "Balanced",
        effectiveMode: "Balanced",
        launchArgumentsPreview: ["--balanced"],
        enforcedCapabilities: [],
        unsupportedControls: [],
        warnings: [],
      },
      {
        requestedMode: "YOLO",
        effectiveMode: "YOLO",
        launchArgumentsPreview: ["--yolo"],
        enforcedCapabilities: [],
        unsupportedControls: [],
        warnings: [],
      },
    ];
    return {
      agentId: this.agentId,
      executableIdentity: {
        explicitEntryPath: "/usr/local/bin/fake-agent",
        canonicalEntryPath: "/usr/local/bin/fake-agent",
        filesystemIdentity: { dev: 1, ino: 1, mode: 0o100755, size: 4 },
        symlinkFilesystemIdentity: null,
        entryContentHash: "sha256:fake",
        interpreterIdentity: null,
        packageRuntimeClosureManifest: {
          kind: "native",
          entries: [
            {
              canonicalPath: "/usr/local/bin/fake-agent",
              filesystemIdentity: { dev: 1, ino: 1, mode: 0o100755, size: 4 },
              contentHash: "sha256:fake",
            },
          ],
          nativeDependencies: [],
          platformMatrixVersion: 4,
          manifestHash: "sha256:fake-manifest",
        },
        codeSigningIdentity: null,
        observedAt: new Date(0).toISOString(),
        identityCoverage: [
          "explicit-entry-path",
          "canonical-entry-path",
          "entry-filesystem",
          "entry-content",
          "package-runtime-closure",
          "code-signing",
        ],
      },
      cliVersion: "0.0.0-fake",
      supportedVersionRange: ">=0.0.0",
      capabilities: this.capabilities,
      tier: "Launch-level",
      permissionMappings,
      probeEnvironment: {
        neutralCwd: "/tmp/agents-fleet/fake-probe",
        explicitPath: "/usr/local/bin:/usr/bin:/bin",
        inheritedVariableAllowlist: [],
        inheritedEnvironment: {},
      },
    };
  }

  async prepare(input: PrepareInput): Promise<LaunchSpec> {
    // Record the call but perform NO execution / NO secret expansion (RT-ADAPTER-07).
    this.prepareCalls.push(input);
    return {
      executablePath: input.discovery.executableIdentity.canonicalEntryPath,
      argv: ["--print"],
      cwd: input.worktreeTarget.canonicalPath,
      env: {},
      channel: "interactive-pty",
      capabilities: input.discovery.capabilities,
      permissionMapping: input.profileSnapshot.permissionMapping,
      secretReferenceIdentities: input.profileSnapshot.secretReferenceIdentities,
    };
  }

  get prepareCallCount(): number {
    return this.prepareCalls.length;
  }

  ingestObservation(input: AdapterObservationInput): readonly AdapterObservation[] {
    return [
      {
        kind: "Diagnostic",
        source: input.source,
        confidence: "inferred",
        observedAt: input.observedAt,
        payload: { byteLength: input.bytes.byteLength },
        diagnosticCode: "malformed-json",
      },
    ];
  }
}
