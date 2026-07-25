// RT-HS-04 — proof verifier seam. #1 ships DevProofVerifier (hard-gated); #11
// ships a KeychainCapabilityProofVerifier with no change to this interface.

import type { ErrorCode } from "@agents-fleet/contracts";

export interface HandshakeTranscript {
  readonly clientNonce: string;
  readonly daemonNonce: string;
  readonly negotiatedProtocolVersion: number;
}

export type ProofResult = { readonly ok: true } | { readonly ok: false; readonly code: ErrorCode };

export interface ProofVerifier {
  verify(args: {
    readonly transcript: HandshakeTranscript;
    readonly clientProof: string;
  }): ProofResult | Promise<ProofResult>;
}
