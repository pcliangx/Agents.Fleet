// RT-MOD-08 / RT-TERM-04 — renderer-side Terminal Surface: wraps @xterm/xterm
// (the full package the Electron Renderer uses), opens on a DOM element and
// uses the built-in DOM renderer (no WebGL addon attached → DOM path). WebGL2
// attach / context-lost swap lands in S5; this is the DOM-path surface whose
// parser/buffer must agree with @xterm/headless (RT-TERM-01 engine identity).
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
    super(term);
  }
}
