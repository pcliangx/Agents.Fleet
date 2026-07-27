// RT-PROFILE-01..03 — versioned Agent Profile persistence and immutable
// Attempt Profile snapshots.
//
// Profiles contain only bounded non-secret selections and explicit Keychain /
// Agent-owned credential references. The runtime validator accepts an exact
// schema so accidental `secret`, `token` or `value` fields fail before SQLite.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AdapterCapability,
  type AgentProfileFields,
  type AgentProfileInput,
  type AgentProfileSnapshot,
  checkLimit,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  isPermissionExpansion,
  type PermissionMapping,
  type PermissionMode,
  type ProfileId,
  type SecretReference,
} from "@agents-fleet/contracts";
import { secretReferenceIdentity } from "../agent-profile/secret-reference.js";
import { canonicalSha256 } from "../crypto/canonical-hash.js";
import { deepFreeze } from "../immutable/deep-freeze.js";
import { type Migration, transact } from "./database.js";
import { StoreError } from "./task-store.js";

export const AGENT_PROFILE_MIGRATIONS: readonly Migration[] = [
  {
    version: 5,
    name: "agent-profiles",
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_profiles (
          profile_id TEXT PRIMARY KEY,
          profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
          agent_id TEXT NOT NULL,
          account_ref TEXT,
          model TEXT,
          mode TEXT,
          permission_mode TEXT NOT NULL CHECK (permission_mode IN ('Manual','Balanced','YOLO')),
          secret_refs_json TEXT NOT NULL,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_agent_profiles_agent ON agent_profiles(agent_id, deleted_at);
        CREATE TABLE attempt_profile_snapshots (
          attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
          profile_id TEXT NOT NULL REFERENCES agent_profiles(profile_id),
          profile_version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL,
          adapter_capabilities_hash TEXT NOT NULL,
          permission_mapping_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export interface AgentProfileRecord extends AgentProfileFields {
  readonly profileId: ProfileId;
  readonly profileVersion: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdapterSnapshotFacts {
  readonly agentId: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly permissionMappings: readonly PermissionMapping[];
}

export interface CreateAttemptProfileSnapshotInput {
  readonly attemptId: string;
  readonly profileId: ProfileId;
  readonly adapter: AdapterSnapshotFacts;
}

interface ProfileRow {
  readonly profile_id: string;
  readonly profile_version: number;
  readonly agent_id: string;
  readonly account_ref: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly permission_mode: PermissionMode;
  readonly secret_refs_json: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SnapshotRow {
  readonly profile_id: string;
  readonly profile_version: number;
  readonly snapshot_json: string;
  readonly snapshot_hash: string;
  readonly adapter_capabilities_hash: string;
  readonly permission_mapping_hash: string;
}

const PROFILE_KEYS = [
  "agentId",
  "accountRef",
  "model",
  "mode",
  "permissionMode",
  "secretRefs",
] as const;
const KEYCHAIN_REFERENCE_KEYS = ["kind", "referenceId", "service", "account"] as const;
const AGENT_OWNED_REFERENCE_KEYS = ["kind", "referenceId", "agentId", "accountRef"] as const;
const PERMISSION_MODES: readonly PermissionMode[] = ["Manual", "Balanced", "YOLO"];
const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = [
  "Discovery",
  "Hook",
  "Transcript",
  "Resume",
  "PermissionMapping",
];
const SNAPSHOT_KEYS = [
  "profileId",
  "profileVersion",
  "agentId",
  "accountRef",
  "model",
  "mode",
  "permissionMode",
  "secretRefs",
  "secretReferenceIdentities",
  "adapterCapabilities",
  "adapterCapabilitiesHash",
  "permissionMapping",
  "permissionMappingHash",
] as const;
const PERMISSION_MAPPING_KEYS = [
  "requestedMode",
  "effectiveMode",
  "launchArgumentsPreview",
  "enforcedCapabilities",
  "unsupportedControls",
  "warnings",
] as const;

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void => {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new StoreError("InvalidRequest", `${what} contains an unsupported field`);
  }
};

const exactRequiredKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  what: string,
): void => {
  exactKeys(value, required, what);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new StoreError("InvalidRequest", `${what} is missing a required field`);
  }
};

const nonEmptyString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new StoreError("InvalidRequest", `${what} must be a non-empty string`);
  }
  return value;
};

const nullableString = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, what);
};

