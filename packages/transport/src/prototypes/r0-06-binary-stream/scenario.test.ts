import { describe, expect, it } from "vitest";
import { createR006Scenario, targetFrameCount } from "./scenario.js";

describe("R0-06 fixed load scenario", () => {
  it("defines exact 60-second frame counts and version provenance", () => {
    const scenario = createR006Scenario(60);

    expect(scenario).toMatchObject({
      durationSeconds: 60,
      framePayloadBytes: 65_536,
      platformMatrixVersion: 1,
      runtimeLimitProfileVersion: 0,
      provenanceStatus: "matrix-frozen-limit-profile-pending",
      queueLimits: { bytes: 1_048_576, frames: 32 },
    });
    expect(scenario.sessions).toHaveLength(10);
    expect(scenario.sessions.map((session) => session.role)).toEqual([
      "Hot",
      "Slow",
      "Hidden",
      "Background",
      "Background",
      "Background",
      "Background",
      "Background",
      "Background",
      "Background",
    ]);
    const hot = scenario.sessions.find((session) => session.role === "Hot");
    expect(hot).toBeDefined();
    if (hot === undefined) throw new Error("missing Hot Session");
    expect(targetFrameCount(hot, scenario)).toBe(4_800);
    expect(
      scenario.sessions.reduce((total, session) => total + targetFrameCount(session, scenario), 0),
    ).toBe(6_240);
  });
});
