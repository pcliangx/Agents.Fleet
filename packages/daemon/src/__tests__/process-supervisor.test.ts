import { describe, expect, it } from "vitest";
import {
  createProcessSupervisor,
  type PtyDriverProcess,
  type PtyExitEvent,
  type SupervisedPtyProcess,
} from "../session-runtime/process-supervisor.js";

class FakeDriverProcess implements PtyDriverProcess {
  readonly pid = 4242;
  readonly written: Uint8Array[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private outputListener: ((data: Uint8Array) => void) | undefined;
  private exitListener: ((event: PtyExitEvent) => void) | undefined;

  write(data: Uint8Array): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: Uint8Array) => void): { dispose(): void } {
    this.outputListener = listener;
    return {
      dispose: () => {
        this.outputListener = undefined;
      },
    };
  }

  onExit(listener: (event: PtyExitEvent) => void): { dispose(): void } {
    this.exitListener = listener;
    return {
      dispose: () => {
        this.exitListener = undefined;
      },
    };
  }

  emit(data: Uint8Array): void {
    this.outputListener?.(data);
  }

  emitUnsafe(data: unknown): void {
    this.outputListener?.(data as Uint8Array);
  }

  emitExit(event: PtyExitEvent): void {
    this.exitListener?.(event);
  }
}

const spawnFakeProcess = (): {
  readonly driverProcess: FakeDriverProcess;
  readonly process: SupervisedPtyProcess;
} => {
  const driverProcess = new FakeDriverProcess();
  const supervisor = createProcessSupervisor({
    spawn: () => driverProcess,
  });
  const process = supervisor.spawn({
    executablePath: "/usr/bin/true",
    args: [],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
  });
  return { driverProcess, process };
};

describe("ProcessSupervisor", () => {
  it("preserves raw PTY output bytes", () => {
    const { driverProcess, process } = spawnFakeProcess();
    const observed: number[][] = [];

    process.onOutput((bytes) => observed.push([...bytes]));
    driverProcess.emit(new Uint8Array([0x00, 0xff, 0xfe, 0xf0, 0x9f]));
    driverProcess.emit(new Uint8Array([0x98, 0x80]));

    expect(observed).toEqual([
      [0x00, 0xff, 0xfe, 0xf0, 0x9f],
      [0x98, 0x80],
    ]);
  });

  it("terminates the PTY when its driver emits decoded text", () => {
    const { driverProcess, process } = spawnFakeProcess();
    process.onOutput(() => {});

    driverProcess.emitUnsafe("decoded text");

    expect(driverProcess.killed).toBe(true);
  });

  it("does not publish output after the raw-byte boundary fails", () => {
    const { driverProcess, process } = spawnFakeProcess();
    const observed: number[][] = [];
    process.onOutput((bytes) => observed.push([...bytes]));

    driverProcess.emitUnsafe("decoded text");
    driverProcess.emit(new Uint8Array([0x41]));

    expect(observed).toEqual([]);
  });

  it("hands raw input bytes to the PTY owner without decoding", async () => {
    const { driverProcess, process } = spawnFakeProcess();

    await process.write(new Uint8Array([0x00, 0xff, 0xfe, 0xf0, 0x9f, 0x98, 0x80]));

    expect(driverProcess.written.map((bytes) => [...bytes])).toEqual([
      [0x00, 0xff, 0xfe, 0xf0, 0x9f, 0x98, 0x80],
    ]);
  });

  it("reports success after the PTY owner accepts a resize", async () => {
    const { driverProcess, process } = spawnFakeProcess();

    await process.resize(132, 43);

    expect(driverProcess.sizes).toEqual([{ cols: 132, rows: 43 }]);
  });

  it("terminates the owned PTY process", async () => {
    const { driverProcess, process } = spawnFakeProcess();

    await process.terminate();

    expect(driverProcess.killed).toBe(true);
  });

  it("reports the owned PTY process exit", () => {
    const { driverProcess, process } = spawnFakeProcess();
    const exits: PtyExitEvent[] = [];
    process.onExit((event) => exits.push(event));

    driverProcess.emitExit({ exitCode: 7, signal: 0 });

    expect(exits).toEqual([{ exitCode: 7, signal: 0 }]);
  });
});
