// R0-04 probe fixture: per-agent Capability profile for Claude Code + Codex.
// Reference data for the R1 (Claude) / R2 (Codex) Adapter implementations.
// Sourced from `claude --help` / `codex --help` + local transcript inspection —
// see docs/probes/r0-04-agent-capability.md.

import type { AdapterCapability } from "@agents-fleet/contracts";

export type PermissionModeName = "Manual" | "Balanced" | "YOLO";

export interface PermissionModeMapping {
  readonly requestedMode: PermissionModeName;
  readonly argv: readonly string[];
  readonly enforcedCapabilities: readonly string[];
  readonly unsupportedControls: readonly string[];
  readonly warnings: readonly string[];
}

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
  readonly permissionMappings: readonly PermissionModeMapping[];
  readonly resume: { readonly command: string; readonly bySessionId: string };
  readonly transcript: TranscriptSpec;
  readonly candidateDiscovery: { readonly versionCommand: string; readonly notes: string };
}

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
      argv: ["--permission-mode", "default"],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: [],
    },
    {
      requestedMode: "Balanced",
      argv: ["--permission-mode", "acceptEdits"],
      enforcedCapabilities: ["acceptEdits"],
      unsupportedControls: [],
      warnings: [],
    },
    {
      requestedMode: "YOLO",
      argv: ["--dangerously-skip-permissions"],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: ["bypasses all permission checks"],
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
    versionCommand: "claude --version",
    notes: "version + executable path only; no execution pre-Trust",
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
      argv: ["--ask-for-approval", "untrusted", "--sandbox", "read-only"],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: [],
    },
    {
      requestedMode: "Balanced",
      argv: ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"],
      enforcedCapabilities: ["workspace-write"],
      unsupportedControls: [],
      warnings: [],
    },
    {
      requestedMode: "YOLO",
      argv: ["--dangerously-bypass-approvals-and-sandbox"],
      enforcedCapabilities: [],
      unsupportedControls: [],
      warnings: ["EXTREMELY DANGEROUS: no sandbox, no approvals"],
    },
  ],
  resume: { command: "codex resume <sessionId|--last>", bySessionId: "codex resume <sessionId>" },
  transcript: {
    locationPattern: "~/.codex/sessions/<year>/... + ~/.codex/session_index.jsonl",
    format: "jsonl",
    sessionIdKey: "uuid-field",
  },
  candidateDiscovery: {
    versionCommand: "codex --version",
    notes: "version + executable path only; no execution pre-Trust",
  },
};

export const AGENT_CAPABILITY_PROFILES: readonly AgentCapabilityProfile[] = [
  CLAUDE_CAPABILITY_PROFILE,
  CODEX_CAPABILITY_PROFILE,
];
