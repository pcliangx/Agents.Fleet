import type { FleetProjectionView, TaskProjection } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { markProjectionStale } from "./projection-state.js";

describe("Renderer projection freshness", () => {
  it("marks the retained projection Stale without erasing its persisted data-gap signal", () => {
    const projection = {
      workspaceId: "ws_1",
      tasks: [{ freshness: "Fresh", dataGap: true } as TaskProjection],
      stateVersion: 7,
      freshness: "Fresh",
      dataGap: true,
      generatedAt: "2026-07-28T00:00:00.000Z",
    } satisfies FleetProjectionView;

    expect(markProjectionStale(projection)).toEqual({
      ...projection,
      tasks: [{ freshness: "Stale", dataGap: true }],
      freshness: "Stale",
      dataGap: true,
    });
    expect(projection.freshness).toBe("Fresh");
  });
});
