import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProcessSupervisor,
  type PtyDriver,
  type PtyDriverProcess,
  type SupervisedPtyProcess,
} from "../session-runtime/process-supervisor.js";

interface NativePtyProcess {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: unknown) => void): { dispose(): void };
  onExit(listener: () => void): { dispose(): void };
}

interface NativePtyModule {
  spawn(
    executablePath: string,
    args: string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly cols: number;
      readonly rows: number;
      readonly encoding: null;
    },
  ): NativePtyProcess;
}

const HOSTILE_BYTES = [0x00, 0xff, 0xfe, 0xf0, 0x9f, 0x98, 0x80, 0x41] as const;
const HOSTILE_SHA256 = "0e94bd7e52cb67fb1255a75a0c98112b748d360fa14d96a278a22828aa26ccf8";
const itMacArm64 = process.platform === "darwin" && process.arch === "arm64" ? it : it.skip;

const waitForExit = async (exited: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native PTY exit timeout")), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe("node-pty native raw-byte boundary", () => {
  itMacArm64(
    "preserves hostile Buffer bytes and keeps display replacement out of the recovery source",
    async () => {
      const requireFromTest = createRequire(import.meta.url);
      const installedRoot = dirname(requireFromTest.resolve("node-pty/package.json"));
      const tempRoot = await mkdtemp(join(tmpdir(), "af-r010-node-pty-"));
      const copiedRoot = join(tempRoot, "node-pty");
      let supervisedProcess: SupervisedPtyProcess | undefined;

      try {
        await cp(installedRoot, copiedRoot, { recursive: true });
        await chmod(
          join(copiedRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
          0o755,
        );
        const requireFromCopy = createRequire(join(copiedRoot, "package.json"));
        const nodePty = requireFromCopy(copiedRoot) as NativePtyModule;
        let resolveExit: (() => void) | undefined;
        const exited = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });
        const driver: PtyDriver = {
          spawn(executablePath, args, options): PtyDriverProcess {
            const nativeProcess = nodePty.spawn(executablePath, [...args], {
              ...options,
              env: { ...options.env },
            });
            nativeProcess.onExit(() => resolveExit?.());
            return {
              pid: nativeProcess.pid,
              write: (data) => nativeProcess.write(Buffer.from(data)),
              resize: (cols, rows) => nativeProcess.resize(cols, rows),
              kill: () => nativeProcess.kill(),
              onData: (listener) => nativeProcess.onData((data) => listener(data as Uint8Array)),
            };
          },
        };
        supervisedProcess = createProcessSupervisor(driver).spawn({
          executablePath: process.execPath,
          args: [
            "-e",
            `setTimeout(() => process.stdout.write(Buffer.from([${HOSTILE_BYTES.join(",")}]), () => process.exit(0)), 50)`,
          ],
          cwd: tmpdir(),
          env: { PATH: "/usr/bin:/bin" },
          cols: 80,
          rows: 24,
        });
        const chunks: Uint8Array[] = [];
        supervisedProcess.onOutput((bytes) => chunks.push(bytes.slice()));

        await waitForExit(exited);

        const recoverySource = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const checksumBeforeDisplay = createHash("sha256").update(recoverySource).digest("hex");
        const displayText = new TextDecoder().decode(recoverySource);
        const checksumAfterDisplay = createHash("sha256").update(recoverySource).digest("hex");

        expect({
          bytes: [...recoverySource],
          checksumBeforeDisplay,
          displayContainsReplacement: displayText.includes("\ufffd"),
          checksumAfterDisplay,
        }).toEqual({
          bytes: [...HOSTILE_BYTES],
          checksumBeforeDisplay: HOSTILE_SHA256,
          displayContainsReplacement: true,
          checksumAfterDisplay: HOSTILE_SHA256,
        });
      } finally {
        await supervisedProcess?.terminate().catch(() => {});
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
