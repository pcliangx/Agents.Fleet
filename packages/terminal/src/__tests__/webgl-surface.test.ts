// @vitest-environment happy-dom

import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { TERMINAL_PACKAGE_SET } from "../allowlist.js";
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

  it("mounts its single Terminal instance in the Renderer-provided element", () => {
    const container = document.createElement("div");

    new XtermTerminalSurface({
      cols: 80,
      rows: 24,
      preferWebGL2: false,
      element: container,
    });

    expect(container.childElementCount).toBeGreaterThan(0);
  });

  it("exposes terminal input without leaking the xterm instance", () => {
    const surface = new XtermTerminalSurface({
      cols: 80,
      rows: 24,
      preferWebGL2: false,
    });

    expect(typeof surface.onInput).toBe("function");
  });

  it("restores the app-owned Snapshot before applying live delta", async () => {
    const surface = new XtermTerminalSurface({
      cols: 80,
      rows: 24,
      preferWebGL2: false,
    });
    const snapshot = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "s1",
        generation: 1,
        coversThroughSeq: 7,
        terminalPackageSet: TERMINAL_PACKAGE_SET,
        producer: { kind: "InitialState", receivedPtyHandle: false },
        terminal: {
          cols: 80,
          rows: 24,
          serialized: "restored",
          cursor: { row: 0, col: 8 },
          title: "",
        },
        checkpoint: { parserGround: true, utf8DecoderEmpty: true },
        truncated: false,
      }),
    );

    await surface.restoreSnapshot(snapshot, { sessionId: sid, generation: gen });

    expect(surface.renderText()).toBe("restored");
    expect(surface.appliedCursor()).toEqual({
      sessionId: sid,
      generation: gen,
      seq: 7,
    });
  });

  it("rejects a Snapshot from a different Session without rendering it", async () => {
    const surface = new XtermTerminalSurface({
      cols: 80,
      rows: 24,
      preferWebGL2: false,
    });
    const snapshot = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "s_other",
        generation: 1,
        coversThroughSeq: 7,
        terminalPackageSet: TERMINAL_PACKAGE_SET,
        producer: { kind: "InitialState", receivedPtyHandle: false },
        terminal: {
          cols: 80,
          rows: 24,
          serialized: "must not render",
          cursor: { row: 0, col: 15 },
          title: "",
        },
        checkpoint: { parserGround: true, utf8DecoderEmpty: true },
        truncated: false,
      }),
    );

    await expect(
      surface.restoreSnapshot(snapshot, { sessionId: sid, generation: gen }),
    ).rejects.toThrow("incompatible or malformed");

    expect(surface.renderText()).toBe("");
    expect(surface.appliedCursor()).toBeUndefined();
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
