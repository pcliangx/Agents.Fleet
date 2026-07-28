// RT-T-03 / RT-ORDER-05 — a stream-only disconnect reopens the binary
// channel at the last observed cursor while preserving the Active Attachment.

import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { decodeFrame } from "@agents-fleet/transport";
import type { AttachmentStream } from "./attachment-port-binding.js";

export type ReconnectSchedule = (callback: () => void, delayMs: number) => () => void;

export interface ReconnectingAttachmentStreamOptions {
  readonly fromSeq: number;
  readonly open: (fromSeq: number) => Promise<AttachmentStream>;
  readonly schedule?: ReconnectSchedule;
}

const defaultSchedule: ReconnectSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export class ReconnectingAttachmentStream implements AttachmentStream {
  readonly #open: (fromSeq: number) => Promise<AttachmentStream>;
  readonly #schedule: ReconnectSchedule;
  #nextSeq: number;
  #stream: AttachmentStream | undefined;
  #unsubscribe: (() => void) | undefined;
  #cancelReconnect: (() => void) | undefined;
  #onFrame: ((bytes: Uint8Array) => void) | undefined;
  #queued: Uint8Array[] = [];
  #queuedBytes = 0;
  #closed = false;
  #terminated = false;
  #retryMs = 100;

  private constructor(options: ReconnectingAttachmentStreamOptions) {
    this.#open = options.open;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#nextSeq = options.fromSeq;
  }

  static async open(
    options: ReconnectingAttachmentStreamOptions,
  ): Promise<ReconnectingAttachmentStream> {
    const managed = new ReconnectingAttachmentStream(options);
    managed.#install(await options.open(options.fromSeq));
    return managed;
  }

  subscribe(onFrame: (bytes: Uint8Array) => void, onEnded: () => void): () => void {
    if (this.#onFrame !== undefined) throw new Error("Attachment stream already has a subscriber");
    if (this.#terminated) {
      queueMicrotask(onEnded);
      return () => {};
    }
    this.#onFrame = onFrame;
    for (const frame of this.#queued) onFrame(frame);
    this.#queued = [];
    this.#queuedBytes = 0;
    return () => {
      this.#onFrame = undefined;
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stream?.close();
    this.#stream = undefined;
    this.#queued = [];
    this.#queuedBytes = 0;
  }

  #install(stream: AttachmentStream): void {
    if (this.#closed) {
      stream.close();
      return;
    }
    this.#stream = stream;
    this.#unsubscribe = stream.subscribe(
      (bytes) => {
        try {
          const decoded = decodeFrame(bytes);
          this.#nextSeq = (decoded.header.seq as number) + 1;
        } catch {
          this.#deliver(bytes);
          return;
        }
        this.#deliver(bytes);
      },
      () => this.#disconnected(),
    );
    this.#retryMs = 100;
  }

  #deliver(bytes: Uint8Array): void {
    if (this.#onFrame !== undefined) {
      this.#onFrame(bytes);
      return;
    }
    if (
      this.#queued.length + 1 > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueFrames ||
      this.#queuedBytes + bytes.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes
    ) {
      this.#terminated = true;
      this.close();
      return;
    }
    const owned = Uint8Array.from(bytes);
    this.#queued.push(owned);
    this.#queuedBytes += owned.byteLength;
  }

  #disconnected(): void {
    if (this.#closed) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stream = undefined;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#cancelReconnect !== undefined) return;
    const delayMs = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 1_000);
    this.#cancelReconnect = this.#schedule(() => {
      this.#cancelReconnect = undefined;
      void this.#reconnect();
    }, delayMs);
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#install(await this.#open(this.#nextSeq));
    } catch {
      this.#scheduleReconnect();
    }
  }
}
