// RT-HS-01..05 — pure handshake FSM shared by daemon and desktop client.
// This module only does version/platform/limit negotiation + DaemonChallenge
// construction. The per-connection daemonNonce + daemonProof are supplied by
// the caller (the Daemon dispatcher generates a fresh nonce and computes the
// proof per connection, RT-HS-04). Mutual proof verification is injected as a
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
}

// RT-HS-04 — per-connection values the Daemon fills into the challenge. The
// dispatcher generates `daemonNonce` per connection and computes `daemonProof`
// from the negotiation transcript; negotiate just places them.
export interface PerConnectionProof {
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
  perConnection: PerConnectionProof,
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
    daemonNonce: perConnection.daemonNonce,
    daemonProof: perConnection.daemonProof,
  };
  return { kind: "challenge", challenge };
};
