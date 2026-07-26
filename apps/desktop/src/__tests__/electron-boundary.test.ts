import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform as esbuildTransform } from "esbuild";
import { describe, expect, it } from "vitest";

// SV1-T-16 (core) / SV1-T-04 — real Electron attack fixtures against the
// actual boundary modules in src/main/. A throwaway Electron app is spawned;
// an attacker-controlled renderer (given a generic-invoke preload on purpose)
// attempts protocol traversal, forged senders, subframes, navigation,
// new-window, webview attach, download, permission requests, CSP bypass and
// arbitrary IPC channels. Everything must fail closed.

const itMacArm64 = process.platform === "darwin" && process.arch === "arm64" ? it : it.skip;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MAIN_SRC = join(REPOSITORY_ROOT, "apps", "desktop", "src", "main");
const SECRET_MARKER = "AF-SECRET-7f3a9";

const BOUNDARY_MODULES = [
  "asset-path",
  "app-protocol",
  "csp",
  "window-guard",
  "ipc-guard",
  "trusted-ipc",
];

/** Transpile the real boundary modules next to the fixture app (ESM). */
const transpileBoundaryModules = async (outDir: string): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  for (const name of BOUNDARY_MODULES) {
    const source = await readFile(join(MAIN_SRC, `${name}.ts`), "utf8");
    // TypeScript 7 (Go-native) dropped its JS transpile API (ts.transpileModule /
    // ts.ModuleKind are undefined), so use esbuild (already bundled with vite).
    const output = await esbuildTransform(source, {
      format: "esm",
      loader: "ts",
      target: "es2022",
    });
    await writeFile(join(outDir, `${name}.js`), output.code);
  }
};

