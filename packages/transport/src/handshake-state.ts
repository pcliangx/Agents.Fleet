// RT-HS-01..05 — pure handshake FSM shared by daemon and desktop client.
// This module only does version/platform/limit negotiation + DaemonChallenge
// construction. Mutual proof verification (RT-HS-04) is injected as a
// ProofVerifier at the transport-using layer; #11 ships the real one.

import type {
  ClientHello,
  DaemonChallenge,
  DaemonId,
  Generation,
  HandshakeNegotiation,
  Nonce,
} from "@agents-fleet/contracts";

export interface DaemonHandshakeConfig {
  readonly supportedProtocolVersions: readonly number[];
  readonly daemonId: DaemonId;
  readonly daemonGeneration: Generation;
  readonly platformMatrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
  readonly daemonNonce: Nonce;
  readonly daemonProof: string;
}

// Highest protocol version common to both sides, or null.
export const selectProtocolVersion = (
  config: DaemonHandshakeConfig,
  hello: ClientHello,
): number | null => {
  const daemonSet = new Set<number>(config.supportedProtocolVersions);
  let best = -1;
  for (const v of hello.protocolVersions) {
    if (daemonSet.has(v) && v > best) best = v;
  }
  return best >= 0 ? best : null;
};

// RT-HS-03 — no common version → fatal UnsupportedVersion (no best-effort parsing).
export const negotiate = (
  config: DaemonHandshakeConfig,
  hello: ClientHello,
): HandshakeNegotiation => {
  if (
    hello.expectedPlatformMatrixVersion !== config.platformMatrixVersion ||
    hello.expectedRuntimeLimitProfileVersion !== config.runtimeLimitProfileVersion
  ) {
    return {
      kind: "fatal",
      code: "UnsupportedVersion",
      message: "platform/limit profile version mismatch",
    };
  }
  const selected = selectProtocolVersion(config, hello);
  if (selected === null) {
    return { kind: "fatal", code: "UnsupportedVersion", message: "no common protocol version" };
  }
  const challenge: DaemonChallenge = {
    selectedProtocolVersion: selected,
    daemonId: config.daemonId,
    daemonGeneration: config.daemonGeneration,
    platformMatrixVersion: config.platformMatrixVersion,
    runtimeLimitProfileVersion: config.runtimeLimitProfileVersion,
    daemonNonce: config.daemonNonce,
    daemonProof: config.daemonProof,
  };
  return { kind: "challenge", challenge };
};
