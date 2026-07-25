// RT-HS-01..05 — handshake messages. Mutual proof (RT-HS-04) is a domain-separated
// MAC over both nonces + the full negotiation transcript, protected by a Keychain
// capability token that is never sent on the transport. Full mutual-auth ships in #11.

import type { DaemonId, Generation, Nonce } from "../identity.js";

export type ClientKind = "electron-main" | "cli" | "test";

// RT-HS-01
export interface ClientHello {
  readonly protocolVersions: readonly number[];
  readonly expectedPlatformMatrixVersion: number;
  readonly expectedRuntimeLimitProfileVersion: number;
  readonly clientInstanceId: string;
  readonly clientKind: ClientKind;
  readonly clientNonce: Nonce;
}

// RT-HS-02 (challenge precedes the final hello so the client can be authed first)
export interface DaemonChallenge {
  readonly selectedProtocolVersion: number;
  readonly daemonId: DaemonId;
  readonly daemonGeneration: Generation;
  readonly platformMatrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
  readonly daemonNonce: Nonce;
  readonly daemonProof: string;
}

// RT-HS-04 — client proof over the same transcript.
export interface ClientAuth {
  readonly clientProof: string;
}

// RT-HS-05 — returned only after mutual proof + platform/limit version match.
export interface DaemonHello {
  readonly selectedProtocolVersion: number;
  readonly daemonId: DaemonId;
  readonly daemonGeneration: Generation;
  readonly platformMatrixVersion: number;
  readonly runtimeLimitProfileVersion: number;
  readonly capabilities: readonly string[];
}

// Negotiation outcome used by the pure handshake FSM in packages/transport.
export type HandshakeNegotiation =
  | { readonly kind: "challenge"; readonly challenge: DaemonChallenge }
  | { readonly kind: "fatal"; readonly code: "UnsupportedVersion"; readonly message: string };