// The fixture app. Attack probes run sequentially; each result is recorded
// and emitted as one AF_RESULT JSON line. String concatenation only (no
// template literals) so this file can embed it inside a template literal.
const FIXTURE_MAIN = `
import { app, BrowserWindow, net, session, webContents } from "electron";
import http from "node:http";
import { APP_ORIGIN, installAppProtocol, registerAppSchemePrivileges } from "./mods/app-protocol.js";
import { RENDERER_CSP, installContentSecurityPolicy } from "./mods/csp.js";
import { guardSession, guardWebContents } from "./mods/window-guard.js";
import { validateIpcSender } from "./mods/ipc-guard.js";
import { handleTrustedIpc } from "./mods/trusted-ipc.js";

const ASSET_ROOT = "__ASSET_ROOT__";
const PRELOAD = "__PRELOAD__";
const SECRET = "__SECRET__";
const results = {};
const violations = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const step = async (name, fn) => {
  try {
    results[name] = await fn();
  } catch (error) {
    results[name] = { stepError: String(error) };
  }
};

registerAppSchemePrivileges();
app.setPath("userData", "__USER_DATA__");

const emit = (code) => {
  process.stdout.write("AF_RESULT=" + JSON.stringify({ results, violations }) + "\\n");
  app.exit(code);
};

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  installContentSecurityPolicy(ses);
  guardSession(ses, (kind, detail) => violations.push({ kind, detail }));
  installAppProtocol({ assetRoot: ASSET_ROOT, contentSecurityPolicy: RENDERER_CSP });
  app.on("web-contents-created", (_event, contents) => {
    guardWebContents(contents, (kind, detail) => violations.push({ kind, detail }));
  });

  // ---- SV1-ELECTRON-01: protocol attacks ----
  await step("protocol", async () => {
    const fetchStatus = async (url) => {
      const response = await net.fetch(url);
      const body = await response.text();
      return { status: response.status, leakedSecret: body.includes(SECRET) };
    };
    return {
      asset: await fetchStatus(APP_ORIGIN + "/index.html"),
      traversal: await fetchStatus(APP_ORIGIN + "/../secret.txt"),
      encodedTraversal: await fetchStatus(APP_ORIGIN + "/%2e%2e/secret.txt"),
      encodedBackslash: await fetchStatus(APP_ORIGIN + "/%5c..%5csecret.txt"),
      nulByte: await fetchStatus(APP_ORIGIN + "/%00secret.txt"),
      hostSpoof: await fetchStatus("af-app://evil.example/index.html"),
      symlinkEscape: await fetchStatus(APP_ORIGIN + "/linked-secret.txt"),
      missing: await fetchStatus(APP_ORIGIN + "/no-such-asset.js"),
      directory: await fetchStatus(APP_ORIGIN + "/subdir"),
    };
  });

  const mkWindow = (extra) =>
    new BrowserWindow({
      show: false,
      webPreferences: Object.assign(
        { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
        extra ?? {},
      ),
    });

  const invokeFrom = async (win, channel) => {
    try {
      const value = await win.webContents.executeJavaScript(
        "window.__probe.invoke(" + JSON.stringify(channel) + ")",
        true,
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  };

  // ---- SV1-ELECTRON-02: IPC sender / frame attacks ----
  const w1 = mkWindow();
  const trustedContext = { expectedWebContents: w1.webContents, allowedOrigin: APP_ORIGIN };
  handleTrustedIpc("af:get-connection-info", trustedContext, () => SECRET + "-conn");
  await w1.loadURL(APP_ORIGIN + "/index.html");

  await step("ipcTrustedWindow", async () => ({
    declaredChannel: await invokeFrom(w1, "af:get-connection-info"),
    genericChannel: await invokeFrom(w1, "af:arbitrary"),
  }));

  const w2 = mkWindow();
  await w2.loadURL(APP_ORIGIN + "/index.html");
  await step("ipcUnexpectedWebContents", () => invokeFrom(w2, "af:get-connection-info"));

  await step("ipcSubframe", async () => {
    await w1.webContents.executeJavaScript(
      "new Promise((resolveFrame) => {" +
        "const frame = document.createElement('iframe');" +
        "frame.src = " + JSON.stringify(APP_ORIGIN + "/frame.html") + ";" +
        "frame.onload = resolveFrame;" +
        "document.body.appendChild(frame);" +
        "})",
      true,
    );
    const subframe = w1.webContents.mainFrame.frames[0];
    if (!subframe) return { stepError: "no subframe" };
    return {
      subframeVerdict: validateIpcSender(w1.webContents, subframe, trustedContext),
      mainFrameVerdict: validateIpcSender(w1.webContents, w1.webContents.mainFrame, trustedContext),
    };
  });

  await step("ipcDestroyedSender", async () => {
    const w3 = mkWindow();
    await w3.loadURL(APP_ORIGIN + "/index.html");
    const context = { expectedWebContents: w3.webContents, allowedOrigin: APP_ORIGIN };
    const contents = w3.webContents;
    const frame = contents.mainFrame;
    const destroyed = new Promise((resolveDestroyed) => contents.once("destroyed", resolveDestroyed));
    w3.destroy();
    await Promise.race([destroyed, sleep(2000)]);
    return validateIpcSender(contents, frame, context);
  });

  // ---- SV1-ELECTRON-03: navigation / new-window / webview / download / permission ----
  await step("navigation", async () => {
    const before = w1.webContents.getURL();
    await w1.webContents.executeJavaScript('window.location.href = "https://evil.example/"', true);
    await sleep(500);
    return { before, after: w1.webContents.getURL() };
  });

  await step("newWindow", async () => {
    const windowOpenReturnedNull = await w1.webContents.executeJavaScript(
      'window.open("https://evil.example/") === null',
      true,
    );
    await w1.webContents.executeJavaScript(
      "const a = document.createElement('a');" +
        'a.href = "https://evil.example/";' +
        'a.target = "_blank";' +
        "document.body.appendChild(a);" +
        "a.click();",
      true,
    );
    await sleep(300);
    return { windowOpenReturnedNull, windowCount: BrowserWindow.getAllWindows().length };
  });

  await step("webview", async () => {
    const w4 = mkWindow({ webviewTag: true });
    await w4.loadURL(APP_ORIGIN + "/index.html");
    await w4.webContents.executeJavaScript(
      "const view = document.createElement('webview');" +
        'view.setAttribute("src", "https://evil.example/");' +
        "document.body.appendChild(view);",
      true,
    );
    await sleep(500);
    const guests = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview").length;
    return { guests };
  });

  await step("download", async () => {
    w1.webContents.downloadURL(APP_ORIGIN + "/app.js");
    await sleep(500);
    return { denied: violations.some((violation) => violation.kind === "download") };
  });

  await step("permissions", async () => {
    const getUserMedia = await w1.webContents.executeJavaScript(
      "navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (error) => 'denied:' + error.name)",
      true,
    );
    const notification = await w1.webContents.executeJavaScript(
      "Notification.requestPermission()",
      true,
    );
    return { getUserMedia, notification };
  });

  // ---- SV1-ELECTRON-04: CSP bypass attempts ----
  await step("csp", async () => {
    const evalBlocked = await w1.webContents.executeJavaScript(
      "(() => { try { eval('1+1'); return false; } catch { return true; } })()",
      true,
    );
    const functionCtorBlocked = await w1.webContents.executeJavaScript(
      "(() => { try { new Function('return 1')(); return false; } catch { return true; } })()",
      true,
    );
    const externalScriptBlocked = await w1.webContents.executeJavaScript(
      "new Promise((resolveScript) => {" +
        "const script = document.createElement('script');" +
        "script.src = 'https://evil.example/x.js';" +
        "script.onerror = () => resolveScript(true);" +
        "script.onload = () => resolveScript(false);" +
        "document.head.appendChild(script);" +
        "setTimeout(() => resolveScript('timeout'), 5000);" +
        "})",
      true,
    );
    const externalFetchBlocked = await w1.webContents.executeJavaScript(
      "fetch('https://evil.example/').then(() => false, () => true)",
      true,
    );
    const selfScriptRan = await w1.webContents.executeJavaScript(
      "window.__fixtureScriptRan === true",
      true,
    );
    const w5 = mkWindow();
    await w5.loadURL(APP_ORIGIN + "/inline.html");
    const inlineScriptBlocked = await w5.webContents.executeJavaScript(
      "window.pwned === undefined",
      true,
    );
    w5.destroy();
    return {
      evalBlocked,
      functionCtorBlocked,
      externalScriptBlocked,
      externalFetchBlocked,
      selfScriptRan,
      inlineScriptBlocked,
    };
  });

  // ---- dev-only form: explicit http origin binding (contrasts with release) ----
  await step("devPosture", async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<html><body>dev</body></html>");
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const origin = "http://127.0.0.1:" + address.port;
    const w6 = mkWindow();
    handleTrustedIpc(
      "af:dev-ping",
      { expectedWebContents: w6.webContents, allowedOrigin: origin },
      () => "pong",
    );
    await w6.loadURL(origin + "/");
    const allowed = await invokeFrom(w6, "af:dev-ping");
    await w6.loadURL(APP_ORIGIN + "/index.html");
    const wrongOrigin = await invokeFrom(w6, "af:dev-ping");
    server.close();
    return { allowed, wrongOrigin };
  });

  // ---- last: navigated-away frame of the trusted window (mutates w1) ----
  await step("ipcNavigatedFrame", async () => {
    await w1.loadURL("data:text/html,<p>navigated</p>");
    return invokeFrom(w1, "af:get-connection-info");
  });

  emit(0);
}).catch((error) => {
  process.stderr.write(String(error));
  emit(1);
});
`;

