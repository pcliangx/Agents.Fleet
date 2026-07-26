// D4 — DevProofVerifier stub, hard-gated. Accepts a known dev proof ONLY when
// AGENTS_FLEET_DEV_AUTH=1 AND NODE_ENV !== 'production'. Otherwise Unauthorized.
// Superseded for the real path by KeychainCapabilityProofVerifier (#11); kept as
// a last-resort dev fallback. The transcript is ignored here — the real
// verifier is what binds the proof to the negotiation.

import type { ErrorCode } from "@agents-fleet/contracts";
import type { ProofTranscript } from "@agents-fleet/transport";
import type { ProofResult, ProofVerifier } from "./proof-verifier.js";

const DEV_AUTH_ENV = "AGENTS_FLEET_DEV_AUTH";
const DEV_PROOF = "dev-proof";

export class DevProofVerifier implements ProofVerifier {
  // transcript is part of the seam but unused by the dev stub.
  verify(args: { readonly transcript: ProofTranscript; readonly clientProof: string }): ProofResult {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    if (process.env[DEV_AUTH_ENV] !== "1") {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    return args.clientProof === DEV_PROOF ? { ok: true } : { ok: false, code: "Unauthorized" };
  }
}
