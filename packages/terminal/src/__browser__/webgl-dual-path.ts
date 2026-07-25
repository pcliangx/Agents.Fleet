// RT-T-19 / RT-T-18 — in-browser WebGL2 dual-path + context-loss checks.
// Loaded by the Playwright harness (scripts/test-webgl.mjs) in system Chrome
// with swiftshader. NOT a vitest test; it runs in the browser page and reports
// results on window.__afResults.

import type { Generation, Seq, SessionId } from "@agents-fleet/contracts";
import { GROUND_TRUTH } from "../__tests__/fixtures.js";
import { XtermTerminalSurface } from "../xterm-surface.js";

const sid = "s1" as SessionId;
const gen = 1 as Generation;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface CaseResult {
  readonly name: string;
  readonly webgl2: boolean;
  readonly textOk: boolean;
  readonly cursorOk: boolean;
  readonly text: string;
  readonly cursor: { readonly row: number; readonly col: number };
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

export const run = async (): Promise<Results> => {
  // RT-T-19 — WebGL2 path (real swiftshader context) must match the oracle.
  const cases: CaseResult[] = [];
  for (const c of GROUND_TRUTH) {
    const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2: true });
    await surface.feed(c.bytes, { sessionId: sid, generation: gen, seq: 1 as Seq });
    const cursor = surface.cursorPosition();
    cases.push({
      name: c.name,
      webgl2: surface.drawMode() === "WebGL2",
      text: surface.renderText(),
      cursor,
      textOk: surface.renderText() === c.text,
      cursorOk: cursor.row === c.cursor.row && cursor.col === c.cursor.col,
    });
  }

  // RT-T-18 — dispatch webglcontextlost; addon releases, same Terminal keeps
  // rendering via DOM, parser/buffer/cursor unchanged.
  const surface = new XtermTerminalSurface({ cols: 80, rows: 24, preferWebGL2: true });
  await surface.feed(enc("AB"), { sessionId: sid, generation: gen, seq: 1 as Seq });
  const beforeDraw = surface.drawMode();
  const beforeCursor = surface.cursorPosition();
  const beforeText = surface.renderText();
  const canvas = surface.webglCanvas();
  const docCanvasCount = document.querySelectorAll("canvas").length;
  let afterDraw = surface.drawMode();
  if (canvas !== null && canvas !== undefined && beforeDraw === "WebGL2") {
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
      canvasFound: canvas !== null && canvas !== undefined,
      docCanvasCount,
    },
  };
};