const permissionMode = (value: unknown, what: string): PermissionMode => {
  if (typeof value !== "string" || !(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new StoreError("InvalidRequest", `${what} is invalid`);
  }
  return value as PermissionMode;
};

const stringArray = (value: unknown, what: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.includes("\0"))
  ) {
    throw new StoreError("InvalidRequest", `${what} must be an array of strings`);
  }
  return [...value];
};

const validateSecretReference = (value: unknown): SecretReference => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("InvalidRequest", "secret reference must be an object");
  }
  const reference = value as Record<string, unknown>;
  if (reference.kind === "keychain") {
    exactKeys(reference, KEYCHAIN_REFERENCE_KEYS, "Keychain secret reference");
    return {
      kind: "keychain",
      referenceId: nonEmptyString(reference.referenceId, "secret reference id"),
      service: nonEmptyString(reference.service, "Keychain service"),
      account: nonEmptyString(reference.account, "Keychain account"),
    };
  }
  if (reference.kind === "agent-owned") {
    exactKeys(reference, AGENT_OWNED_REFERENCE_KEYS, "Agent-owned secret reference");
    return {
      kind: "agent-owned",
      referenceId: nonEmptyString(reference.referenceId, "secret reference id"),
      agentId: nonEmptyString(reference.agentId, "Agent-owned reference Agent"),
      accountRef: nonEmptyString(reference.accountRef, "Agent-owned account reference"),
    };
  }
  throw new StoreError("InvalidRequest", "secret reference kind is unsupported");
};

const normalizeProfile = (input: AgentProfileInput): AgentProfileFields => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StoreError("InvalidRequest", "Agent Profile must be an object");
  }
  exactKeys(input as unknown as Record<string, unknown>, PROFILE_KEYS, "Agent Profile");
  const raw = input as unknown as Record<string, unknown>;
  const savedPermissionMode = permissionMode(raw.permissionMode, "Agent Profile Permission Mode");
  if (!Array.isArray(raw.secretRefs)) {
    throw new StoreError("InvalidRequest", "Agent Profile secretRefs must be an array");
  }
  const secretRefs = raw.secretRefs.map(validateSecretReference);
  if (new Set(secretRefs.map((reference) => reference.referenceId)).size !== secretRefs.length) {
    throw new StoreError("InvalidRequest", "Agent Profile secret reference ids must be unique");
  }
  const agentId = nonEmptyString(raw.agentId, "Agent Profile agentId");
  if (
    secretRefs.some(
      (reference) => reference.kind === "agent-owned" && reference.agentId !== agentId,
    )
  ) {
    throw new StoreError(
      "InvalidRequest",
      "Agent-owned secret reference must match the Agent Profile agentId",
    );
  }
  const normalized: AgentProfileFields = {
    agentId,
    accountRef: nullableString(raw.accountRef, "Agent Profile accountRef"),
    model: nullableString(raw.model, "Agent Profile model"),
    mode: nullableString(raw.mode, "Agent Profile mode"),
    permissionMode: savedPermissionMode,
    secretRefs,
  };
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  const within = checkLimit(FROZEN_RUNTIME_LIMIT_PROFILE, "profileBytes", bytes);
  if (!within.ok) {
    throw new StoreError(
      "InvalidRequest",
      `Agent Profile is ${bytes} bytes, limit ${within.allowed}`,
    );
  }
  return normalized;
};

const validatePermissionMapping = (value: unknown): PermissionMapping => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("InvalidRequest", "Permission Mapping must be an object");
  }
  const raw = value as Record<string, unknown>;
  exactRequiredKeys(raw, PERMISSION_MAPPING_KEYS, "Permission Mapping");
  const mapping: PermissionMapping = {
    requestedMode: permissionMode(raw.requestedMode, "Permission Mapping requested mode"),
    effectiveMode: permissionMode(raw.effectiveMode, "Permission Mapping effective mode"),
    launchArgumentsPreview: stringArray(
      raw.launchArgumentsPreview,
      "Permission Mapping launch arguments",
    ),
    enforcedCapabilities: stringArray(
      raw.enforcedCapabilities,
      "Permission Mapping enforced capabilities",
    ),
    unsupportedControls: stringArray(
      raw.unsupportedControls,
      "Permission Mapping unsupported controls",
    ),
    warnings: stringArray(raw.warnings, "Permission Mapping warnings"),
  };
  if (isPermissionExpansion(mapping)) {
    throw new StoreError("InvalidRequest", "Permission Mapping expands the saved user intent");
  }
  return mapping;
};

