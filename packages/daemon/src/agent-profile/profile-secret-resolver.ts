// RT-PROFILE-03 / SV1-DATA-01 — resolve immutable secret references immediately
// before the launch transaction. Secret bytes are never serialized or logged
// and have an explicit zeroing lifecycle.

import type { ErrorCode } from "@agents-fleet/contracts";
import {
  type AgentProfileSnapshot,
  checkLimit,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type SecretReference,
} from "@agents-fleet/contracts";
import { type KeychainRunner, securityKeychainRunner } from "@agents-fleet/transport";
import { secretReferenceIdentity } from "./secret-reference.js";

export type SecretReferenceResolution =
  | {
      readonly kind: "resolved";
      readonly referenceIdentity: string;
      /** Ownership transfers to ResolvedProfileSecrets and is zeroed on dispose/failure. */
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "missing" | "permission-denied" | "failed";
      /** Backend-only diagnostic; ProfileSecretResolver never exposes it. */
      readonly diagnostic?: string;
    };

export interface SecretReferenceBackend {
  resolve(reference: SecretReference): Promise<SecretReferenceResolution>;
}

export class KeychainSecretReferenceBackend implements SecretReferenceBackend {
  readonly #runner: KeychainRunner;

  constructor(runner: KeychainRunner = securityKeychainRunner) {
    this.#runner = runner;
  }

  async resolve(reference: SecretReference): Promise<SecretReferenceResolution> {
    if (reference.kind !== "keychain") {
      // Agent-owned credentials require that Adapter's own verified credential
      // probe. Never pretend a generic Keychain lookup proved availability.
      return { kind: "failed" };
    }
    const result = await this.#runner.findGenericPassword(reference.service, reference.account);
    if (result.ok) {
      return {
        kind: "resolved",
        referenceIdentity: secretReferenceIdentity(reference),
        bytes: result.bytes,
      };
    }
    return result.code === "notFound" ? { kind: "missing" } : { kind: "failed" };
  }
}

export class ProfileSecretResolutionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProfileSecretResolutionError";
    this.code = code;
  }
}

export class ResolvedProfileSecrets {
  readonly #entries: ReadonlyMap<string, Uint8Array>;
  #disposed = false;

  constructor(entries: ReadonlyMap<string, Uint8Array>) {
    this.#entries = entries;
  }

  get referenceIds(): readonly string[] {
    return [...this.#entries.keys()];
  }

  read(referenceId: string): Uint8Array {
    if (this.#disposed) throw new Error("resolved Profile secrets have been disposed");
    const bytes = this.#entries.get(referenceId);
    if (bytes === undefined) throw new Error("resolved Profile secret reference is unavailable");
    return bytes;
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const bytes of this.#entries.values()) bytes.fill(0);
    this.#disposed = true;
  }

  toJSON(): { readonly referenceIds: readonly string[] } {
    return { referenceIds: this.referenceIds };
  }
}

const resolutionFailure = (
  kind: Exclude<SecretReferenceResolution["kind"], "resolved">,
): ProfileSecretResolutionError => {
  switch (kind) {
    case "permission-denied":
      return new ProfileSecretResolutionError(
        "ConfirmationRequired",
        "secret reference permission changed",
      );
    case "missing":
      return new ProfileSecretResolutionError(
        "CapabilityUnavailable",
        "required secret reference is unavailable",
      );
    case "failed":
      return new ProfileSecretResolutionError(
        "CapabilityUnavailable",
        "secret reference could not be resolved",
      );
  }
};

export class ProfileSecretResolver {
  readonly #backend: SecretReferenceBackend;

  constructor(backend: SecretReferenceBackend) {
    this.#backend = backend;
  }

  async resolve(snapshot: AgentProfileSnapshot): Promise<ResolvedProfileSecrets> {
    const referenceIds = snapshot.secretRefs.map((reference) => reference.referenceId);
    if (
      snapshot.secretRefs.length !== snapshot.secretReferenceIdentities.length ||
      new Set(referenceIds).size !== referenceIds.length
    ) {
      throw new ProfileSecretResolutionError(
        "ConfirmationRequired",
        "Agent Profile secret reference identities changed",
      );
    }
    for (const [index, reference] of snapshot.secretRefs.entries()) {
      if (secretReferenceIdentity(reference) !== snapshot.secretReferenceIdentities[index]) {
        throw new ProfileSecretResolutionError(
          "ConfirmationRequired",
          "Agent Profile secret reference identities changed",
        );
      }
    }

    const entries = new Map<string, Uint8Array>();
    try {
      for (const [index, reference] of snapshot.secretRefs.entries()) {
        const resolved = await this.#backend.resolve(reference);
        if (resolved.kind !== "resolved") throw resolutionFailure(resolved.kind);
        const expectedIdentity = snapshot.secretReferenceIdentities[index];
        if (resolved.referenceIdentity !== expectedIdentity) {
          resolved.bytes.fill(0);
          throw new ProfileSecretResolutionError(
            "ConfirmationRequired",
            "resolved secret reference identity changed",
          );
        }
        const within = checkLimit(
          FROZEN_RUNTIME_LIMIT_PROFILE,
          "profileBytes",
          resolved.bytes.byteLength,
        );
        if (!within.ok) {
          resolved.bytes.fill(0);
          throw new ProfileSecretResolutionError(
            "CapabilityUnavailable",
            "resolved secret material exceeds the runtime limit",
          );
        }
        entries.set(reference.referenceId, resolved.bytes);
      }
      return new ResolvedProfileSecrets(entries);
    } catch (error) {
      for (const bytes of entries.values()) bytes.fill(0);
      if (error instanceof ProfileSecretResolutionError) throw error;
      throw new ProfileSecretResolutionError(
        "CapabilityUnavailable",
        "secret reference could not be resolved",
      );
    }
  }
}
