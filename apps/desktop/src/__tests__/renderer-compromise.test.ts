import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const itMacArm64 = process.platform === "darwin" && process.arch === "arm64" ? it : it.skip;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Renderer compromise boundary", () => {
  itMacArm64(
    "cannot access Node require/process or dynamically load node-pty",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "af-r010-electron-"));
      const fixturePath = join(tempRoot, "main.cjs");
      const requireFromDesktop = createRequire(
        join(REPOSITORY_ROOT, "apps", "desktop", "package.json"),
      );
      const electronPath = requireFromDesktop("electron") as string;
      await writeFile(
        fixturePath,
        `
          const { app, BrowserWindow } = require("electron");
          const path = require("node:path");
          app.setPath("userData", path.join(__dirname, "user-data"));

          app.whenReady().then(async () => {
            const window = new BrowserWindow({
              show: false,
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            });
            await window.loadURL("data:text/html,<html><body>fixture</body></html>");
            const result = await window.webContents.executeJavaScript(\`
              (async () => {
                let dynamicImport;
                try {
                  await import("node-pty");
                  dynamicImport = "resolved";
                } catch {
                  dynamicImport = "rejected";
                }
                return {
                  requireType: typeof require,
                  processType: typeof process,
                  dynamicImport,
                };
              })()
            \`);
            process.stdout.write("AF_RESULT=" + JSON.stringify(result) + "\\n");
            window.destroy();
            app.quit();
          }).catch((error) => {
            process.stderr.write(String(error));
            app.exit(1);
          });
        `,
        "utf8",
      );

      try {
        const result = await new Promise<{
          readonly code: number | null;
          readonly stdout: string;
          readonly stderr: string;
        }>((resolve, reject) => {
          const child = spawn(electronPath, [fixturePath], {
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
            reject(new Error("Electron compromise fixture timed out"));
          }, 15_000).unref();
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
        });
        const resultLine = result.stdout.split("\n").find((line) => line.startsWith("AF_RESULT="));
        const renderer = JSON.parse(resultLine?.slice("AF_RESULT=".length) ?? "null");

        expect({ code: result.code, renderer, stderr: result.stderr }).toEqual({
          code: 0,
          renderer: {
            requireType: "undefined",
            processType: "undefined",
            dynamicImport: "rejected",
          },
          stderr: "",
        });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
