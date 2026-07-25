import { describe, expect, it } from "vitest";
import { LAUNCHAGENT_ENVIRONMENT_PROFILE } from "../fixtures/launchagent-environment.js";

describe("R0-02 LaunchAgent environment fixture", () => {
  it("records the measured default PATH with no user shell customization", () => {
    const { path } = LAUNCHAGENT_ENVIRONMENT_PROFILE.measuredDefaults;
    expect(path).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(path).not.toContain("homebrew");
    expect(path).not.toContain(".local/bin");
  });

  it("proves shell init is not inherited and locale/term are absent", () => {
    const d = LAUNCHAGENT_ENVIRONMENT_PROFILE.measuredDefaults;
    expect(d.shellInitInherited).toBe(false);
    expect(d.langSet).toBe(false);
    expect(d.termSet).toBe(false);
    expect(d.homeSet).toBe(true);
    expect(d.userSet).toBe(true);
  });

  it("shows node/claude/codex do NOT resolve on the LaunchAgent PATH; system tools do", () => {
    const r = LAUNCHAGENT_ENVIRONMENT_PROFILE.pathResolution;
    expect(r.node).toBeNull();
    expect(r.claude).toBeNull();
    expect(r.codex).toBeNull();
    expect(r.git).toBe("/usr/bin/git");
    expect(r.security).toBe("/usr/bin/security");
  });

  it("requires explicit-path discovery and confirms version probes work in cleaned env", () => {
    const d = LAUNCHAGENT_ENVIRONMENT_PROFILE.agentDiscovery;
    expect(d.strategy).toBe("explicit-path");
    for (const agent of [d.candidates.claude, d.candidates.codex]) {
      expect(agent.homeRelativePath).not.toMatch(/^[~/]/);
      expect(agent.observedAbsolutePath).toMatch(/^\/Users\//);
      expect(agent.observedAbsolutePath.endsWith(agent.homeRelativePath)).toBe(true);
      expect(agent.versionProbeArgv).toEqual(["--version"]);
      expect(agent.observed.length).toBeGreaterThan(0);
    }
    expect(d.cleanedEnvMinimum).toContain("HOME");
    expect(d.cleanedEnvMinimum).toContain("PATH");
  });

  it("confirms Keychain read API is reachable; write/ACL paths stay explicitly unverified", () => {
    const k = LAUNCHAGENT_ENVIRONMENT_PROFILE.keychain;
    expect(k.listKeychainsWorks).toBe(true);
    expect(k.loginKeychainVisible).toBe(true);
    expect(k.genericPasswordApiReachable).toBe(true);
    expect(k.writeAndAclPathsVerified).toBe(false);
  });

  it("derives Daemon environment implications referenced by ADR-0001 / RT-ENV-03", () => {
    const i = LAUNCHAGENT_ENVIRONMENT_PROFILE.implications;
    expect(i).toContain("daemon-must-use-absolute-executable-paths");
    expect(i).toContain("daemon-must-not-rely-on-system-node");
    expect(i).toContain("daemon-must-set-explicit-path-for-children");
    expect(i).toContain("daemon-must-inject-lang");
    expect(i).toContain("daemon-must-inject-term-for-pty");
    expect(i).toContain("agent-discovery-must-use-explicit-candidate-paths");
    expect(i).toContain("keychain-read-api-reachable");
    expect(i).not.toContain("keychain-available-without-user-interaction");
  });
});
