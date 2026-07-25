import { describe, expect, it } from "vitest";
import { AGENT_CAPABILITY_PROFILES } from "../fixtures/agent-capabilities.js";

const MODES = ["Manual", "Balanced", "YOLO"] as const;

describe("R0-04 agent capability fixture", () => {
  it("covers claude-code + codex in order", () => {
    expect(AGENT_CAPABILITY_PROFILES.map((p) => p.agentId)).toEqual(["claude-code", "codex"]);
  });

  it("each profile declares Discovery/Transcript/Resume/PermissionMapping", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      for (const cap of ["Discovery", "Transcript", "Resume", "PermissionMapping"] as const) {
        expect(p.capabilities).toContain(cap);
      }
    }
  });

  it("claude has Hook (settings-hooks); codex does not (status inferred)", () => {
    const claude = AGENT_CAPABILITY_PROFILES.find((p) => p.agentId === "claude-code");
    const codex = AGENT_CAPABILITY_PROFILES.find((p) => p.agentId === "codex");
    expect(claude?.capabilities).toContain("Hook");
    expect(claude?.hookSupport).toBe("settings-hooks");
    expect(codex?.capabilities).not.toContain("Hook");
    expect(codex?.hookSupport).toBe("none");
  });

  it("each profile has all 3 modes; each mapping has launchArgumentsPreview + effectiveMode (SV1-PERM-05)", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      expect(p.permissionMappings.map((m) => m.requestedMode)).toEqual([...MODES]);
      for (const m of p.permissionMappings) {
        expect(m.launchArgumentsPreview.length).toBeGreaterThan(0);
        expect(MODES).toContain(m.effectiveMode);
      }
    }
  });

  it("non-YOLO modes list unverified controls (SV1-PERM-02); YOLO warns of no enforced boundary", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      for (const m of p.permissionMappings) {
        const all = m.warnings.join(" ");
        if (m.requestedMode === "YOLO") {
          expect(all).toMatch(/no boundary enforced|dangerously|bypass/i);
          expect(m.unsupportedControls).toEqual([]);
        } else {
          expect(m.unsupportedControls.length).toBeGreaterThan(0);
          expect(all).toMatch(/verify at R1\/R2|SV1-PERM-02/i);
        }
      }
    }
  });

  it("candidate discovery is metadata-only; verified runs the version probe (RT-ADAPTER-06 / ADR-0002)", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      expect(p.candidateDiscovery.metadataOnly).toBe(true);
      expect(p.verifiedDiscovery.versionCommand.length).toBeGreaterThan(0);
      expect(p.verifiedDiscovery.resolves.length).toBeGreaterThan(0);
    }
  });
});
