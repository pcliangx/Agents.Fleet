// RT-MOD-08 / RT-TERM-02 — headless Terminal Surface: wraps @xterm/headless.
// No DOM, no renderer. This is the deterministic parser/buffer core that both
// the WebGL2 and DOM draw paths share (RT-TERM-03/05), and what the Daemon's
// Snapshot Worker will replay chunks through. xterm.js never leaks past this
// class's public methods (RT-MOD-09); feed/appliedCursor/cursorPosition/
// renderText live on the shared base.

import { Terminal } from "@xterm/headless";
import {
  BaseTerminalSurface,
  configureUnicode11,
  type TerminalSurfaceOptions,
} from "./base-terminal-surface.js";

// RT-TERM-12 — the only two xterm.js internals needed to prove a Snapshot safe
// checkpoint: the parser's current state (0 == GROUND, i.e. not inside a CSI /
// OSC / DCS / escape) and the UTF-8 decoder's interim bytes (no pending partial
// code unit across the write boundary). Reached via the `_core` escape hatch on
// the pinned package set; a stable public-API patch is the RT-TERM-13 exit
// condition (see docs/probes/r0-08-snapshot-checkpoint.md).
interface XtermCheckpointInternals {
  readonly _core: {
    readonly _inputHandler: {
      readonly _parser: { readonly currentState: number };
      readonly _utf8Decoder: { readonly interim: ReadonlyArray<number> };
    };
  };
}

export class HeadlessTerminalSurface extends BaseTerminalSurface {
  private readonly headlessTerm: Terminal;

  constructor(opts: TerminalSurfaceOptions) {
    // xterm 6 gates the `buffer` namespace behind allowProposedApi. Reading the
    // grid/cursor (base) and the Snapshot Worker's addon-serialize both need
    // buffer access; there is no stable v6 alternative for cell reads.
    const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
    configureUnicode11(term);
    super(term, opts.maxPendingWriteBytes ?? Number.POSITIVE_INFINITY);
    this.headlessTerm = term;
  }

  /** RT-TERM-12 / RT-ORDER-08 — parserGround && utf8DecoderEmpty at the last write. */
  isSnapshotSafeCheckpoint(): boolean {
    const ih = (this.headlessTerm as unknown as XtermCheckpointInternals)._core._inputHandler;
    const parserGround = ih._parser.currentState === 0;
    const utf8DecoderEmpty = ih._utf8Decoder.interim[0] === 0;
    return parserGround && utf8DecoderEmpty;
  }
}
