// RT-T-19 shared fixtures. GROUND_TRUTH carries an oracle {text, cursor} and
// checks both the headless engine (@xterm/headless, Daemon Snapshot Worker) and
// the renderer engine (@xterm/xterm) against it (RT-TERM-01 engine identity).
// DUAL_PATH_CASES carries only bytes; it checks a WebGL2 surface vs a DOM
// surface agree on grid/cursor/selection/Snapshot (RT-T-19, browser harness) —
// no oracle needed.

import type { CellCursor } from "@agents-fleet/contracts";

const u = (s: string): Uint8Array => new TextEncoder().encode(s);
const esc = (rest: number[]): Uint8Array => new Uint8Array([0x1b, ...rest]);
const csi = (s: string): Uint8Array => esc([0x5b, ...u(s)]);
const osc = (s: string): Uint8Array => esc([0x5d, ...u(s)]);
const BEL = 0x07;

export interface GroundTruthCase {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly cursor: CellCursor;
}

export const GROUND_TRUTH: readonly GroundTruthCase[] = [
  {
    name: "ASCII with CRLF",
    bytes: u("hello\r\nworld"),
    text: "hello\nworld",
    cursor: { row: 1, col: 5 },
  },
  { name: "CJK wide chars", bytes: u("你好"), text: "你好", cursor: { row: 0, col: 4 } },
  { name: "emoji wide char", bytes: u("😀"), text: "😀", cursor: { row: 0, col: 2 } },
  {
    name: "CSI cursor-position then overwrite (ESC[1;1H C)",
    bytes: new Uint8Array([...u("AB"), ...csi("1;1H"), ...u("C")]),
    text: "CB",
    cursor: { row: 0, col: 1 },
  },
  {
    name: "OSC title consumed (ESC]0;t BEL OK)",
    bytes: new Uint8Array([...osc("0;t"), BEL, ...u("OK")]),
    text: "OK",
    cursor: { row: 0, col: 2 },
  },
];

// RT-T-19 — additional byte sequences for the WebGL2-vs-DOM dual-path
// comparison (browser harness only). These do NOT carry an oracle {text,
// cursor}: the contract is only that a WebGL2 surface and a DOM surface fed
// the SAME bytes produce identical grid / cursor / selection / Snapshot.
// Covers the alternate-screen, OSC 8 hyperlink, mouse-mode and fullwidth-CJK
// (IME-output representative) dimensions RT-T-19 names. IME composition state
// is input-side and reflow is a resize behavior — both outside a feed-bytes
// fixture; they remain partial (noted in the probe + PR body).
export interface DualPathCase {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export const DUAL_PATH_CASES: readonly DualPathCase[] = [
  {
    name: "alternate screen enter/exit (DECSET ?1049h/l)",
    bytes: new Uint8Array([...csi("?1049h"), ...u("ALT"), ...csi("?1049l")]),
  },
  {
    name: "OSC 8 hyperlink",
    bytes: new Uint8Array([
      ...osc("8;;https://example.com"),
      BEL,
      ...u("LINK"),
      ...osc("8;;"),
      BEL,
    ]),
  },
  {
    name: "mouse mode enable/disable (DECSET ?1000h/l)",
    bytes: new Uint8Array([...csi("?1000h"), ...u("m"), ...csi("?1000l")]),
  },
  {
    name: "fullwidth CJK (IME-output representative)",
    bytes: u("ＡＢＣデ"),
  },
  {
    name: "mixed CJK + CSI cursor-pos + OSC title",
    bytes: new Uint8Array([
      ...u("日本語"),
      ...csi("1;1H"),
      ...u("Ａ"),
      ...osc("0;t"),
      BEL,
      ...u("X"),
    ]),
  },
];
