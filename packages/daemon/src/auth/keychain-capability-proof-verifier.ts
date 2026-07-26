// RT-HS-04 — production Daemon proof verifier. Verifies the client proof via
// the shared capability-proof scheme and refuses a reused clientNonce within a
// daemon generation. The capability token is supplied by a CapabilityTokenSource
// (DevTokenFile in dev per SV1-AUTH-07, Keychain in prod); this class is given
// the resolved token bytes, so it is independent of how the token was obtained
// and trivially testable.

import type { ErrorCode } from "@agents-fleet/contracts";
import type { ProofTranscript } from "@agents-fleet/transport";
import { verifyProof } from "@agents-fleet/transport";
import type { ProofResult, ProofVerifier } from "./proof-verifier.js";

export class KeychainCapabilityProofVerifier implements ProofVerifier {
  private seenGeneration: number | undefined;
  private readonly seenNonces = new Set<string>();

  private readonly token: Uint8Array;

  constructor(token: Uint8Array) {
    this.token = token;
  }

  verify(args: {
    readonly transcript: ProofTranscript;
    readonly clientProof: string;
  }): ProofResult {
    const { transcript, clientProof } = args;
    // RT-HS-04 — a daemonNonce/clientNonce must not be reused within a
    // generation; reset the replay set when the generation rolls over.
    if (transcript.daemonGeneration !== this.seenGeneration) {
      this.seenGeneration = transcript.daemonGeneration;
      this.seenNonces.clear();
    }
    if (this.seenNonces.has(transcript.clientNonce)) {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    if (!verifyProof("client", transcript, this.token, clientProof)) {
      return { ok: false, code: "Unauthorized" as ErrorCode };
    }
    // Consume the nonce only on a successful proof; a failed attempt leaves it
    // available so the client may retry (with a fresh proof, same nonce).
    this.seenNonces.add(transcript.clientNonce);
    return { ok: true };
  }
}
