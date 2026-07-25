import { describe, expect, it } from "vitest";
import { AGENT_CAPABILITY_PROFILES } from "../fixtures/agent-capabilities.js";

describe("R0-04 agent capability fixture", () => {
  it("covers claude-code + codex in order", () => {
    expect(AGENT_CAPABILITY_PROFILES.map((p) => p.agentId)).toEqual(["claude-code", "codex"]);
  });

  it("each profile has all 3 permission modes, each with non-empty argv", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      expect(p.permissionMappings.map((m) => m.requestedMode)).toEqual([
        "Manual",
        "Balanced",
        "YOLO",
      ]);
      for (const m of p.permissionMappings) expect(m.argv.length).toBeGreaterThan(0);
    }
  });

  it("each profile declares Discovery/Transcript/Resume/PermissionMapping", () => {
    for (const p of AGENT_CAPABILITY_PROFILES) {
      for (const cap of ["Discovery", "Transcript", "Resume", "PermissionMapping"] as const) {
        expect(p.capabilities).toContain(cap);
      }
    }
  });

  it("claude has Hook capability (settings-hooks); codex does not (status inferred)", () => {
    const claude = AGENT_CAPABILITY_PROFILES.find((p) => p.agentId === "claude-code");
    const codex = AGENT_CAPABILITY_PROFILES.find((p) => p.agentId === "codex");
    expect(claude?.capabilities).toContain("Hook");
    expect(claude?.hookSupport).toBe("settings-hooks");
    expect(codex?.capabilities).not.toContain("Hook");
    expect(codex?.hookSupport).toBe("none");
  });
});
