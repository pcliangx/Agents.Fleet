import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { HeadlessTerminalSurface } from "../headless-surface.js";

// RT-TERM-12 — the Snapshot Worker may only advance a Snapshot to a
// parserGround && utf8DecoderEmpty checkpoint. This detects that condition via
// the xterm.js internals exposed by the pinned package set (see probe report:
// the access path is the `_core` escape hatch; a stable public-API patch is the
// RT-TERM-13 exit condition).

const sid = "s1" as SessionId;
const gen = 1 as Generation;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const feed1 = (s: HeadlessTerminalSurface, bytes: Uint8Array): Promise<void> =>
  s.feed(bytes, { sessionId: sid, generation: gen, seq: 1 as Seq });

const surface = (): HeadlessTerminalSurface => new HeadlessTerminalSurface({ cols: 80, rows: 24 });

describe("RT-TERM-12 Snapshot safe-checkpoint detection", () => {
  it("is safe after a complete plain sequence", async () => {
    const s = surface();
    await feed1(s, enc("hello"));
    expect(s.isSnapshotSafeCheckpoint()).toBe(true);
  });

  it("is safe after a complete CSI (ESC[1;2H)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x48]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(true);
  });

  it("is safe after a complete OSC title (ESC]0;t BEL)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x07]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(true);
  });

  it("is safe after a complete multibyte UTF-8 char (人)", async () => {
    const s = surface();
    await feed1(s, enc("人"));
    expect(s.isSnapshotSafeCheckpoint()).toBe(true);
  });

  it("is unsafe mid-CSI (ESC[1; without final byte)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0x1b, 0x5b, 0x31, 0x3b]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(false);
  });

  it("is unsafe mid-OSC (ESC]0;t without BEL/ST)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x74]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(false);
  });

  it("is unsafe mid-DCS (ESC P 1 q without ST)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0x1b, 0x50, 0x31, 0x71]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(false);
  });

  it("is unsafe mid-UTF-8 multibyte (lead byte 0xE4 alone)", async () => {
    const s = surface();
    await feed1(s, Uint8Array.from([0xe4]));
    expect(s.isSnapshotSafeCheckpoint()).toBe(false);
  });
});

// RT-T-22 — feed a sequence containing UTF-8 / CSI / OSC at EVERY byte boundary
// and prove: (a) the detector classifies each boundary (safe iff it ends at a
// complete sequence), and (b) splitting is transparent — the final grid/cursor
// after [0:i]+[i:] equals the unsplit replay, so a Snapshot advanced only on
// safe checkpoints + delta reconstructs the exact same state.

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const len = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

// "AB" | 人(E4 BA BA) | ESC[2;3H | ESC]0;Hi BEL | "Z"
const SEQ = concat(
  enc("AB"),
  Uint8Array.from([0xe4, 0xba, 0xba]),
  Uint8Array.from([0x1b, 0x5b, 0x32, 0x3b, 0x33, 0x48]),
  Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x48, 0x69, 0x07]),
  enc("Z"),
);
// Hand-reasoned safe boundaries (end at a complete sequence): after A, AB, 人,
// the CSI, the OSC. Every other offset lands inside a multibyte/control seq.
const SAFE_OFFSETS = new Set([1, 2, 5, 11, 18]);

describe("RT-T-22 byte-boundary split is transparent + correctly classified", () => {
  // Reference: unsplit replay.
  const ref = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
  beforeAll(async () => {
    await ref.feed(SEQ, { sessionId: sid, generation: gen, seq: 1 as Seq });
  });

  it.each(Array.from({ length: SEQ.length - 1 }, (_, k) => k + 1))(
    "boundary at byte %i: classification correct + split == unsplit",
    async (i) => {
      const s = new HeadlessTerminalSurface({ cols: 80, rows: 24 });
      await s.feed(SEQ.subarray(0, i), { sessionId: sid, generation: gen, seq: 1 as Seq });
      // (a) the detector flags this boundary safe iff it ends a complete sequence.
      expect(s.isSnapshotSafeCheckpoint()).toBe(SAFE_OFFSETS.has(i));
      // continue with the delta
      await s.feed(SEQ.subarray(i), { sessionId: sid, generation: gen, seq: 2 as Seq });
      // (b) final grid/cursor/checkpoint equal the unsplit replay.
      expect(s.renderText()).toBe(ref.renderText());
      expect(s.cursorPosition()).toEqual(ref.cursorPosition());
      expect(s.isSnapshotSafeCheckpoint()).toBe(true);
    },
  );
});
