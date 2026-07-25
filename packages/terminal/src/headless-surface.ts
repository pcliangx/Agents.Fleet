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

export class HeadlessTerminalSurface extends BaseTerminalSurface {
  constructor(opts: TerminalSurfaceOptions) {
    // xterm 6 gates the `buffer` namespace behind allowProposedApi. Reading the
    // grid/cursor (base) and the Snapshot Worker's addon-serialize both need
    // buffer access; there is no stable v6 alternative for cell reads.
    const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
    configureUnicode11(term);
    super(term, opts.maxPendingWriteBytes ?? Number.POSITIVE_INFINITY);
  }
}