describe("Electron boundary attack fixtures (SV1-T-16)", () => {
  itMacArm64(
    "protocol / IPC / navigation / window / webview / download / permission / CSP attacks all fail closed",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "af-r011-boundary-"));
      const appDir = join(fixtureRoot, "app");
      const assetRoot = join(fixtureRoot, "assets");

      try {
        // Fixture app: package.json (ESM), transpiled boundary modules, a
        // generic-invoke preload (simulating a compromised renderer) and a
        // miniature asset root with an escaping symlink + external secret.
        await mkdir(join(appDir, "mods"), { recursive: true });
        await mkdir(join(assetRoot, "subdir"), { recursive: true });
        await writeFile(
          join(appDir, "package.json"),
          JSON.stringify({ name: "af-boundary-fixture", version: "0.0.0", main: "main.mjs" }),
        );
        await transpileBoundaryModules(join(appDir, "mods"));
        await writeFile(
          join(assetRoot, "index.html"),
          '<html><head><script src="./app.js"></script></head><body>fixture</body></html>',
        );
        await writeFile(join(assetRoot, "app.js"), "window.__fixtureScriptRan = true;");
        await writeFile(join(assetRoot, "frame.html"), "<html><body>frame</body></html>");
        await writeFile(
          join(assetRoot, "inline.html"),
          "<html><head><script>window.pwned = true;</script></head><body>inline</body></html>",
        );
        await writeFile(join(fixtureRoot, "secret.txt"), SECRET_MARKER);
        await symlink("../secret.txt", join(assetRoot, "linked-secret.txt"));
        await writeFile(
          join(appDir, "preload.cjs"),
          [
            'const { contextBridge, ipcRenderer } = require("electron");',
            'contextBridge.exposeInMainWorld("__probe", {',
            "  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),",
            "});",
          ].join("\n"),
        );
        await writeFile(
          join(appDir, "main.mjs"),
          FIXTURE_MAIN.replaceAll("__ASSET_ROOT__", assetRoot)
            .replaceAll("__PRELOAD__", join(appDir, "preload.cjs"))
            .replaceAll("__USER_DATA__", join(fixtureRoot, "user-data"))
            .replaceAll("__SECRET__", SECRET_MARKER),
        );

        const requireFromDesktop = createRequire(
          join(REPOSITORY_ROOT, "apps", "desktop", "package.json"),
        );
        const electronPath = requireFromDesktop("electron") as string;

        const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolveRun, reject) => {
            const child = spawn(electronPath, [appDir], {
              env: {
                HOME: process.env.HOME ?? "/tmp",
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                TMPDIR: process.env.TMPDIR ?? "/tmp",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            });
            child.stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Electron boundary fixture timed out"));
            }, 100_000).unref();
            child.on("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.on("exit", (code) => {
              clearTimeout(timer);
              resolveRun({ code, stdout, stderr });
            });
          },
        );

        const resultLine = run.stdout.split("\n").find((line) => line.startsWith("AF_RESULT="));
        if (resultLine === undefined) {
          throw new Error(
            `fixture produced no AF_RESULT (exit ${String(run.code)})\nstderr:\n${run.stderr}`,
          );
        }
        const fixture = JSON.parse(resultLine.slice("AF_RESULT=".length)) as {
          results: Record<string, never>;
          violations: Array<{ kind: string; detail: string }>;
        };
        // Surface the full fixture output in assertion failures for triage.
        const show = (): string => JSON.stringify(fixture, null, 2);

        type Step = Record<string, never>;
        const step = (name: string): Step => fixture.results[name] as Step;

        // ---- SV1-ELECTRON-01: protocol ----
        const protocol = step("protocol") as Record<
          string,
          { status: number; leakedSecret: boolean }
        >;
        expect(protocol.asset?.status, show()).toBe(200);
        expect(protocol.asset?.leakedSecret, show()).toBe(false);
        for (const attack of [
          "traversal",
          "encodedTraversal",
          "encodedBackslash",
          "nulByte",
          "hostSpoof",
          "symlinkEscape",
          "missing",
          "directory",
        ]) {
          expect([403, 404], `${attack}: ${show()}`).toContain(protocol[attack]?.status);
          expect(protocol[attack]?.leakedSecret, `${attack}: ${show()}`).toBe(false);
        }

        // ---- SV1-ELECTRON-02: IPC ----
        const ipcTrusted = step("ipcTrustedWindow") as {
          declaredChannel: { ok: boolean; value?: string };
          genericChannel: { ok: boolean; error?: string };
        };
        expect(ipcTrusted.declaredChannel, show()).toEqual({
          ok: true,
          value: `${SECRET_MARKER}-conn`,
        });
        expect(ipcTrusted.genericChannel.ok, show()).toBe(false);
        expect(ipcTrusted.genericChannel.error, show()).toMatch(/No handler registered/);

        const ipcUnexpected = step("ipcUnexpectedWebContents") as { ok: boolean; error?: string };
        expect(ipcUnexpected.ok, show()).toBe(false);
        expect(ipcUnexpected.error, show()).toMatch(/IPC denied/);

        const ipcSubframe = step("ipcSubframe") as {
          subframeVerdict: { trusted: boolean };
          mainFrameVerdict: { trusted: boolean };
        };
        expect(ipcSubframe.subframeVerdict.trusted, show()).toBe(false);
        expect(ipcSubframe.mainFrameVerdict.trusted, show()).toBe(true);

        const ipcDestroyed = step("ipcDestroyedSender") as { trusted: boolean };
        expect(ipcDestroyed.trusted, show()).toBe(false);

        const ipcNavigated = step("ipcNavigatedFrame") as { ok: boolean; error?: string };
        expect(ipcNavigated.ok, show()).toBe(false);
        expect(ipcNavigated.error, show()).toMatch(/IPC denied/);

        // ---- SV1-ELECTRON-03 ----
        const navigation = step("navigation") as { before: string; after: string };
        expect(navigation.after, show()).toBe(navigation.before);
        expect(navigation.after, show()).toMatch(/^af-app:\/\//);
        expect(
          fixture.violations.some(
            (violation) =>
              violation.kind === "navigation" && violation.detail.includes("evil.example"),
          ),
          show(),
        ).toBe(true);

        const newWindow = step("newWindow") as {
          windowOpenReturnedNull: boolean;
          windowCount: number;
        };
        expect(newWindow.windowOpenReturnedNull, show()).toBe(true);
        expect(newWindow.windowCount, show()).toBe(2); // w1 + w2 only

        const webview = step("webview") as { guests: number };
        expect(webview.guests, show()).toBe(0);
        expect(
          fixture.violations.some((violation) => violation.kind === "webview-attach"),
          show(),
        ).toBe(true);

        const download = step("download") as { denied: boolean };
        expect(download.denied, show()).toBe(true);

        const permissions = step("permissions") as {
          getUserMedia: string;
          notification: string;
        };
        expect(permissions.getUserMedia, show()).toMatch(/^denied:/);
        expect(permissions.notification, show()).toBe("denied");

        // ---- SV1-ELECTRON-04: CSP ----
        const csp = step("csp") as Record<string, boolean>;
        expect(csp, show()).toEqual({
          evalBlocked: true,
          functionCtorBlocked: true,
          externalScriptBlocked: true,
          externalFetchBlocked: true,
          selfScriptRan: true,
          inlineScriptBlocked: true,
        });

        // ---- dev-only form ----
        const devPosture = step("devPosture") as {
          allowed: { ok: boolean; value?: string };
          wrongOrigin: { ok: boolean };
        };
        expect(devPosture.allowed, show()).toEqual({ ok: true, value: "pong" });
        expect(devPosture.wrongOrigin.ok, show()).toBe(false);

        expect(run.code, show()).toBe(0);

        if (process.env.AF_PROBE_EVIDENCE === "1") {
          process.stdout.write(`AF_EVIDENCE=${JSON.stringify(fixture)}\n`);
        }
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
