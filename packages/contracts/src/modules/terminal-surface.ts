// RT-MOD-08 / RT-MOD-09 — the Terminal Surface hides xterm.js (the Terminal
// instance, allowed official addons, WebGL2/DOM draw paths, IME and input
// encoding) behind one interface. Business UI, Session Runtime and tests
// depend on this seam; they never import xterm.js types or branch on a draw
// path.

import type { InputSource, SessionStreamCursor } from "../protocol/stream.js";

// RT-T-19 — the active cell cursor, 0-indexed. The deterministic observable
// both draw paths must agree on. Named (not an inline {row, col}) so the
// concept is first-class wherever it is produced or compared.
export interface CellCursor {
  readonly row: number;
  readonly col: number;
}

export interface TerminalInput {
  readonly bytes: Uint8Array;
  readonly source: InputSource;
}

// RT-TERM-02 — feed PTY bytes at their stream identity; the applied cursor
// advances only once xterm.js has finished parsing the write. Reuses
// SessionStreamCursor ({sessionId, generation, seq}) since the frame identity
// and the resumption position are the same triple.
export interface TerminalSurface {
  /**
   * RT-TERM-02 — feed a PTY binary payload as a Uint8Array. Resolves once the
   * write's completion callback has fired, i.e. the bytes are parsed and the
   * applied cursor may advance. Never resolves before parse completion and
   * never rejects on terminal content (PTY bytes are untrusted data, not
   * errors). Rejects only when the frame's seq breaks contiguity within its
   * {sessionId, generation} ("缺失 seq 时不得继续解析"): on a gap/regression
   * the bytes are not written and the cursor is not advanced, so the caller
   * (Desktop Bridge) can re-snapshot (RT-ORDER-06). A changed sessionId or
   * generation is a new producer and resets the seq baseline. Also rejects
   * when the payload exceeds the surface's configured pendingWriteBytes bound
   * (RT-TERM-09; value from RuntimeLimitProfile).
   */
  feed(bytes: Uint8Array, frame: SessionStreamCursor): Promise<void>;

  /**
   * RT-TERM-07 — restore the validated app-owned Snapshot document only when
   * its producer identity matches the Attachment that requested the restore.
   */
  restoreSnapshot(
    bytes: Uint8Array,
    expected: Pick<SessionStreamCursor, "sessionId" | "generation">,
  ): Promise<SessionStreamCursor>;

  /** RT-TERM-06 — encoded xterm input, without exposing the xterm instance. */
  onInput(listener: (input: TerminalInput) => void): () => void;

  /** RT-TERM-02 — the largest seq whose write has completed, or undefined. */
  appliedCursor(): SessionStreamCursor | undefined;

  /** RT-T-19 — the active cell cursor. */
  cursorPosition(): CellCursor;

  /**
   * RT-T-19 — the current buffer rendered as trimmed text, lines joined by
   * "\n", trailing empty lines dropped. A lossy but deterministic proxy for
   * grid-content equality across draw paths.
   */
  renderText(): string;
}
