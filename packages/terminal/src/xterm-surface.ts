// RT-MOD-08 / RT-TERM-04 — renderer-side Terminal Surface: wraps @xterm/xterm
// (the full package the Electron Renderer uses) and opens it on a DOM element
// so the Terminal can be constructed. This surface drives the same xterm.js
// parser/buffer as @xterm/headless, so its parser/buffer must agree with the
// headless engine (RT-TERM-01 engine identity). The WebGL2-vs-DOM draw-path
// identity (RT-T-19) needs a real rendering context and is verified in S5 —
// the detached div here does NOT exercise the DOM renderer in unit tests.
// feed/appliedCursor/cursorPosition/renderText live on the shared base.

import { Terminal } from "@xterm/xterm";
import {
  BaseTerminalSurface,
  configureUnicode11,
  type TerminalSurfaceOptions,
} from "./base-terminal-surface.js";

export class XtermTerminalSurface extends BaseTerminalSurface {
  constructor(opts: TerminalSurfaceOptions) {
    const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
    configureUnicode11(term);
    const element = document.createElement("div");
    term.open(element);
    super(term, opts.maxPendingWriteBytes ?? Number.POSITIVE_INFINITY);
  }
}
