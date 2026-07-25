// FakeAdapter — implements RT-MOD-05 AgentAdapter for tests. RT-ADAPTER-06/07:
// candidate discovery returns host metadata only; prepare() normalizes metadata
// into a structured launch spec and executes NOTHING.

import type {
  AdapterCapability,
  AgentAdapter,
  DiscoveryResult,
  LaunchSpec,
  PrepareInput,
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

  async discoverCandidate(): Promise<{ readonly candidateExecutablePath: string }> {
    return { candidateExecutablePath: "/usr/local/bin/fake-agent" };
  }

  async discover(): Promise<DiscoveryResult> {
    return {
      executableIdentity: {
        canonicalEntryPath: "/usr/local/bin/fake-agent",
        filesystemIdentity: "inode:1",
        entryContentHash: "sha256:fake",
        interpreterIdentity: undefined,
        codeSigningIdentity: undefined,
        observedAt: 0,
        identityCoverage: ["entry"],
      },
      cliVersion: "0.0.0-fake",
      supportedVersionRange: ">=0.0.0",
      capabilities: this.capabilities,
    };
  }

  async prepare(input: PrepareInput): Promise<LaunchSpec> {
    // Record the call but perform NO execution / NO secret expansion (RT-ADAPTER-07).
    this.prepareCalls.push(input);
    return { argv: ["fake-agent", "--print"], env: {} };
  }

  get prepareCallCount(): number {
    return this.prepareCalls.length;
  }
}
