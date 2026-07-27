import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { CLAUDE_CAPABILITY_PROFILE } from "@agents-fleet/testing";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { LocalHostEnvironment } from "../host-environment/host-environment.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";

let root = "";

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  root = "";
});

const makeClaudeExecutable = (path: string, versionOutput: string, canaryPath: string): void => {
  writeFileSync(
    path,
    `#!/bin/sh
printf x >> '${canaryPath}'
printf '%s\\n' '${versionOutput}'
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
};

const setup = (versionOutput = "2.1.218 (Claude Code)") => {
  root = mkdtempSync(join(tmpdir(), "af-r103-claude-"));
  const repositoryRoot = join(root, "repository");
  const installRoot = join(root, "install");
  mkdirSync(repositoryRoot);
  mkdirSync(installRoot);
  const executablePath = join(installRoot, "claude");
  const canaryPath = join(root, "executed");
  makeClaudeExecutable(executablePath, versionOutput, canaryPath);
  const hostEnvironment = new LocalHostEnvironment({
    appDataRoot: join(root, "app-data"),
    explicitPathEntries: ["/usr/bin", "/bin"],
    inheritedEnvironment: { HOME: join(root, "home"), LANG: "C.UTF-8" },
  });
  const adapter = new ClaudeCodeAdapter({
    candidateExecutablePath: executablePath,
    hostEnvironment,
  });
  return { adapter, canaryPath, hostEnvironment, repositoryRoot };
};

const authorization = (repositoryRoot: string, state: "PendingValidation" | "Active") => ({
  trustId: "trust-1",
  trustVersion: 1,
  state,
  repositoryRoot,
  repositoryIdentity: "repository-1",
});

describe("ClaudeCodeAdapter discovery (RT-ADAPTER-01..07)", () => {
  it("keeps candidate discovery metadata-only and returns the R0-04 facts only after Active Trust", async () => {
    const { adapter, canaryPath, repositoryRoot } = setup();
    const candidate = await adapter.discoverCandidate();
    expect(existsSync(canaryPath)).toBe(false);

    await expect(
      adapter.discover({
        authorization: authorization(repositoryRoot, "PendingValidation"),
        candidate,
      }),
    ).rejects.toMatchObject({ code: "Forbidden" });
    expect(existsSync(canaryPath)).toBe(false);

    const discovery = await adapter.discover({
      authorization: authorization(repositoryRoot, "Active"),
      candidate,
    });
    expect(existsSync(canaryPath)).toBe(true);
    expect(discovery).toMatchObject({
      agentId: "claude-code",
      cliVersion: CLAUDE_CAPABILITY_PROFILE.cli.version,
      supportedVersionRange: `=${CLAUDE_CAPABILITY_PROFILE.cli.version}`,
      capabilities: CLAUDE_CAPABILITY_PROFILE.capabilities,
      tier: CLAUDE_CAPABILITY_PROFILE.tier,
      permissionMappings: CLAUDE_CAPABILITY_PROFILE.permissionMappings,
    });
    expect(discovery.executableIdentity.identityCoverage).toEqual(
      expect.arrayContaining([
        "entry-filesystem",
        "entry-content",
        "interpreter-filesystem",
        "interpreter-content",
        "package-runtime-closure",
        "code-signing",
      ]),
    );
    expect(Object.isFrozen(discovery)).toBe(true);
    expect(Object.isFrozen(discovery.permissionMappings)).toBe(true);
  });

  it("rejects a version outside the exact R0-04 supported fixture", async () => {
    const { adapter, repositoryRoot } = setup("2.1.219 (Claude Code)");
    const candidate = await adapter.discoverCandidate();
    await expect(
      adapter.discover({
        authorization: authorization(repositoryRoot, "Active"),
        candidate,
      }),
    ).rejects.toMatchObject({ code: "UnsupportedVersion" });
  });

  it("prepares a structured launch without executing or expanding Profile secret references", async () => {
    const { adapter, canaryPath, hostEnvironment, repositoryRoot } = setup();
    const candidate = await adapter.discoverCandidate();
    const discovery = await adapter.discover({
      authorization: authorization(repositoryRoot, "Active"),
      candidate,
    });
    expect(readFileSync(canaryPath, "utf8")).toBe("x");
    const mapping = CLAUDE_CAPABILITY_PROFILE.permissionMappings[1];
    if (mapping === undefined) throw new Error("Balanced fixture mapping is missing");
    const worktreeTarget = {
      kind: "Planned",
      worktreeId: "worktree-1" as never,
      canonicalPath: join(root, "worktrees", "task-1"),
      repositoryIdentity: "repository-1",
      branchStrategy: {
        kind: "create",
        branchName: "fleet/task-1",
        onCollision: "fail",
      },
    } as const;
    const profileSnapshot = {
      profileId: "profile-1" as never,
      profileVersion: 1,
      agentId: "claude-code",
      accountRef: "account-reference-only",
      model: "sonnet",
      mode: null,
      permissionMode: "Balanced" as const,
      secretRefs: [
        {
          kind: "keychain" as const,
          referenceId: "anthropic-api",
          service: "agents-fleet",
          account: "profile-anthropic-api",
        },
      ],
      secretReferenceIdentities: ["keychain:sha256:reference-only"],
      adapterCapabilities: discovery.capabilities,
      adapterCapabilitiesHash: canonicalSha256(discovery.capabilities),
      permissionMapping: mapping,
      permissionMappingHash: canonicalSha256(mapping),
    };

    const launch = await adapter.prepare({
      taskSpecHash: "sha256:task",
      discovery,
      profileSnapshot,
      worktreeTarget,
    });
    expect(launch).toMatchObject({
      executablePath: candidate.canonicalEntryPath,
      argv: [...mapping.launchArgumentsPreview, "--model", "sonnet"],
      cwd: worktreeTarget.canonicalPath,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(root, "home"),
        LANG: "C.UTF-8",
      },
      channel: "interactive-pty",
      secretReferenceIdentities: ["keychain:sha256:reference-only"],
    });
    expect(Array.isArray(launch.argv)).toBe(true);
    expect(JSON.stringify(launch)).not.toContain("secret-material");
    expect(readFileSync(canaryPath, "utf8")).toBe("x");
    expect(Object.isFrozen(launch)).toBe(true);

    const snapshot = hostEnvironment.createSnapshot({
      probe: {
        executableIdentity: discovery.executableIdentity,
        stdout: "",
        environment: discovery.probeEnvironment,
      },
      cliVersion: discovery.cliVersion,
      launchArguments: launch.argv,
      worktreeTarget,
      secretReferenceIdentities: launch.secretReferenceIdentities,
    });
    expect(snapshot.snapshot.argvHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.snapshot.worktreeTarget).toEqual(worktreeTarget);

    await expect(
      adapter.prepare({
        taskSpecHash: "sha256:task",
        discovery: {
          ...discovery,
          permissionMappings: [{ ...mapping, effectiveMode: "YOLO" }],
        },
        profileSnapshot: {
          ...profileSnapshot,
          permissionMapping: { ...mapping, effectiveMode: "YOLO" },
        },
        worktreeTarget,
      }),
    ).rejects.toMatchObject({ code: "ConfirmationRequired" });

    await expect(
      adapter.prepare({
        taskSpecHash: "sha256:task",
        discovery,
        profileSnapshot: { ...profileSnapshot, mode: "unmapped-mode" },
        worktreeTarget,
      }),
    ).rejects.toMatchObject({ code: "CapabilityUnavailable" });
  });

  it("ingests bounded Hook evidence and degrades malformed Observation to inferred diagnostics", () => {
    const { adapter } = setup();
    const observedAt = new Date(1_800_000_000_000).toISOString();
    expect(
      adapter.ingestObservation({
        source: "Hook",
        bytes: Buffer.from('{"event":"PostToolUse","tool":"Edit"}', "utf8"),
        observedAt,
      }),
    ).toEqual([
      {
        kind: "AgentEvent",
        source: "Hook",
        confidence: "authoritative",
        observedAt,
        payload: { event: "PostToolUse", tool: "Edit" },
        diagnosticCode: null,
      },
    ]);

    for (const bytes of [
      new Uint8Array([0xff]),
      Buffer.from("{not-json", "utf8"),
      Buffer.from('["not","an","event-object"]', "utf8"),
      new Uint8Array(FROZEN_RUNTIME_LIMIT_PROFILE.adapterObservationBytes + 1),
    ]) {
      expect(() =>
        adapter.ingestObservation({ source: "Transcript", bytes, observedAt }),
      ).not.toThrow();
      expect(adapter.ingestObservation({ source: "Transcript", bytes, observedAt })).toEqual([
        expect.objectContaining({
          kind: "Diagnostic",
          source: "Transcript",
          confidence: "inferred",
          diagnosticCode: expect.stringMatching(
            /invalid-utf8|malformed-json|observation-limit-exceeded/,
          ),
        }),
      ]);
    }
  });
});
