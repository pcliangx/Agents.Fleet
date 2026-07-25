// @vitest-environment happy-dom

import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { HeadlessTerminalSurface } from "../headless-surface.js";
import { XtermTerminalSurface } from "../xterm-surface.js";
import { GROUND_TRUTH } from "./fixtures.js";

// RT-TERM-01 (R0-09) — the renderer package (@xterm/xterm) and the Daemon
// headless Snapshot Worker package (@xterm/headless) drive the SAME xterm.js
// parser/buffer, so identical bytes must produce identical grid/cursor. This
// is the *engine* identity (parser/buffer). The WebGL2-vs-DOM draw-path
// identity (RT-T-19 "WebGL2 与 DOM 下产生相同 grid") needs a real rendering
// context and is verified in S5 — it is NOT what these assertions cover.

const sid = "s1" as SessionId;
const gen = 1 as Generation;

describe("RT-TERM-01 engine identity — @xterm/xterm parser/buffer matches the oracle (draw path: S5)", () => {
  it.each(GROUND_TRUTH)("xterm ground truth: $name", async (c) => {
    const surface = new XtermTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(c.bytes, { sessionId: sid, generation: gen, seq: 1 as Seq });
    expect(surface.renderText()).toBe(c.text);
    expect(surface.cursorPosition()).toEqual(c.cursor);
  });
});

describe("RT-TERM-01 engine identity — @xterm/xterm == @xterm/headless (parser/buffer)", () => {
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
