import { describe, expect, it } from "vitest";
import { runQueueBoundaryProbes } from "./boundaries.js";
import { R0_06_QUEUE_LIMITS } from "./scenario.js";

describe("R0-06 queue limit boundaries", () => {
  it("independently proves byte and frame limit - 1 / limit / limit + 1", () => {
    expect(runQueueBoundaryProbes(R0_06_QUEUE_LIMITS)).toEqual({
      byteCap: {
        limitMinusOne: { queueBytes: 1_048_575, resyncRequired: false },
        limit: { queueBytes: 1_048_576, resyncRequired: false },
        limitPlusOne: { queueBytes: 0, resyncRequired: true },
      },
      frameCap: {
        limitMinusOne: { queueFrames: 31, resyncRequired: false },
        limit: { queueFrames: 32, resyncRequired: false },
        limitPlusOne: { queueFrames: 0, resyncRequired: true },
      },
    });
  });
});
