// R1-03 — first real Agent Adapter: Claude Code 2.1.218.
//
// R0-04 is the independent compatibility fixture. This implementation keeps
// the same Capability and Permission Mapping facts locally (Agent-specific
// knowledge belongs in this Adapter); its contract test compares them against
// that fixture so drift cannot silently change the product claim.

import type { ErrorCode } from "@agents-fleet/contracts";
import {
  type AdapterObservation,
  type AdapterObservationDiagnosticCode,
  type AdapterObservationInput,
  type AgentAdapter,
  type CandidateExecutable,
  type DiscoveryResult,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type HostEnvironment,
  isPermissionExpansion,
  type LaunchSpec,
  type PermissionMapping,
  type PrepareInput,
  type VerifiedDiscoveryInput,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";

const CLAUDE_VERSION = "2.1.218";
const CLAUDE_CAPABILITIES = [
  "Discovery",
  "Hook",
  "Transcript",
  "Resume",
  "PermissionMapping",
] as const;

const VERIFY_WARNING =
  "enforcement not verified from --help; verify at R1/R2 runtime (SV1-PERM-02)";

const CLAUDE_PERMISSION_MAPPINGS: readonly PermissionMapping[] = [
  {
    requestedMode: "Manual",
    effectiveMode: "Manual",
    launchArgumentsPreview: ["--permission-mode", "default"],
    enforcedCapabilities: [],
    unsupportedControls: ["per-tool-approval-enforcement"],
    warnings: [VERIFY_WARNING],
  },
  {
    requestedMode: "Balanced",
    effectiveMode: "Balanced",
    launchArgumentsPreview: ["--permission-mode", "acceptEdits"],
    enforcedCapabilities: [],
    unsupportedControls: ["edit-auto-approval-boundary"],
    warnings: [VERIFY_WARNING],
  },
  {
    requestedMode: "YOLO",
    effectiveMode: "YOLO",
    launchArgumentsPreview: ["--dangerously-skip-permissions"],
    enforcedCapabilities: [],
    unsupportedControls: [],
    warnings: ["bypasses ALL permission checks (per --help) — no boundary enforced by design"],
  },
];

export class AgentAdapterError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AgentAdapterError";
    this.code = code;
  }
}

export interface ClaudeCodeAdapterOptions {
  readonly candidateExecutablePath: string;
  readonly hostEnvironment: HostEnvironment;
}

const parseVersion = (stdout: string): string => {
  const line = stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec(line);
  if (match?.[1] === undefined) {
    throw new AgentAdapterError(
      "CapabilityUnavailable",
      "Claude Code version probe returned an unsupported response",
    );
  }
  return match[1];
};