const validateAdapterCapabilities = (value: unknown): AdapterCapability[] => {
  const capabilities = stringArray(value, "Adapter Capabilities");
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (capability) => !(ADAPTER_CAPABILITIES as readonly string[]).includes(capability),
    )
  ) {
    throw new StoreError("InvalidRequest", "Adapter Capabilities are invalid");
  }
  return capabilities as AdapterCapability[];
};

const validateAgentProfileSnapshot = (value: unknown): AgentProfileSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("InvalidRequest", "Agent Profile snapshot must be an object");
  }
  const raw = value as Record<string, unknown>;
  exactRequiredKeys(raw, SNAPSHOT_KEYS, "Agent Profile snapshot");
  const profile = normalizeProfile({
    agentId: raw.agentId,
    accountRef: raw.accountRef,
    model: raw.model,
    mode: raw.mode,
    permissionMode: raw.permissionMode,
    secretRefs: raw.secretRefs,
  } as unknown as AgentProfileInput);
  const profileVersion = raw.profileVersion;
  if (!Number.isInteger(profileVersion) || (profileVersion as number) < 1) {
    throw new StoreError("InvalidRequest", "Agent Profile snapshot version is invalid");
  }
  const secretReferenceIdentities = stringArray(
    raw.secretReferenceIdentities,
    "Agent Profile snapshot secret reference identities",
  );
  if (
    secretReferenceIdentities.length !== profile.secretRefs.length ||
    profile.secretRefs.some(
      (reference, index) => secretReferenceIdentity(reference) !== secretReferenceIdentities[index],
    )
  ) {
    throw new StoreError(
      "InvalidRequest",
      "Agent Profile snapshot secret reference identities are invalid",
    );
  }
  const adapterCapabilities = validateAdapterCapabilities(raw.adapterCapabilities);
  if (!adapterCapabilities.includes("PermissionMapping")) {
    throw new StoreError(
      "InvalidRequest",
      "Agent Profile snapshot is missing Permission Mapping capability",
    );
  }
  const mapping = validatePermissionMapping(raw.permissionMapping);
  if (mapping.requestedMode !== profile.permissionMode) {
    throw new StoreError(
      "InvalidRequest",
      "Agent Profile snapshot Permission Mapping does not match the saved mode",
    );
  }
  return {
    profileId: nonEmptyString(raw.profileId, "Agent Profile snapshot profileId") as ProfileId,
    profileVersion: profileVersion as number,
    ...profile,
    secretReferenceIdentities,
    adapterCapabilities,
    adapterCapabilitiesHash: nonEmptyString(
      raw.adapterCapabilitiesHash,
      "Agent Profile snapshot Adapter Capabilities hash",
    ),
    permissionMapping: mapping,
    permissionMappingHash: nonEmptyString(
      raw.permissionMappingHash,
      "Agent Profile snapshot Permission Mapping hash",
    ),
  };
};

const profileRecord = (row: ProfileRow): AgentProfileRecord => {
  let secretRefs: unknown;
  try {
    secretRefs = JSON.parse(row.secret_refs_json);
  } catch {
    throw new StoreError("DataIntegrityFailure", "stored Agent Profile is invalid");
  }
  try {
    if (!Number.isInteger(row.profile_version) || row.profile_version < 1) {
      throw new Error("profile version is invalid");
    }
    const profile = normalizeProfile({
      agentId: row.agent_id,
      accountRef: row.account_ref,
      model: row.model,
      mode: row.mode,
      permissionMode: row.permission_mode,
      secretRefs,
    } as unknown as AgentProfileInput);
    return deepFreeze({
      profileId: nonEmptyString(row.profile_id, "stored Agent Profile id") as ProfileId,
      profileVersion: row.profile_version,
      ...profile,
      deletedAt: nullableString(row.deleted_at, "stored Agent Profile deletion time"),
      createdAt: nonEmptyString(row.created_at, "stored Agent Profile creation time"),
      updatedAt: nonEmptyString(row.updated_at, "stored Agent Profile update time"),
    });
  } catch {
    throw new StoreError("DataIntegrityFailure", "stored Agent Profile is invalid");
  }
};

