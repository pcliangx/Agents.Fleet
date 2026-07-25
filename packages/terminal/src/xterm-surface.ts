// RT-MOD-08 / RT-TERM-04 — renderer-side Terminal Surface: wraps @xterm/xterm
// (the full package the Electron Renderer uses) and opens it on a DOM element.
// It prefers the WebGL2 draw path (@xterm/addon-webgl) and falls back to the
// DOM renderer on init failure or context loss, keeping the SAME Terminal
// instance — parser / buffer / cursor unchanged (RT-TERM-03/04). feed /
// appliedCursor / cursorPosition / renderText live on the shared base. The
// WebGL2-vs-DOM draw-path identity (RT-T-19) is verified by the browser harness
// (S5c); the detached div here does not run a real renderer in unit tests.

import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  BaseTerminalSurface,
  configureUnicode11,
  type TerminalSurfaceOptions,
} from "./base-terminal-surface.js";

export type TerminalDrawMode = "WebGL2" | "DOM";

export interface XtermTerminalOptions extends TerminalSurfaceOptions {
  /**
   * RT-TERM-04 — prefer the WebGL2 draw path (default true). On init failure or
   * context loss the WebGL addon is released and the same Terminal instance
   * keeps rendering with the DOM renderer.
   */
  readonly preferWebGL2?: boolean;
}

export class XtermTerminalSurface extends BaseTerminalSurface {
  private drawModeValue: TerminalDrawMode = "DOM";
  private readonly element: HTMLElement;

  constructor(opts: XtermTerminalOptions) {
    const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
    configureUnicode11(term);
    const element = document.createElement("div");
    term.open(element);
    super(term, opts.maxPendingWriteBytes ?? Number.POSITIVE_INFINITY);
    this.element = element;
    if (opts.preferWebGL2 !== false) {
      this.tryEnableWebGL2(term);
    }
  }

  /** RT-TERM-04 — the active draw path; DOM after any WebGL2 fallback. */
  drawMode(): TerminalDrawMode {
    return this.drawModeValue;
  }

  /**
   * @internal test hook — the canvas the WebGL2 addon rendered to, if any
   * (the one holding a live `webgl2` context). Used by the browser harness to
   * dispatch `webglcontextlost` (RT-T-18).
   */
  webglCanvas(): HTMLCanvasElement | undefined {
    // xterm renders into a Shadow DOM under the container element, so a
    // document/element querySelector won't cross the shadow boundary. Search
    // the shadow root (then the element / document as fallbacks) for the canvas
    // holding a live webgl2 context.
    const roots: ParentNode[] = [];
    if (this.element.shadowRoot) roots.push(this.element.shadowRoot);
    roots.push(this.element, document);
    for (const root of roots) {
      for (const c of root.querySelectorAll("canvas")) {
        if (c.getContext("webgl2")) return c;
      }
    }
    return undefined;
  }

  private tryEnableWebGL2(term: Terminal): void {
    // RT-TERM-04 — attach WebGL2; on context loss release the addon so the same
    // Terminal instance falls back to the DOM renderer. Init failure (no WebGL
    // context, e.g. a headless test env) is caught and leaves DOM mode active.
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => {
        webgl.dispose();
        this.drawModeValue = "DOM";
      });
      this.drawModeValue = "WebGL2";
    } catch {
      this.drawModeValue = "DOM";
    }
  }
}
