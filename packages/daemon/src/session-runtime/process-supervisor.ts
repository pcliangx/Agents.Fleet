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
  kill(signal?: string): void;
  onData(listener: (data: Uint8Array) => void): { dispose(): void };
  onExit(listener: (event: PtyExitEvent) => void): { dispose(): void };
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal: number;
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
  pause(processGroupId: number): Promise<void>;
  resume(processGroupId: number): Promise<void>;
  terminate(): Promise<void>;
  onOutput(listener: (bytes: Uint8Array) => void): () => void;
  onExit(listener: (event: PtyExitEvent) => void): () => void;
}

export interface ProcessSupervisor {
  spawn(request: SpawnPtyRequest): SupervisedPtyProcess;
}

type ProcessGroupSignal = "SIGSTOP" | "SIGCONT";

const signalProcessGroup = (pgid: number, signal: ProcessGroupSignal): void => {
  process.kill(-pgid, signal);
};

export const createProcessSupervisor = (
  driver: PtyDriver,
  signalGroup: (pgid: number, signal: ProcessGroupSignal) => void = signalProcessGroup,
): ProcessSupervisor => ({
  spawn(request) {
    const driverProcess = driver.spawn(request.executablePath, request.args, {
      cwd: request.cwd,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      encoding: null,
    });
    let rawOutputFailed = false;

    return {
      pid: driverProcess.pid,
      async write(bytes) {
        driverProcess.write(bytes);
      },
      async resize(cols, rows) {
        driverProcess.resize(cols, rows);
      },
      async pause(processGroupId) {
        if (processGroupId !== driverProcess.pid) {
          throw new Error("PTY owner is not the recorded process-group leader");
        }
        signalGroup(processGroupId, "SIGSTOP");
      },
      async resume(processGroupId) {
        if (processGroupId !== driverProcess.pid) {
          throw new Error("PTY owner is not the recorded process-group leader");
        }
        signalGroup(processGroupId, "SIGCONT");
      },
      async terminate() {
        driverProcess.kill();
      },
      onOutput(listener) {
        const subscription = driverProcess.onData((data: unknown) => {
          if (rawOutputFailed) return;
          if (!(data instanceof Uint8Array)) {
            rawOutputFailed = true;
            driverProcess.kill();
            return;
          }
          listener(data);
        });
        return () => subscription.dispose();
      },
      onExit(listener) {
        const subscription = driverProcess.onExit(listener);
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
