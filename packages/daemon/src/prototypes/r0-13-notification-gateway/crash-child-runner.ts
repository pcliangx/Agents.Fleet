// Shared harness for the post-display SIGKILL crash probe: spawns the gateway
// child as an independent tsx process so a real signal can kill it mid-delivery.
// Used by both the evidence driver and the focused crash-recovery test so the
// loader-discovery + spawn/exit logic is defined once.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Walk up from this module to the nearest hoisted tsx ESM loader so the child
// (run under --import) can resolve the prototype sources the same way we do.
export const resolveTsxLoader = (): string => {
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("tsx loader not found");
};

export interface CrashChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

// Runs the gateway child at `childPath` with `configPath`, resolving with its
// exit info. A non-zero exit rejects; a signal exit (the armed SIGKILL path)
// resolves so the caller can assert on the signal. The timeout guards against a
// child that neither self-kills nor exits.
export const runCrashChild = (
  childPath: string,
  configPath: string,
  timeoutMs = 10_000,
): Promise<CrashChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", resolveTsxLoader(), childPath, configPath], {
      stdio: "pipe",
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gateway child timed out: ${stderr}`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`gateway child exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });
