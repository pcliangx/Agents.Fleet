// RT-HS-04 — proof verifier seam. The verifier checks the client's proof over
// the full negotiation transcript, keyed by the shared Keychain capability
// token. #1 shipped DevProofVerifier (hard-gated stub); #11 ships
// KeychainCapabilityProofVerifier here with no change to the dispatcher beyond
// building the full transcript.

import type { ErrorCode } from "@agents-fleet/contracts";
import type { ProofTranscript } from "@agents-fleet/transport";

export type ProofResult = { readonly ok: true } | { readonly ok: false; readonly code: ErrorCode };

export interface ProofVerifier {
  verify(args: {
    readonly transcript: ProofTranscript;
    readonly clientProof: string;
  }): ProofResult | Promise<ProofResult>;
}
