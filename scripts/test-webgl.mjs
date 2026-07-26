// RT-T-19 / RT-T-18 browser harness. Launches system Chrome with swiftshader
// (real WebGL2, software-rasterized), serves the terminal package via a vite
// dev server, runs the in-browser checks, and asserts. Run via `pnpm
// test:browser`. Intentionally separate from `pnpm test` (needs a browser +
// GPU/swiftshader; not a pure-offline unit suite).

import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  root: process.cwd(),
  server: { port: 0, middlewareMode: false },
  logLevel: "error",
  optimizeDeps: {
    include: [
      "@xterm/xterm",
      "@xterm/headless",
      "@xterm/addon-webgl",
      "@xterm/addon-unicode11",
      "@xterm/addon-serialize",
    ],
  },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://localhost:${port}/packages/terminal/browser/index.html`;

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
try {
  const page = await browser.newPage();
  page.on("console", (msg) => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`  [browser pageerror] ${String(err)}`));
  await page.goto(url, { waitUntil: "networkidle" });
  const outcome = await page
    .waitForFunction(() => window.__afResults || window.__afError, null, { timeout: 20000 })
    .then((el) =>
      el.evaluate(() => ({ res: window.__afResults, err: window.__afError })),
    );

  if (outcome.err) {
    console.error("browser error:", outcome.err);
    process.exitCode = 1;
  } else {
    const r = outcome.res;
    let failed = 0;
    for (const c of r.cases) {
      const dims = c.gridMatch && c.cursorMatch && c.selectionMatch && c.snapshotMatch;
      const oracle = c.kind === "ground-truth" ? c.vsOracle : true;
      const ok = c.webgl2 && dims && oracle;
      if (!ok) failed++;
      console.log(
        `${ok ? "✓" : "✗"} [${c.webgl2 ? "WebGL2" : "DOM!"}] (${c.kind}) ${c.name} — grid=${c.gridMatch} cursor=${c.cursorMatch} selection=${c.selectionMatch} snapshot=${c.snapshotMatch}${c.kind === "ground-truth" ? ` oracle=${c.vsOracle}` : ""}`,
      );
    }
    const cl = r.contextLoss;
    const clOk =
      cl.beforeWebGL2 &&
      cl.afterDrawMode === "DOM" &&
      cl.cursorUnchanged &&
      cl.textUnchanged;
    if (!clOk) failed++;
    console.log(
      `${clOk ? "✓" : "✗"} RT-T-18 context-loss: WebGL2→${cl.afterDrawMode}, cursorUnchanged=${cl.cursorUnchanged}, textUnchanged=${cl.textUnchanged} (canvasFound=${cl.canvasFound}, docCanvasCount=${cl.docCanvasCount})`,
    );
    console.log(
      failed === 0
        ? "\nAll WebGL2 dual-path + context-loss checks passed."
        : `\n${failed} check(s) failed.`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  }
} finally {
  await browser.close();
  await server.close();
}
