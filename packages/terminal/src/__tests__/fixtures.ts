// RT-T-19 shared ground-truth fixtures. Single oracle: byte input + expected
// {text, cursor}. Both the headless engine (@xterm/headless, Daemon Snapshot
// Worker) and the renderer engine (@xterm/xterm) are checked against it, which
// transitively proves the two package builds agree (RT-TERM-01 engine identity).

import type { CellCursor } from "@agents-fleet/contracts";

const u = (s: string): Uint8Array => new TextEncoder().encode(s);

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
    bytes: Uint8Array.from([0x41, 0x42, 0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x48, 0x43]),
    text: "CB",
    cursor: { row: 0, col: 1 },
  },
  {
    name: "OSC title consumed (ESC]0;t BEL OK)",
    bytes: Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x07, 0x4f, 0x4b]),
    text: "OK",
    cursor: { row: 0, col: 2 },
  },
];
