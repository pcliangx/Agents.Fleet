import { describe, expect, it } from "vitest";
import { encodeNdjson, NdjsonDecoder } from "../ndjson.js";

describe("ndjson (RT-STREAM-01)", () => {
  it("round-trips an object", () => {
    const d = new NdjsonDecoder();
    d.feed(encodeNdjson({ a: 1, b: "x" }));
    expect(d.drain()).toEqual([{ a: 1, b: "x" }]);
  });

  it("buffers a partial line and emits on newline", () => {
    const d = new NdjsonDecoder();
    d.feed('{"a":1');
    expect(d.drain()).toEqual([]);
    d.feed("}\n");
    expect(d.drain()).toEqual([{ a: 1 }]);
  });

  it("handles multiple lines in one chunk", () => {
    const d = new NdjsonDecoder();
    d.feed('{"a":1}\n{"b":2}\n');
    expect(d.drain()).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("accepts Uint8Array chunks", () => {
    const d = new NdjsonDecoder();
    d.feed(new TextEncoder().encode('{"a":1}\n'));
    expect(d.drain()).toEqual([{ a: 1 }]);
  });
});
