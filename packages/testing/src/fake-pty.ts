// FakePty — deterministic PtySink for tests. Carries byte fixtures that cover
// every byte boundary (RT-T-22 / RT-T-32 style): NUL runs, invalid UTF-8, and
// multibyte sequences split across chunks.

import type { PtySink } from "@agents-fleet/contracts";

export type ByteChunk = Uint8Array;

export interface FakePtyOptions {
  readonly autoScript?: readonly ByteChunk[];
}

export class FakePty implements PtySink {
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private readonly written: number[] = [];
  private killed = false;

  constructor(opts: FakePtyOptions = {}) {
    if (opts.autoScript) for (const chunk of opts.autoScript) this.emit(chunk);
  }

  async write(bytes: Uint8Array): Promise<void> {
    for (const b of bytes) this.written.push(b);
  }

  async resize(): Promise<void> {
    // no-op for the fake
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  onOutput(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Test driver: push an output chunk to all subscribers. */
  emit(chunk: Uint8Array): void {
    for (const cb of this.listeners) cb(chunk);
  }

  get writtenBytes(): Uint8Array {
    return new Uint8Array(this.written);
  }

  get isKilled(): boolean {
    return this.killed;
  }
}

// --- fixtures ---

/** A run of NUL (0x00) bytes. */
export const nulBytes = (n: number): Uint8Array => new Uint8Array(n);

/** Lone continuation bytes that are not valid UTF-8 on their own. */
export const invalidUtf8 = (): Uint8Array => new Uint8Array([0xff, 0xfe, 0xaa]);

/** A multibyte sequence split at a chosen byte boundary (covers every boundary). */
export const splitMultibyte = (emoji: string, atByte: number): readonly Uint8Array[] => {
  const all = new TextEncoder().encode(emoji);
  return [all.subarray(0, atByte), all.subarray(atByte)];
};
