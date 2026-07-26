// @vitest-environment happy-dom

import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { XtermTerminalSurface } from "../xterm-surface.js";

// RT-TERM-04 — the renderer surface prefers WebGL2 and falls back to DOM on
// init failure or context loss, keeping the same Terminal instance (parser /
// buffer unchanged). happy-dom has no real WebGL2 context, so init fails here
// and the DOM fallback is exercised. The real WebGL2 path + context-loss is
// covered by the browser harness (S5c).

const sid = "s1" as SessionId;
const gen = 1 as Generation;

describe("RT-TERM-04 WebGL2 surface — draw path + fallback", () => {
  it("uses the DOM draw path when WebGL2 is not preferred", () => {
    const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2: false });
    expect(surface.drawMode()).toBe("DOM");
  });

  it("falls back to DOM and still renders when WebGL2 init fails (no WebGL context)", async () => {
    const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2: true });
    expect(surface.drawMode()).toBe("DOM");
    await surface.feed(new TextEncoder().encode("hi"), {
      sessionId: sid,
      generation: gen,
      seq: 1 as Seq,
    });
    expect(surface.renderText()).toBe("hi");
  });
});
