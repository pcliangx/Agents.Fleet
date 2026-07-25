// RT-STREAM-01 — control channel uses UTF-8 NDJSON, one complete object per line.

export const encodeNdjson = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

// Buffers chunks and emits whole lines. Feeding may be partial.
export class NdjsonDecoder {
  private buffer = "";

  feed(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }

  drain(): unknown[] {
    const out: unknown[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) out.push(JSON.parse(line));
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }

  remaining(): string {
    return this.buffer;
  }
}
