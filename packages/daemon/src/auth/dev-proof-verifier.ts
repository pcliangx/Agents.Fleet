// D4 — DevProofVerifier stub, hard-gated. Accepts a known dev proof ONLY when
// AGENTS_FLEET_DEV_AUTH=1 AND NODE_ENV !== 'production'. Otherwise Unauthorized.
// This MUST NOT ship as the production verifier; #11 replaces it via the
// ProofVerifier seam without touching the dispatcher.

import type { ErrorCode } from "@agents-fleet/contracts";
import type { ProofResult, ProofVerifier } from "./proof-verifier.js";

const DEV_AUTH_ENV = "AGENTS_FLEET_DEV_AUTH";
const DEV_PROOF = "dev-proof";

export class DevProofVerifier implements ProofVerifier {
  verify(args: { readonly transcript: unknown; readonly clientProof: string }): ProofResult {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    if (process.env[DEV_AUTH_ENV] !== "1") {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    return args.clientProof === DEV_PROOF ? { ok: true } : { ok: false, code: "Unauthorized" };
  }
}
