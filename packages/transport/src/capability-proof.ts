// RT-HS-04 — shared capability proof scheme. A domain-separated HMAC-SHA256
// over the negotiation transcript, keyed by the shared Keychain capability
// token. The Daemon computes/verifies daemonProof/clientProof on its side; the
// Electron Main client computes clientProof on its side, using this same module.
//
// The token is never sent over the transport (SV1-AUTH-03/04); both peers read
// it from the same Keychain entry (prod) or dev token file (SV1-AUTH-07). The
// "daemon"/"client" role tag is part of the MAC input so a proof minted for one
// direction cannot be replayed in the other.

import { createHmac, timingSafeEqual } from "node:crypto";

export type ProofRole = "daemon" | "client";

export interface ProofTranscript {
  readonly clientNonce: string;
  readonly daemonNonce: string;
  readonly selectedProtocolVersion: number;
  readonly clientInstanceId: string;
  readonly clientKind: string;
  readonly daemonId: string;
  readonly daemonGeneration: number;
  readonly platformMatrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
}

const enc = new TextEncoder();
const u = (s: string): Uint8Array => enc.encode(s);

// Length-prefix each field so a value containing delimiter bytes cannot shift
// the framing (ambiguous MAC input would be a forgery vector).
const frame = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += 4 + p.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let off = 0;
  for (const p of parts) {
    dv.setUint32(off, p.byteLength); // big-endian
    out.set(p, off + 4);
    off += 4 + p.byteLength;
  }
  return out;
};

const canonical = (role: ProofRole, t: ProofTranscript): Uint8Array =>
  frame([
    u(role),
    u(t.clientNonce),
    u(t.daemonNonce),
    u(String(t.selectedProtocolVersion)),
    u(t.clientInstanceId),
    u(t.clientKind),
    u(t.daemonId),
    u(String(t.daemonGeneration)),
    u(String(t.platformMatrixVersion)),
    u(String(t.runtimeLimitProfileVersion)),
  ]);

export const computeProof = (role: ProofRole, t: ProofTranscript, token: Uint8Array): string =>
  createHmac("sha256", token).update(canonical(role, t)).digest("hex");

export const verifyProof = (
  role: ProofRole,
  t: ProofTranscript,
  token: Uint8Array,
  candidate: string,
): boolean => {
  const expected = computeProof(role, t, token);
  // timingSafeEqual throws on length mismatch; guard first so a malformed
  // candidate is a normal rejection, never an exception.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(u(expected), u(candidate));
};