export class AgentProfileStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  #profileRow(profileId: ProfileId): ProfileRow {
    const row = this.#db
      .prepare("SELECT * FROM agent_profiles WHERE profile_id = ?")
      .get(profileId) as ProfileRow | undefined;
    if (row === undefined) throw new StoreError("NotFound", "no such Agent Profile");
    return row;
  }

  createProfile(input: AgentProfileInput): AgentProfileRecord {
    const profile = normalizeProfile(input);
    return transact(
      this.#db,
      () => {
        const profileId = `pf_${randomUUID()}` as ProfileId;
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `INSERT INTO agent_profiles
             (profile_id, profile_version, agent_id, account_ref, model, mode, permission_mode, secret_refs_json, deleted_at, created_at, updated_at)
             VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            profileId,
            profile.agentId,
            profile.accountRef,
            profile.model,
            profile.mode,
            profile.permissionMode,
            JSON.stringify(profile.secretRefs),
            now,
            now,
          );
        return profileRecord(this.#profileRow(profileId));
      },
      this.#now,
    );
  }

  getProfile(profileId: ProfileId): AgentProfileRecord {
    return profileRecord(this.#profileRow(profileId));
  }

  updateProfile(
    profileId: ProfileId,
    expectedVersion: number,
    input: AgentProfileInput,
  ): AgentProfileRecord {
    const profile = normalizeProfile(input);
    return transact(
      this.#db,
      () => {
        const row = this.#profileRow(profileId);
        if (row.deleted_at !== null) {
          throw new StoreError("Conflict", "cannot edit a deleted Agent Profile");
        }
        if (row.profile_version !== expectedVersion) {
          throw new StoreError("Conflict", "Agent Profile version changed");
        }
        this.#db
          .prepare(
            `UPDATE agent_profiles
             SET profile_version = profile_version + 1, agent_id = ?, account_ref = ?, model = ?, mode = ?,
                 permission_mode = ?, secret_refs_json = ?, updated_at = ?
             WHERE profile_id = ? AND profile_version = ? AND deleted_at IS NULL`,
          )
          .run(
            profile.agentId,
            profile.accountRef,
            profile.model,
            profile.mode,
            profile.permissionMode,
            JSON.stringify(profile.secretRefs),
            new Date(this.#now()).toISOString(),
            profileId,
            expectedVersion,
          );
        return profileRecord(this.#profileRow(profileId));
      },
      this.#now,
    );
  }

  deleteProfile(profileId: ProfileId, expectedVersion: number): AgentProfileRecord {
    return transact(
      this.#db,
      () => {
        const row = this.#profileRow(profileId);
        if (row.deleted_at !== null) {
          throw new StoreError("Conflict", "Agent Profile is already deleted");
        }
        if (row.profile_version !== expectedVersion) {
          throw new StoreError("Conflict", "Agent Profile version changed");
        }
        const now = new Date(this.#now()).toISOString();
        this.#db
          .prepare(
            `UPDATE agent_profiles
             SET profile_version = profile_version + 1, deleted_at = ?, updated_at = ?
             WHERE profile_id = ? AND profile_version = ? AND deleted_at IS NULL`,
          )
          .run(now, now, profileId, expectedVersion);
        return profileRecord(this.#profileRow(profileId));
      },
      this.#now,
    );
  }

  /**
   * RT-CMD-17 — build the immutable Profile/Capability/Permission facts used
   * by a Launch Confirmation preview without creating an Attempt row.
   */
  previewAttemptSnapshot(
    profileId: ProfileId,
    adapter: AdapterSnapshotFacts,
  ): AgentProfileSnapshot {
    const profile = this.getProfile(profileId);
    if (profile.deletedAt !== null) {
      throw new StoreError("Conflict", "cannot snapshot a deleted Agent Profile");
    }
    if (profile.agentId !== adapter.agentId) {
      throw new StoreError(
        "CapabilityUnavailable",
        "Agent Profile does not match verified Adapter discovery",
      );
    }
    if (!adapter.capabilities.includes("PermissionMapping")) {
      throw new StoreError(
        "CapabilityUnavailable",
        "verified Adapter does not declare Permission Mapping capability",
      );
    }
    const mappings = adapter.permissionMappings.filter(
      (candidate) => candidate.requestedMode === profile.permissionMode,
    );
    const mapping = mappings[0];
    if (mapping === undefined || mappings.length !== 1) {
      throw new StoreError(
        "CapabilityUnavailable",
        "verified Adapter must provide exactly one Permission Mapping for the saved mode",
      );
    }
    if (isPermissionExpansion(mapping)) {
      throw new StoreError(
        "ConfirmationRequired",
        "effective Permission Mode is broader than the saved user intent",
      );
    }
    return deepFreeze({
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      agentId: profile.agentId,
      accountRef: profile.accountRef,
      model: profile.model,
      mode: profile.mode,
      permissionMode: profile.permissionMode,
      secretRefs: structuredClone(profile.secretRefs),
      secretReferenceIdentities: profile.secretRefs.map(secretReferenceIdentity),
      adapterCapabilities: [...adapter.capabilities],
      adapterCapabilitiesHash: canonicalSha256(adapter.capabilities),
      permissionMapping: structuredClone(mapping),
      permissionMappingHash: canonicalSha256(mapping),
    });
  }

  createAttemptSnapshot(input: CreateAttemptProfileSnapshotInput): AgentProfileSnapshot {
    return transact(
      this.#db,
      () => {
        if (this.getAttemptSnapshot(input.attemptId) !== null) {
          throw new StoreError("Conflict", "Attempt already has an Agent Profile snapshot");
        }
        const attempt = this.#db
          .prepare("SELECT attempt_id FROM attempts WHERE attempt_id = ?")
          .get(input.attemptId) as { attempt_id: string } | undefined;
        if (attempt === undefined) throw new StoreError("NotFound", "no such Attempt");

        const snapshot = this.previewAttemptSnapshot(input.profileId, input.adapter);
        const snapshotHash = canonicalSha256(snapshot);
        this.#db
          .prepare(
            `INSERT INTO attempt_profile_snapshots
             (attempt_id, profile_id, profile_version, snapshot_json, snapshot_hash,
              adapter_capabilities_hash, permission_mapping_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.attemptId,
            snapshot.profileId,
            snapshot.profileVersion,
            JSON.stringify(snapshot),
            snapshotHash,
            snapshot.adapterCapabilitiesHash,
            snapshot.permissionMappingHash,
            new Date(this.#now()).toISOString(),
          );
        return deepFreeze(snapshot);
      },
      this.#now,
    );
  }

  getAttemptSnapshot(attemptId: string): AgentProfileSnapshot | null {
    const row = this.#db
      .prepare(
        `SELECT profile_id, profile_version, snapshot_json, snapshot_hash,
                adapter_capabilities_hash, permission_mapping_hash
         FROM attempt_profile_snapshots WHERE attempt_id = ?`,
      )
      .get(attemptId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      throw new StoreError("DataIntegrityFailure", "stored Agent Profile snapshot is invalid");
    }
    try {
      const parsed = validateAgentProfileSnapshot(snapshot);
      if (
        canonicalSha256(snapshot) !== row.snapshot_hash ||
        canonicalSha256(parsed) !== row.snapshot_hash ||
        parsed.profileId !== row.profile_id ||
        parsed.profileVersion !== row.profile_version ||
        canonicalSha256(parsed.adapterCapabilities) !== row.adapter_capabilities_hash ||
        canonicalSha256(parsed.permissionMapping) !== row.permission_mapping_hash ||
        parsed.adapterCapabilitiesHash !== row.adapter_capabilities_hash ||
        parsed.permissionMappingHash !== row.permission_mapping_hash
      ) {
        throw new Error("snapshot hash mismatch");
      }
      return deepFreeze(parsed);
    } catch {
      throw new StoreError("DataIntegrityFailure", "stored Agent Profile snapshot is invalid");
    }
  }
}
