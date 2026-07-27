// RT-PROFILE-01..03 — Agent Profile and immutable Attempt snapshot shapes.

import type { AdapterCapability, PermissionMapping, PermissionMode } from "./adapter.js";
import type { ProfileId } from "./identity.js";

export interface KeychainSecretReference {
  readonly kind: "keychain";
  readonly referenceId: string;
  readonly service: string;
  readonly account: string;
}

export interface AgentOwnedSecretReference {
  readonly kind: "agent-owned";
  readonly referenceId: string;
  readonly agentId: string;
  readonly accountRef: string;
}

export type SecretReference = KeychainSecretReference | AgentOwnedSecretReference;

export interface AgentProfileInput {
  readonly agentId: string;
  readonly accountRef?: string | null;
  readonly model?: string | null;
  readonly mode?: string | null;
  readonly permissionMode: PermissionMode;
  readonly secretRefs: readonly SecretReference[];
}

export interface AgentProfileFields {
  readonly agentId: string;
  readonly accountRef: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly permissionMode: PermissionMode;
  readonly secretRefs: readonly SecretReference[];
}

export interface AgentProfileSnapshot extends AgentProfileFields {
  readonly profileId: ProfileId;
  readonly profileVersion: number;
  readonly secretReferenceIdentities: readonly string[];
  readonly adapterCapabilities: readonly AdapterCapability[];
  readonly adapterCapabilitiesHash: string;
  readonly permissionMapping: PermissionMapping;
  readonly permissionMappingHash: string;
}
