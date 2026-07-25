// @vitest-environment happy-dom

import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { HeadlessTerminalSurface } from "../headless-surface.js";
import { XtermTerminalSurface } from "../xterm-surface.js";
import { GROUND_TRUTH } from "./fixtures.js";

// RT-TERM-01 (R0-09) — the renderer engine (@xterm/xterm) and the Daemon
// headless Snapshot Worker engine (@xterm/headless) must produce identical
// grid/cursor for the same bytes, with the same Unicode 11 addon. Each engine
// is checked against the shared oracle below, and the two are then compared
// directly so the renderer-vs-daemon identity contract has its own assertion.

const sid = "s1" as SessionId;
const gen = 1 as Generation;

describe("RT-TERM-01 engine identity — @xterm/xterm matches the oracle", () => {
  it.each(GROUND_TRUTH)("xterm ground truth: $name", async (c) => {
    const surface = new XtermTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(c.bytes, { sessionId: sid, generation: gen, seq: 1 as Seq });
    expect(surface.renderText()).toBe(c.text);
    expect(surface.cursorPosition()).toEqual(c.cursor);
  });
});

describe("RT-TERM-01 engine identity — renderer engine == daemon engine", () => {
  it.each(GROUND_TRUTH)("both engines agree on $name", async (c) => {
    const frame = { sessionId: sid, generation: gen, seq: 1 as Seq };
    const renderer = new XtermTerminalSurface({ cols: 80, rows: 24 });
    const daemon = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    await renderer.feed(c.bytes, frame);
    await daemon.feed(c.bytes, frame);
    expect(renderer.renderText()).toBe(daemon.renderText());
    expect(renderer.cursorPosition()).toEqual(daemon.cursorPosition());
  });
});
