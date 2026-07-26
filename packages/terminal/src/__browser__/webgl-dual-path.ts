// RT-T-19 / RT-T-18 — in-browser WebGL2 dual-path + context-loss checks.
// Loaded by the Playwright harness (scripts/test-webgl.mjs) in system Chrome
// with swiftshader. NOT a vitest test; it runs in the browser page and reports
// results on window.__afResults.
//
// RT-T-19 ("WebGL2 与 DOM 下产生相同 grid/cursor/selection/输入 bytes/Snapshot")
// is proved TWO ways:
//  (1) each GROUND_TRUTH case: a WebGL2 surface matches the oracle (text +
//      cursor), AND a DOM surface matches the same oracle (engine identity);
//  (2) EVERY case (GROUND_TRUTH + DUAL_PATH_CASES): a WebGL2 surface and a DOM
//      surface fed identical bytes agree on grid / cursor / selection / Snapshot
//      — the actual draw-path identity the contract names. DUAL_PATH_CASES adds
//      alternate-screen, OSC 8 hyperlink, mouse-mode and fullwidth-CJK (IME-
//      output representative) dimensions. (IME composition state is input-side;
//      reflow is a resize behavior — both outside a feed-bytes fixture, partial.)

import type { CellCursor, Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { DUAL_PATH_CASES, GROUND_TRUTH } from "../__tests__/fixtures.js";
import { XtermTerminalSurface } from "../xterm-surface.js";

const sid = "s1" as SessionId;
const gen = 1 as Generation;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const frame = { sessionId: sid, generation: gen, seq: 1 as Seq };

export interface CaseResult {
  readonly name: string;
  readonly kind: "ground-truth" | "dual-path";
  readonly webgl2: boolean;
  /** text+cursor == oracle (ground-truth cases only; null for dual-path). */
  readonly vsOracle: boolean | null;
  /** WebGL2.renderText === DOM.renderText */
  readonly gridMatch: boolean;
  /** WebGL2.cursorPosition === DOM.cursorPosition */
  readonly cursorMatch: boolean;
  /** WebGL2.selectionText === DOM.selectionText */
  readonly selectionMatch: boolean;
  /** WebGL2.serializeText === DOM.serializeText (Snapshot rebuild equivalence) */
  readonly snapshotMatch: boolean;
}

export interface Results {
  readonly cases: readonly CaseResult[];
  readonly contextLoss: {
    readonly beforeWebGL2: boolean;
    readonly afterDrawMode: string;
    readonly cursorUnchanged: boolean;
    readonly textUnchanged: boolean;
    readonly canvasFound: boolean;
    readonly docCanvasCount: number;
  };
}

interface SurfaceSnapshot {
  readonly text: string;
  readonly cursor: CellCursor;
  readonly selection: string;
  readonly snapshot: string;
}

const snapshot = async (
  preferWebGL2: boolean,
  bytes: Uint8Array,
): Promise<SurfaceSnapshot & { readonly webgl2: boolean }> => {
  const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2 });
  await surface.feed(bytes, frame);
  return {
    webgl2: surface.drawMode() === "WebGL2",
    text: surface.renderText(),
    cursor: surface.cursorPosition(),
    selection: surface.selectionText(),
    snapshot: surface.serializeText(),
  };
};

const agree = (a: SurfaceSnapshot, b: SurfaceSnapshot) => ({
  gridMatch: a.text === b.text,
  cursorMatch: a.cursor.row === b.cursor.row && a.cursor.col === b.cursor.col,
  selectionMatch: a.selection === b.selection,
  snapshotMatch: a.snapshot === b.snapshot,
});

export const run = async (): Promise<Results> => {
  const cases: CaseResult[] = [];

  // RT-T-19 (1) + (2) — GROUND_TRUTH: WebGL2 vs oracle AND WebGL2 vs DOM.
  for (const c of GROUND_TRUTH) {
    const gl = await snapshot(true, c.bytes);
    const dom = await snapshot(false, c.bytes);
    cases.push({
      name: c.name,
      kind: "ground-truth",
      webgl2: gl.webgl2,
      vsOracle:
        gl.text === c.text && gl.cursor.row === c.cursor.row && gl.cursor.col === c.cursor.col,
      ...agree(gl, dom),
    });
  }

  // RT-T-19 (2) — DUAL_PATH_CASES: WebGL2 vs DOM only (no oracle needed).
  for (const c of DUAL_PATH_CASES) {
    const gl = await snapshot(true, c.bytes);
    const dom = await snapshot(false, c.bytes);
    cases.push({
      name: c.name,
      kind: "dual-path",
      webgl2: gl.webgl2,
      vsOracle: null,
      ...agree(gl, dom),
    });
  }

  // RT-T-18 — dispatch webglcontextlost; addon releases, same Terminal keeps
  // rendering via DOM, parser/buffer/cursor unchanged.
  const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2: true });
  await surface.feed(enc("AB"), frame);
  const beforeDraw = surface.drawMode();
  const beforeCursor = surface.cursorPosition();
  const beforeText = surface.renderText();
  const canvas = surface.webglCanvas();
  const docCanvasCount = document.querySelectorAll("canvas").length;
  let afterDraw = surface.drawMode();
  if (canvas !== undefined && beforeDraw === "WebGL2") {
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    // @xterm/addon-webgl 0.19.0 waits 3000ms for webglcontextrestored before
    // firing onContextLoss (which our surface listens for to release the addon).
    // We must not dispatch a "restored" event, and must wait past the grace window.
    await new Promise<void>((resolve) => setTimeout(resolve, 3200));
    afterDraw = surface.drawMode();
  }
  const afterCursor = surface.cursorPosition();
  const afterText = surface.renderText();

  return {
    cases,
    contextLoss: {
      beforeWebGL2: beforeDraw === "WebGL2",
      afterDrawMode: afterDraw,
      cursorUnchanged: afterCursor.row === beforeCursor.row && afterCursor.col === beforeCursor.col,
      textUnchanged: afterText === beforeText,
      canvasFound: canvas !== undefined,
      docCanvasCount,
    },
  };
};
