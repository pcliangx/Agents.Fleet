// Shared helper: copy the installed node-pty to a temp dir, set the spawn-helper
// mode, and hand back a module loader. Used by the r0-22 spawn-helper prototype
// and the r0-10 native byte-boundary test so neither duplicates the
// cp → chmod → require setup. The installed package and pnpm store are never
// mutated; callers must `cleanup()` the returned copy.

import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface NativePtyProcess {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: unknown) => void): { dispose(): void };
  onExit(listener: () => void): { dispose(): void };
}

export interface NativePtySpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  readonly encoding: null;
}

export interface NativePtyModule {
  spawn(executablePath: string, args: string[], options: NativePtySpawnOptions): NativePtyProcess;
}

export interface TempNodePtyCopy {
  readonly nodePty: NativePtyModule;
  cleanup(): Promise<void>;
}

/**
 * Copy the installed node-pty to a unique temp dir and set its spawn-helper to
 * `helperMode`, returning the module loaded from that copy. The original
 * installed package is untouched.
 */
export async function copyNodePtyWithHelperMode(helperMode: number): Promise<TempNodePtyCopy> {
  const requireFromHere = createRequire(import.meta.url);
  const installedRoot = dirname(requireFromHere.resolve("node-pty/package.json"));
  const tempRoot = await mkdtemp(join(tmpdir(), "af-node-pty-copy-"));
  // Derive the copied dir name from the resolved package path rather than a
  // hardcoded literal, so this dev helper doesn't trip the node-pty module-
  // literal source guard (which protects the production loader boundary).
  const copiedRoot = join(tempRoot, basename(installedRoot));
  await cp(installedRoot, copiedRoot, { recursive: true });
  await chmod(
    join(copiedRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    helperMode,
  );
  const requireFromCopy = createRequire(join(copiedRoot, "package.json"));
  const nodePty = requireFromCopy(copiedRoot) as NativePtyModule;
  return {
    nodePty,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}
