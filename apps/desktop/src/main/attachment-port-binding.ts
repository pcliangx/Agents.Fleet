// RT-STREAM-06 / RT-T-33 — immutable Attachment-to-MessagePort binding.

import {
  type AttachResult,
  type ControlLease,
  FROZEN_RUNTIME_LIMIT_PROFILE,
} from "@agents-fleet/contracts";
import { decodeFrame } from "@agents-fleet/transport";
import type { DesktopBridgeCore } from "./desktop-bridge.js";

export interface MainMessagePort {
  postMessage(message: unknown): void;
  on(
    event: "message" | "close",
    listener: ((event: { readonly data: unknown }) => void) | (() => void),
  ): void;
  start(): void;
  close(): void;
}

export interface AttachmentStream {
  subscribe(onFrame: (bytes: Uint8Array) => void, onEnded: () => void): () => void;
  close(): void;
}

export type ScheduleRenewal = (callback: () => void, delayMs: number) => () => void;

export interface AttachmentPortBindingOptions {
  readonly attached: AttachResult;
  readonly rendererFrameIdentity: string;
  readonly port: MainMessagePort;
  readonly stream: AttachmentStream;
  readonly bridge: DesktopBridgeCore;
  readonly now?: () => number;
  readonly schedule?: ScheduleRenewal;
}

interface AppliedMessage {
  readonly type: "frame-applied";
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly rendererFrameIdentity: string;
  readonly seq: number;
}

interface VisibilityMessage {
  readonly type: "terminal-visibility";
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly visible: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultSchedule: ScheduleRenewal = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export class AttachmentPortBinding {
  readonly #attached: AttachResult;
  readonly #rendererFrameIdentity: string;
  readonly #port: MainMessagePort;
  readonly #stream: AttachmentStream;
  readonly #bridge: DesktopBridgeCore;
  readonly #now: () => number;
  readonly #schedule: ScheduleRenewal;
  readonly #pending = new Map<number, number>();
  #pendingBytes = 0;
  #unsubscribe: (() => void) | undefined;
  #cancelRenewal: (() => void) | undefined;
  #lease: ControlLease | undefined;
  #started = false;
  #closed = false;
  #visible = true;

  constructor(options: AttachmentPortBindingOptions) {
    this.#attached = options.attached;
    this.#rendererFrameIdentity = options.rendererFrameIdentity;
    this.#port = options.port;
    this.#stream = options.stream;
    this.#bridge = options.bridge;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#port.on("message", (event) => this.#onPortMessage(event.data));
    this.#port.on("close", () => this.close());
    this.#unsubscribe = this.#stream.subscribe(
      (bytes) => this.#onFrame(bytes),
      () => this.close(),
    );
    this.#port.start();
  }

  holdControl(lease: ControlLease): void {
    if (
      lease.attachmentId !== this.#attached.attachmentId ||
      lease.sessionId !== this.#attached.sessionId ||
      lease.generation !== this.#attached.generation
    ) {
      this.close();
      return;
    }
    if (this.#visible) {
      this.#lease = lease;
      this.#scheduleRenewal();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelRenewal?.();
    this.#cancelRenewal = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.#stream.close();
    this.#port.close();
    void this.#bridge.closeAttachment(this.#attached.attachmentId);
  }

  #onFrame(wire: Uint8Array): void {
    if (this.#closed) return;
    let decoded: ReturnType<typeof decodeFrame>;
    try {
      decoded = decodeFrame(wire);
    } catch {
      this.close();
      return;
    }
    const header = decoded.header;
    if (
      header.sessionId !== this.#attached.sessionId ||
      header.generation !== this.#attached.generation ||
      !Number.isSafeInteger(header.seq) ||
      (header.seq as number) < 1
    ) {
      this.close();
      return;
    }
    const seq = header.seq as number;
    if (this.#pending.has(seq)) {
      this.close();
      return;
    }
    if (
      this.#pending.size + 1 > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueFrames ||
      this.#pendingBytes + wire.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.attachmentQueueBytes
    ) {
      this.close();
      return;
    }
    const owned = Uint8Array.from(wire);
    const buffer = owned.buffer as ArrayBuffer;
    this.#pending.set(seq, owned.byteLength);
    this.#pendingBytes += owned.byteLength;
    this.#port.postMessage({
      type: "session-frame",
      attachmentId: this.#attached.attachmentId,
      sessionId: this.#attached.sessionId,
      generation: this.#attached.generation,
      rendererFrameIdentity: this.#rendererFrameIdentity,
      seq,
      bytes: buffer,
    });
  }

  #onPortMessage(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === "terminal-visibility") {
      this.#onVisibility(value as unknown as VisibilityMessage);
      return;
    }
    if (value.type !== "frame-applied") return;
    const message = value as unknown as AppliedMessage;
    if (
      message.attachmentId !== this.#attached.attachmentId ||
      message.sessionId !== this.#attached.sessionId ||
      message.generation !== this.#attached.generation ||
      message.rendererFrameIdentity !== this.#rendererFrameIdentity ||
      !Number.isSafeInteger(message.seq)
    ) {
      this.close();
      return;
    }
    const bytes = this.#pending.get(message.seq);
    if (bytes === undefined) return;
    this.#pending.delete(message.seq);
    this.#pendingBytes -= bytes;
  }

  #onVisibility(message: VisibilityMessage): void {
    if (
      message.attachmentId !== this.#attached.attachmentId ||
      message.sessionId !== this.#attached.sessionId ||
      message.generation !== this.#attached.generation ||
      typeof message.visible !== "boolean"
    ) {
      this.close();
      return;
    }
    this.#visible = message.visible;
    if (message.visible) return;
    this.#lease = undefined;
    this.#cancelRenewal?.();
    this.#cancelRenewal = undefined;
  }

  #scheduleRenewal(): void {
    this.#cancelRenewal?.();
    const lease = this.#lease;
    if (this.#closed || lease === undefined) return;
    const delayMs = Math.max(100, Math.floor((lease.expiresAt - this.#now()) / 3));
    this.#cancelRenewal = this.#schedule(() => void this.#renew(), delayMs);
  }

  async #renew(): Promise<void> {
    const lease = this.#lease;
    if (this.#closed || lease === undefined) return;
    const renewed = await this.#bridge.renewControl(lease);
    if (this.#closed || !this.#visible) return;
    if (!renewed.ok) {
      this.close();
      return;
    }
    this.#lease = renewed.result;
    this.#scheduleRenewal();
  }
}
