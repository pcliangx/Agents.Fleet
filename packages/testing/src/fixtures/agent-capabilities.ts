// R0-04 probe fixture: per-agent Capability profile for Claude Code + Codex.
// Reference data for the R1 (Claude) / R2 (Codex) Adapter implementations.
// Sourced from `claude --help` / `codex --help` + local transcript inspection —
// see docs/probes/r0-04-agent-capability.md.
//
// Permission mappings use the canonical contracts PermissionMapping (SV1-PERM-05).
// Enforcement claims reflect ONLY what --help proves (SV1-PERM-02): controls
// whose enforcement is unverified are listed in unsupportedControls with a
// verify-at-runtime warning — never defaulted to safe.

import type { AdapterCapability, PermissionMapping } from "@agents-fleet/contracts";

export interface TranscriptSpec {
  readonly locationPattern: string;
  readonly format: "jsonl";
  readonly sessionIdKey: "uuid-filename" | "uuid-field";
}

export interface AgentCapabilityProfile {
  readonly agentId: string;
  readonly cli: { readonly command: string; readonly version: string; readonly path: string };
  readonly capabilities: readonly AdapterCapability[];
  readonly tier: "Full" | "Launch-level";
  readonly hookSupport: "settings-hooks" | "none";
  readonly observationChannel: string;
  readonly permissionMappings: readonly PermissionMapping[];
  readonly resume: { readonly command: string; readonly bySessionId: string };
  readonly transcript: TranscriptSpec;
  readonly candidateDiscovery: { readonly metadataOnly: true; readonly notes: string };
  readonly verifiedDiscovery: {
    readonly versionCommand: string;
    readonly resolves: readonly string[];
    readonly notes: string;
  };
}

const VERIFY_WARNING =
  "enforcement not verified from --help; verify at R1/R2 runtime (SV1-PERM-02)";

export const CLAUDE_CAPABILITY_PROFILE: AgentCapabilityProfile = {
  agentId: "claude-code",
  cli: { command: "claude", version: "2.1.218", path: "~/.local/bin/claude" },
  capabilities: ["Discovery", "Hook", "Transcript", "Resume", "PermissionMapping"],
  tier: "Full",
  hookSupport: "settings-hooks",
  observationChannel:
    "--print --output-format=stream-json (structured events) + settings.json hooks (PreToolUse/PostToolUse/...)",
  permissionMappings: [
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
  ],
  resume: {
    command: "claude --resume <sessionId> | -c",
    bySessionId: "claude --resume <sessionId>",
  },
  transcript: {
    locationPattern: "~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl",
    format: "jsonl",
    sessionIdKey: "uuid-filename",
  },
  candidateDiscovery: {
    metadataOnly: true,
    notes: "install metadata + filesystem identity only; no execution pre-Trust (ADR-0002)",
  },
  verifiedDiscovery: {
    versionCommand: "claude --version",
    resolves: [
      "ExecutableIdentity",
      "supportedVersionRange",
      "Capability set",
      "PermissionMapping",
    ],
    notes: "post Active Trust, neutral cwd; agent process only starts at CommitLaunch",
  },
};

export const CODEX_CAPABILITY_PROFILE: AgentCapabilityProfile = {
  agentId: "codex",
  cli: { command: "codex", version: "0.145.0", path: "~/.local/bin/codex" },
  capabilities: ["Discovery", "Transcript", "Resume", "PermissionMapping"],
  tier: "Full",
  hookSupport: "none",
  observationChannel:
    "session rollout transcript + codex exec output (status inferred; no settings hooks)",
  permissionMappings: [
    {
      requestedMode: "Manual",
      effectiveMode: "Manual",
      launchArgumentsPreview: ["--ask-for-approval", "untrusted", "--sandbox", "read-only"],
      enforcedCapabilities: [],
      unsupportedControls: ["read-only-sandbox-enforcement", "untrusted-approval-enforcement"],
      warnings: [VERIFY_WARNING],
    },
    {
      requestedMode: "Balanced",
      effectiveMode: "Balanced",
      launchArgumentsPreview: ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"],
      enforcedCapabilities: [],
      unsupportedControls: ["workspace-write-boundary", "on-request-approval"],
      warnings: [VERIFY_WARNING],
    },
    {
      requestedMode: "YOLO",
      effectiveMode: "YOLO",
      launchArgumentsPreview: ["--dangerously-bypass-approvals-and-sandbox"],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: ["EXTREMELY DANGEROUS: no sandbox, no approvals — no boundary enforced by design"],
    },
  ],
  resume: { command: "codex resume <sessionId|--last>", bySessionId: "codex resume <sessionId>" },
  transcript: {
    locationPattern: "~/.codex/sessions/<year>/... + ~/.codex/session_index.jsonl",
    format: "jsonl",
    sessionIdKey: "uuid-field",
  },
  candidateDiscovery: {
    metadataOnly: true,
    notes: "install metadata + filesystem identity only; no execution pre-Trust (ADR-0002)",
  },
  verifiedDiscovery: {
    versionCommand: "codex --version",
    resolves: [
      "ExecutableIdentity",
      "supportedVersionRange",
      "Capability set",
      "PermissionMapping",
    ],
    notes: "post Active Trust, neutral cwd; agent process only starts at CommitLaunch",
  },
};

export const AGENT_CAPABILITY_PROFILES: readonly AgentCapabilityProfile[] = [
  CLAUDE_CAPABILITY_PROFILE,
  CODEX_CAPABILITY_PROFILE,
];
