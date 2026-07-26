import type { ProofTranscript } from "@agents-fleet/transport";
import { computeProof } from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import { KeychainCapabilityProofVerifier } from "../auth/keychain-capability-proof-verifier.js";

// RT-HS-04 — the Daemon verifier checks the client proof via the shared scheme
// and refuses a reused clientNonce within the same daemon generation.

const token = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const base: ProofTranscript = {
  clientNonce: "cn-1",
  daemonNonce: "dn",
  selectedProtocolVersion: 1,
  clientInstanceId: "c",
  clientKind: "test",
  daemonId: "d",
  daemonGeneration: 1,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
};

describe("KeychainCapabilityProofVerifier (RT-HS-04)", () => {
  it("accepts a valid client proof", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    const proof = computeProof("client", base, token);
    expect(v.verify({ transcript: base, clientProof: proof })).toEqual({ ok: true });
  });

  it("rejects a wrong client proof", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    expect(v.verify({ transcript: base, clientProof: "wrong" }).ok).toBe(false);
  });

  it("rejects a replayed clientNonce within the same generation", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    const proof = computeProof("client", base, token);
    expect(v.verify({ transcript: base, clientProof: proof }).ok).toBe(true);
    expect(v.verify({ transcript: base, clientProof: proof }).ok).toBe(false);
  });

  it("accepts distinct client nonces in the same generation", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    const a = { ...base, clientNonce: "cn-a" };
    const b = { ...base, clientNonce: "cn-b" };
    expect(v.verify({ transcript: a, clientProof: computeProof("client", a, token) }).ok).toBe(true);
    expect(v.verify({ transcript: b, clientProof: computeProof("client", b, token) }).ok).toBe(true);
  });

  it("clears replay state when daemonGeneration changes", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    const g1 = base;
    const g2 = { ...base, daemonGeneration: 2 };
    expect(v.verify({ transcript: g1, clientProof: computeProof("client", g1, token) }).ok).toBe(true);
    expect(v.verify({ transcript: g2, clientProof: computeProof("client", g2, token) }).ok).toBe(true);
  });

  it("does not consume a nonce on a failed proof (retry allowed)", () => {
    const v = new KeychainCapabilityProofVerifier(token);
    expect(v.verify({ transcript: base, clientProof: "wrong" }).ok).toBe(false);
    const proof = computeProof("client", base, token);
    expect(v.verify({ transcript: base, clientProof: proof }).ok).toBe(true);
  });
});
