// RT-REPO-06 / RT-CMD-16/17/18 — confirmation receipt proof.
//
// A receipt is a domain-separated HMAC-SHA256 over the receipt transcript,
// keyed by the same shared capability token as the RT-HS-04 handshake proof
// (SV1-TRUST-09: only the holder of the protected Main/Daemon capability can
// sign; the token never crosses the transport and the Renderer never touches
// it — SV1-AUTH-03/08). The Daemon verifies with the identical transcript, so
// a Renderer-forged receipt, a receipt for a tampered challenge, or a proof
// minted for a different purpose all fail verification.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConfirmationChallenge } from "@agents-fleet/contracts";
import { receiptTranscriptFields } from "@agents-fleet/contracts";

const DOMAIN = "agents-fleet/confirmation-receipt/v1";

const enc = new TextEncoder();
const u = (s: string): Uint8Array => enc.encode(s);

// Same length-prefix framing as the handshake proof: a field containing
// delimiter bytes cannot shift the MAC input boundaries.
const frame = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += 4 + p.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let off = 0;
  for (const p of parts) {
    dv.setUint32(off, p.byteLength);
    out.set(p, off + 4);
    off += 4 + p.byteLength;
  }
  return out;
};

const canonical = (fields: readonly string[]): Uint8Array => frame([u(DOMAIN), ...fields.map(u)]);

export const signConfirmation = (
  challenge: ConfirmationChallenge,
  confirmedAt: string,
  token: Uint8Array,
): string =>
  createHmac("sha256", token)
    .update(canonical(receiptTranscriptFields(challenge, confirmedAt)))
    .digest("hex");

export const verifyConfirmation = (
  challenge: ConfirmationChallenge,
  confirmedAt: string,
  candidate: string,
  token: Uint8Array,
): boolean => {
  const expected = signConfirmation(challenge, confirmedAt, token);
  // timingSafeEqual throws on length mismatch; guard first so a malformed
  // candidate is a normal rejection, never an exception.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(u(expected), u(candidate));
};
