import { describe, expect, it } from "vitest";
import { computeProof, type ProofTranscript, verifyProof } from "../capability-proof.js";

// RT-HS-04 — the capability proof is a domain-separated HMAC-SHA256 over the
// negotiation transcript (both nonces + agreed versions + identities), keyed
// by the shared Keychain capability token. It must be deterministic, refuse the
// wrong role, invalidate on any transcript change (tamper / version downgrade),
// and not leak via length-mismatch exceptions.

const token = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

const base: ProofTranscript = {
  clientNonce: "client-nonce-abc",
  daemonNonce: "daemon-nonce-xyz",
  selectedProtocolVersion: 1,
  clientInstanceId: "electron-main",
  clientKind: "electron-main",
  daemonId: "d1",
  daemonGeneration: 1,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
};

describe("RT-HS-04 capability proof scheme", () => {
  it("computeProof is deterministic", () => {
    expect(computeProof("client", base, token)).toBe(computeProof("client", base, token));
  });

  it("verifyProof accepts the correct proof and rejects a wrong one", () => {
    const proof = computeProof("client", base, token);
    expect(verifyProof("client", base, token, proof)).toBe(true);
    expect(verifyProof("client", base, token, `${proof.slice(0, -2)}ff`)).toBe(false);
  });

  it("does not accept a daemon proof as a client proof (role separation)", () => {
    const daemonProof = computeProof("daemon", base, token);
    expect(verifyProof("client", base, token, daemonProof)).toBe(false);
  });

  it.each([
    ["clientNonce", { ...base, clientNonce: "other" }],
    ["daemonNonce", { ...base, daemonNonce: "other" }],
    ["selectedProtocolVersion", { ...base, selectedProtocolVersion: 2 }],
    ["clientInstanceId", { ...base, clientInstanceId: "other" }],
    ["clientKind", { ...base, clientKind: "other" }],
    ["daemonId", { ...base, daemonId: "other" }],
    ["daemonGeneration", { ...base, daemonGeneration: 2 }],
    ["platformMatrixVersion", { ...base, platformMatrixVersion: 1 }],
    ["runtimeLimitProfileVersion", { ...base, runtimeLimitProfileVersion: 1 }],
  ])("invalidates when %s changes (tamper / downgrade)", (_name, tampered) => {
    const proof = computeProof("client", base, token);
    expect(verifyProof("client", tampered, token, proof)).toBe(false);
  });

  it("invalidates when the token differs", () => {
    const proof = computeProof("client", base, token);
    const otherToken = new Uint8Array(16).fill(99);
    expect(verifyProof("client", base, otherToken, proof)).toBe(false);
  });

  it("returns false (not throw) for a length-mismatched candidate", () => {
    expect(verifyProof("client", base, token, "deadbeef")).toBe(false);
    expect(verifyProof("client", base, token, "")).toBe(false);
  });
});
