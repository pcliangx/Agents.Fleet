import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import { HeadlessTerminalSurface } from "../headless-surface.js";
import { GROUND_TRUTH } from "./fixtures.js";

// RT-TERM-02 — feeding PTY bytes advances the applied cursor to the fed seq
// only once xterm.js has parsed the write. RT-MOD-09: the test depends on the
// xterm-free TerminalSurface shape, not on xterm.js types.

const sid = "s1" as SessionId;
const gen = 1 as Generation;

describe("RT-TERM-02 headless terminal surface (@xterm/headless)", () => {
  it("advances appliedCursor to the fed seq once the bytes are parsed", async () => {
    const surface = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    expect(surface.appliedCursor()).toBeUndefined();

    await surface.feed(new TextEncoder().encode("hello"), {
      sessionId: sid,
      generation: gen,
      seq: 1 as Seq,
    });

    expect(surface.appliedCursor()).toEqual({ sessionId: sid, generation: gen, seq: 1 });
  });

  // RT-T-19 ground truth: the headless engine produces the oracle {text, cursor}
  // for each fixture. The renderer engine (engine-identity.test.ts) must match.
  it.each(GROUND_TRUTH)("ground truth: $name", async (c) => {
    const surface = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(c.bytes, { sessionId: sid, generation: gen, seq: 1 as Seq });
    expect(surface.renderText()).toBe(c.text);
    expect(surface.cursorPosition()).toEqual(c.cursor);
  });
});

describe("RT-TERM-02 headless surface — seq contiguity", () => {
  it("accepts contiguous seq within the same generation", async () => {
    const surface = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(new TextEncoder().encode("AB"), {
      sessionId: sid,
      generation: gen,
      seq: 1 as Seq,
    });
    await surface.feed(new TextEncoder().encode("CD"), {
      sessionId: sid,
      generation: gen,
      seq: 2 as Seq,
    });
    expect(surface.appliedCursor()?.seq).toBe(2);
    expect(surface.renderText()).toBe("ABCD");
  });

  it("refuses a gapped seq without writing or advancing the cursor", async () => {
    const surface = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(new TextEncoder().encode("AB"), {
      sessionId: sid,
      generation: gen,
      seq: 1 as Seq,
    });
    await expect(
      surface.feed(new TextEncoder().encode("CD"), {
        sessionId: sid,
        generation: gen,
        seq: 3 as Seq,
      }),
    ).rejects.toThrow();
    expect(surface.appliedCursor()?.seq).toBe(1);
    expect(surface.renderText()).toBe("AB");
  });

  it("treats a generation change as a new producer and resets the baseline", async () => {
    const surface = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
    await surface.feed(new TextEncoder().encode("AB"), {
      sessionId: sid,
      generation: gen,
      seq: 1 as Seq,
    });
    await surface.feed(new TextEncoder().encode("XY"), {
      sessionId: sid,
      generation: 2 as Generation,
      seq: 1 as Seq,
    });
    expect(surface.appliedCursor()?.generation).toBe(2);
  });
});
