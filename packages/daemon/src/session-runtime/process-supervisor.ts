import { createRequire } from "node:module";

export interface SpawnPtyRequest {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyDriverSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly encoding: null;
}

export interface PtyDriverProcess {
  readonly pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: Uint8Array) => void): { dispose(): void };
}

export interface PtyDriver {
  spawn(
    executablePath: string,
    args: readonly string[],
    options: PtyDriverSpawnOptions,
  ): PtyDriverProcess;
}

export interface SupervisedPtyProcess {
  readonly pid: number;
  write(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  terminate(): Promise<void>;
  onOutput(listener: (bytes: Uint8Array) => void): () => void;
}

export interface ProcessSupervisor {
  spawn(request: SpawnPtyRequest): SupervisedPtyProcess;
}

export const createProcessSupervisor = (driver: PtyDriver): ProcessSupervisor => ({
  spawn(request) {
    const process = driver.spawn(request.executablePath, request.args, {
      cwd: request.cwd,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      encoding: null,
    });
    let rawOutputFailed = false;

    return {
      pid: process.pid,
      async write(bytes) {
        process.write(bytes);
      },
      async resize(cols, rows) {
        process.resize(cols, rows);
      },
      async terminate() {
        process.kill();
      },
      onOutput(listener) {
        const subscription = process.onData((data: unknown) => {
          if (rawOutputFailed) return;
          if (!(data instanceof Uint8Array)) {
            rawOutputFailed = true;
            process.kill();
            return;
          }
          listener(data);
        });
        return () => subscription.dispose();
      },
    };
  },
});

export const createNodePtyProcessSupervisor = (): ProcessSupervisor => {
  const require = createRequire(import.meta.url);
  const driver = require("node-pty") as PtyDriver;
  return createProcessSupervisor(driver);
};
