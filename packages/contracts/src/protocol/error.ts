// RT-ERR-01 / RT-ERR-02 — error contract.

import type { CommandId } from "../identity.js";

export type ErrorCode =
  | "InvalidRequest"
  | "UnsupportedVersion"
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "Conflict"
  | "IdempotencyConflict"
  | "StaleGeneration"
  | "StaleControlLease"
  | "ConfirmationRequired"
  | "CapabilityUnavailable"
  | "StoragePressure"
  | "UnsupportedRepository"
  | "RepositoryInvalid"
  | "UnsupportedPlatform"
  | "RecoveryRequired"
  | "DataIntegrityFailure"
  | "InternalFailure";

// RT-ERR-01 — stable code, user-readable message, retryability, commandId.
// No internal paths, env vars, or secrets in message.
export interface ErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly commandId: CommandId | undefined;
}