const targetPath = (input: PrepareInput): string => input.worktreeTarget.canonicalPath;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const freezeJsonTree = <T extends object>(value: T): T => {
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return value;
};

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId = "claude-code";
  readonly #candidateExecutablePath: string;
  readonly #hostEnvironment: HostEnvironment;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.#candidateExecutablePath = options.candidateExecutablePath;
    this.#hostEnvironment = options.hostEnvironment;
  }

  async discoverCandidate(): Promise<CandidateExecutable> {
    return await this.#hostEnvironment.discoverCandidate(this.#candidateExecutablePath);
  }

  async discover(input: VerifiedDiscoveryInput): Promise<DiscoveryResult> {
    const probe = await this.#hostEnvironment.probe({
      authorization: input.authorization,
      candidate: input.candidate,
      versionArguments: ["--version"],
    });
    const version = parseVersion(probe.stdout);
    if (version !== CLAUDE_VERSION) {
      throw new AgentAdapterError(
        "UnsupportedVersion",
        `Claude Code version is outside the supported range =${CLAUDE_VERSION}`,
      );
    }
    return deepFreeze({
      agentId: this.agentId,
      executableIdentity: probe.executableIdentity,
      cliVersion: version,
      supportedVersionRange: `=${CLAUDE_VERSION}`,
      capabilities: [...CLAUDE_CAPABILITIES],
      tier: "Full",
      permissionMappings: structuredClone(CLAUDE_PERMISSION_MAPPINGS),
      probeEnvironment: probe.environment,
    });
  }

  async prepare(input: PrepareInput): Promise<LaunchSpec> {
    if (
      input.taskSpecHash.length === 0 ||
      input.discovery.agentId !== this.agentId ||
      input.profileSnapshot.agentId !== this.agentId ||
      input.profileSnapshot.profileVersion < 1
    ) {
      throw new AgentAdapterError(
        "InvalidRequest",
        "Claude Code launch metadata does not match the verified Adapter",
      );
    }
    if (
      canonicalSha256(input.discovery.capabilities) !==
        input.profileSnapshot.adapterCapabilitiesHash ||
      canonicalSha256(input.profileSnapshot.adapterCapabilities) !==
        input.profileSnapshot.adapterCapabilitiesHash
    ) {
      throw new AgentAdapterError(
        "ConfirmationRequired",
        "Adapter Capabilities no longer match the immutable Agent Profile snapshot",
      );
    }
    const mappings = input.discovery.permissionMappings.filter(
      (candidate) =>
        candidate.requestedMode === input.profileSnapshot.permissionMode &&
        canonicalSha256(candidate) === input.profileSnapshot.permissionMappingHash,
    );
    const mapping = mappings[0];
    if (
      mapping === undefined ||
      mappings.length !== 1 ||
      canonicalSha256(input.profileSnapshot.permissionMapping) !==
        input.profileSnapshot.permissionMappingHash
    ) {
      throw new AgentAdapterError(
        "ConfirmationRequired",
        "Permission Mapping no longer matches the verified Claude Code discovery",
      );
    }
    if (isPermissionExpansion(mapping)) {
      throw new AgentAdapterError(
        "ConfirmationRequired",
        "effective Permission Mode is broader than the requested mode",
      );
    }
    if (input.profileSnapshot.mode !== null) {
      throw new AgentAdapterError(
        "CapabilityUnavailable",
        "Claude Code Adapter does not define a mapping for the generic Profile mode field",
      );
    }
    const argv = [...mapping.launchArgumentsPreview];
    if (input.profileSnapshot.model !== null) {
      if (
        input.profileSnapshot.model.length === 0 ||
        input.profileSnapshot.model.includes("\0") ||
        Buffer.byteLength(input.profileSnapshot.model, "utf8") >
          FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
      ) {
        throw new AgentAdapterError("InvalidRequest", "Claude Code Profile model is invalid");
      }
      argv.push("--model", input.profileSnapshot.model);
    }
    return deepFreeze({
      executablePath: input.discovery.executableIdentity.canonicalEntryPath,
      argv,
      cwd: targetPath(input),
      env: {
        PATH: input.discovery.probeEnvironment.explicitPath,
        ...input.discovery.probeEnvironment.inheritedEnvironment,
      },
      channel: "interactive-pty",
      capabilities: [...input.discovery.capabilities],
      permissionMapping: structuredClone(mapping),
      secretReferenceIdentities: [...input.profileSnapshot.secretReferenceIdentities],
    });
  }

  ingestObservation(input: AdapterObservationInput): readonly AdapterObservation[] {
    const diagnostic = (
      diagnosticCode: AdapterObservationDiagnosticCode,
    ): readonly AdapterObservation[] =>
      deepFreeze([
        {
          kind: "Diagnostic",
          source: input.source,
          confidence: "inferred",
          observedAt: input.observedAt,
          payload: { byteLength: input.bytes.byteLength },
          diagnosticCode,
        },
      ]);

    if (input.bytes.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.adapterObservationBytes) {
      return diagnostic("observation-limit-exceeded");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      return diagnostic("invalid-utf8");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return diagnostic("malformed-json");
      }
      freezeJsonTree(payload);
    } catch {
      return diagnostic("malformed-json");
    }
    return deepFreeze([
      {
        kind: "AgentEvent",
        source: input.source,
        confidence: "authoritative",
        observedAt: input.observedAt,
        payload,
        diagnosticCode: null,
      },
    ]);
  }
}
