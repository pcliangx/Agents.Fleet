// S2 — pure limit guard at the parse / allocate / persist / forward boundary
// (RT-LIMIT-02, RT-T-46 shape, issue #15 / R0-16).

import { describe, expect, it } from "vitest";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "../frozen-runtime-limit-profile.js";
import { checkLimit, checkTerminalLimit } from "../limit-guard.js";

describe("checkLimit (RT-LIMIT-02)", () => {
  it("limit - 1 passes", () => {
    expect(checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "attachmentQueueBytes", 1_048_575)).toEqual({
      ok: true,
    });
  });

  it("limit exactly passes — the cap is inclusive", () => {
    expect(checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "attachmentQueueBytes", 1_048_576)).toEqual({
      ok: true,
    });
  });

  it("limit + 1 violates with the typed rejection (R0-06 byte-cap boundary)", () => {
    expect(checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "attachmentQueueBytes", 1_048_577)).toEqual({
      ok: false,
      scope: "profile",
      field: "attachmentQueueBytes",
      allowed: 1_048_576,
      actual: 1_048_577,
    });
  });

  it("zero passes — an empty payload is always within limits", () => {
    expect(checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "commandPayloadBytes", 0)).toEqual({
      ok: true,
    });
  });

  it("a malicious overflow value violates, never decides an allocation", () => {
    const result = checkLimit(
      FROZEN_RUNTIME_LIMIT_PROFILE,
      "streamFramePayloadBytes",
      Number.MAX_SAFE_INTEGER,
    );
    expect(result.ok).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "non-finite or negative actuals fail closed (%s)",
    (actual) => {
      const result = checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "controlLineBytes", actual);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.scope).toBe("profile");
      expect(result.field).toBe("controlLineBytes");
    },
  );
});

describe("checkTerminalLimit (RT-LIMIT-02, nested terminal scope)", () => {
  it("limit - 1 / limit / limit + 1 boundaries", () => {
    const at = FROZEN_RUNTIME_LIMIT_PROFILE.terminal.pendingWriteBytes;
    expect(checkTerminalLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "pendingWriteBytes", at - 1)).toEqual({
      ok: true,
    });
    expect(checkTerminalLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "pendingWriteBytes", at)).toEqual({
      ok: true,
    });
    expect(checkTerminalLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "pendingWriteBytes", at + 1)).toEqual({
      ok: false,
      scope: "terminal",
      field: "pendingWriteBytes",
      allowed: at,
      actual: at + 1,
    });
  });

  it("reports the terminal scope so callers can map StoragePressure per surface", () => {
    const result = checkTerminalLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "scrollbackLines", 10_001);
    expect(result).toEqual({
      ok: false,
      scope: "terminal",
      field: "scrollbackLines",
      allowed: 10_000,
      actual: 10_001,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "non-finite or negative actuals fail closed (%s)",
    (actual) => {
      expect(checkTerminalLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "glyphs", actual).ok).toBe(false);
    },
  );
});
