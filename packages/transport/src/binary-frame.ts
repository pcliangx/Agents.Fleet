// RT-STREAM-02 / RT-STREAM-04 — length-prefixed binary frame.
// PTY bytes stay binary in the payload: no string decode, no JSON escape.
// Wire format: [uint32 BE headerJsonLen][headerJson UTF-8][payload bytes].
// header.payloadLength must equal the trailing payload length.

import type { StreamFrameHeader } from "@agents-fleet/contracts";

const HEADER_LEN_BYTES = 4;

export interface DecodedFrame {
  readonly header: StreamFrameHeader;
  readonly payload: Uint8Array;
}

export const encodeFrame = (header: StreamFrameHeader, payload: Uint8Array): Uint8Array => {
  const headerJson = new TextEncoder().encode(
    JSON.stringify({ ...header, payloadLength: payload.byteLength }),
  );
  const out = new Uint8Array(HEADER_LEN_BYTES + headerJson.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, headerJson.byteLength); // BE
  out.set(headerJson, HEADER_LEN_BYTES);
  out.set(payload, HEADER_LEN_BYTES + headerJson.byteLength);
  return out;
};

export const decodeFrame = (buf: Uint8Array): DecodedFrame => {
  if (buf.byteLength < HEADER_LEN_BYTES) throw new Error("frame too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(0);
  const headerStart = HEADER_LEN_BYTES;
  if (buf.byteLength < headerStart + headerLen) throw new Error("truncated header");
  const header = JSON.parse(
    new TextDecoder().decode(buf.subarray(headerStart, headerStart + headerLen)),
  ) as StreamFrameHeader;
  const payloadStart = headerStart + headerLen;
  const payload = buf.subarray(payloadStart, payloadStart + header.payloadLength);
  if (payload.byteLength !== header.payloadLength) throw new Error("truncated payload");
  return { header, payload };
};
