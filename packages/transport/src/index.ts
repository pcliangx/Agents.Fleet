export type { DecodedFrame } from "./binary-frame.js";
export { decodeFrame, encodeFrame } from "./binary-frame.js";
export type { ProofRole, ProofTranscript } from "./capability-proof.js";
export { buildProofTranscript, computeProof, verifyProof } from "./capability-proof.js";
export type {
  CapabilityTokenSource,
  KeychainLookup,
  KeychainRunner,
} from "./capability-token.js";
export {
  DevTokenFileTokenSource,
  KeychainTokenSource,
  securityKeychainRunner,
} from "./capability-token.js";
export type { ConfirmationFlowDeps } from "./confirmation-broker.js";
export { requestConfirmation } from "./confirmation-broker.js";
export { signConfirmation, verifyConfirmation } from "./confirmation-proof.js";
export type { DaemonHandshakeConfig } from "./handshake-state.js";
export { negotiate, selectProtocolVersion } from "./handshake-state.js";
export { encodeNdjson, NdjsonDecoder } from "./ndjson.js";
export { parseMessage, stringifyMessage } from "./serialize.js";
export * from "./session-stream-consumer.js";
