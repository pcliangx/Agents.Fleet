// RT-MOD-08 — shared base for Terminal Surface implementations. Both the
// headless engine (@xterm/headless, Daemon Snapshot Worker) and the renderer
// engine (@xterm/xterm) drive the same xterm.js parser/buffer, so feed /
// appliedCursor / cursorPosition / renderText are identical here. Subclasses
// differ only in how they construct the Terminal (and that the renderer opens
// it on a DOM element). xterm.js types stay behind this module (RT-MOD-09).

import type { CellCursor, SessionStreamCursor, TerminalSurface } from "@agents-fleet/contracts";
import { Unicode11Addon } from "@xterm/addon-unicode11";

export interface TerminalSurfaceOptions {
  readonly cols: number;
  readonly rows: number;
  /**
   * RT-TERM-09 — reject a feed whose bytes exceed this many bytes, before
   * touching xterm.js. The value comes from
   * RuntimeLimitProfile.terminal.pendingWriteBytes (frozen by #16); unset
   * (unbounded) until the profile is wired in, since RT-LIMIT-01 forbids an
   * unversioned default. The primary untrusted-length boundary remains the
   * frame decoder (RT-STREAM-05); this is the Terminal Surface's own bound.
   */
  readonly maxPendingWriteBytes?: number;
}

// Structural slice of an xterm.js Terminal the base reads/writes. Both
// @xterm/headless and @xterm/xterm Terminals satisfy it; it keeps xterm types
// out of the public seam.
interface ReadableXtermTerminal {
  write(data: Uint8Array, callback: () => void): void;
  readonly buffer: {
    readonly active: {
      readonly cursorX: number;
      readonly cursorY: number;
      readonly length: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

interface UnicodeConfigurable {
  loadAddon(addon: unknown): void;
  unicode: { activeVersion: string };
}

// RT-TERM-01 — load the identical Unicode 11 width/grapheme tables on any
// xterm Terminal so the live Terminal and the Snapshot Worker cannot diverge.
// The addon is mandatory (ADR-0007); this is a construct-time forced load.
// Addon lifecycle — unload / reload / version handshake on RT-TERM-10 upgrade
// or RT-TERM-04 WebGL fallback — is a future concern, not wired here.
export const configureUnicode11 = (term: UnicodeConfigurable): void => {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
};

// RT-TERM-02 — feed refused because the frame's seq is not the next expected
// for its {sessionId, generation}. The bytes are NOT written and the cursor is
// NOT advanced; the caller must re-snapshot (RT-ORDER-06).
export class TerminalSeqGapError extends Error {
  constructor(
    readonly expected: SessionStreamCursor | undefined,
    readonly received: SessionStreamCursor,
  ) {
    super(
      `seq gap: expected ${expected === undefined ? "first frame" : `seq ${Number(expected.seq) + 1} for session ${expected.sessionId} gen ${expected.generation}`}, received seq ${received.seq}`,
    );
    this.name = "TerminalSeqGapError";
  }
}

// RT-TERM-09 — feed refused because bytes exceed the configured
// pendingWriteBytes limit. The bytes are NOT written and the cursor is NOT
// advanced.
export class TerminalPendingWriteLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly received: number,
  ) {
    super(`pendingWriteBytes exceeded: limit ${limit}, received ${received}`);
    this.name = "TerminalPendingWriteLimitError";
  }
}

export abstract class BaseTerminalSurface implements TerminalSurface {
  protected appliedStreamCursor: SessionStreamCursor | undefined;

  constructor(
    protected readonly term: ReadableXtermTerminal,
    private readonly maxPendingWriteBytes: number = Number.POSITIVE_INFINITY,
  ) {}

  feed(bytes: Uint8Array, frame: SessionStreamCursor): Promise<void> {
    // RT-TERM-09 — bound the write before touching xterm.js. See
    // TerminalSurfaceOptions.maxPendingWriteBytes; default unbounded until #16.
    if (bytes.length > this.maxPendingWriteBytes) {
      return Promise.reject(
        new TerminalPendingWriteLimitError(this.maxPendingWriteBytes, bytes.length),
      );
    }
    // RT-TERM-02 — within the same {sessionId, generation} the seq must be
    // exactly lastSeq + 1; a gap or regression is refused before writing. A
    // changed sessionId or generation is a new producer and resets the baseline.
    const applied = this.appliedStreamCursor;
    if (
      applied !== undefined &&
      applied.sessionId === frame.sessionId &&
      applied.generation === frame.generation
    ) {
      if (frame.seq !== (applied.seq as number) + 1) {
        return Promise.reject(new TerminalSeqGapError(applied, frame));
      }
    }
    return new Promise<void>((resolve) => {
      this.term.write(bytes, () => {
        this.appliedStreamCursor = frame;
        resolve();
      });
    });
  }

  appliedCursor(): SessionStreamCursor | undefined {
    return this.appliedStreamCursor;
  }

  cursorPosition(): CellCursor {
    const b = this.term.buffer.active;
    return { row: b.cursorY, col: b.cursorX };
  }

  renderText(): string {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++) {
      lines.push(b.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}
