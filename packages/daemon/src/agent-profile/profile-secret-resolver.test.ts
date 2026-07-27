import {
  type AgentProfileSnapshot,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type SecretReference,
} from "@agents-fleet/contracts";
import { CLAUDE_CAPABILITY_PROFILE } from "@agents-fleet/testing";
import { describe, expect, it } from "vitest";
import {
  KeychainSecretReferenceBackend,
  ProfileSecretResolver,
  type SecretReferenceBackend,
} from "./profile-secret-resolver.js";
import { secretReferenceIdentity } from "./secret-reference.js";

const REFERENCE: SecretReference = {
  kind: "keychain",
  referenceId: "anthropic-api",
  service: "agents-fleet",
  account: "profile-anthropic-api",
};

const BALANCED_PERMISSION_MAPPING = CLAUDE_CAPABILITY_PROFILE.permissionMappings[1];
if (BALANCED_PERMISSION_MAPPING === undefined) {
  throw new Error("Balanced fixture mapping is missing");
}

const snapshot = (
  secretReferenceIdentities = [secretReferenceIdentity(REFERENCE)],
): AgentProfileSnapshot => ({
  profileId: "profile-1" as never,
  profileVersion: 1,
  agentId: "claude-code",
  accountRef: null,
  model: null,
  mode: null,
  permissionMode: "Balanced",
  secretRefs: [REFERENCE],
  secretReferenceIdentities,
  adapterCapabilities: CLAUDE_CAPABILITY_PROFILE.capabilities,
  adapterCapabilitiesHash: "sha256:capabilities",
  permissionMapping: BALANCED_PERMISSION_MAPPING,
  permissionMappingHash: "sha256:mapping",
});

describe("ProfileSecretResolver (RT-PROFILE-03)", () => {
  it("keeps resolved material out of serialization and zeroes it on dispose", async () => {
    const bytes = new Uint8Array(Buffer.from("secret-material-canary", "utf8"));
    const backend: SecretReferenceBackend = {
      async resolve(reference) {
        return {
          kind: "resolved",
          referenceIdentity: secretReferenceIdentity(reference),
          bytes,
        };
      },
    };
    const resolved = await new ProfileSecretResolver(backend).resolve(snapshot());
    expect(Buffer.from(resolved.read("anthropic-api")).toString("utf8")).toBe(
      "secret-material-canary",
    );
    expect(JSON.stringify(resolved)).toBe('{"referenceIds":["anthropic-api"]}');
    resolved.dispose();
    expect([...bytes]).toEqual(new Array(bytes.byteLength).fill(0));
    expect(() => resolved.read("anthropic-api")).toThrowError(/disposed/i);
  });

  it.each([
    ["missing", "CapabilityUnavailable"],
    ["permission-denied", "ConfirmationRequired"],
    ["failed", "CapabilityUnavailable"],
  ] as const)("maps %s without leaking backend diagnostics", async (kind, code) => {
    const backend: SecretReferenceBackend = {
      async resolve() {
        return { kind, diagnostic: "SECRET_BACKEND_DIAGNOSTIC_CANARY" };
      },
    };
    await expect(new ProfileSecretResolver(backend).resolve(snapshot())).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining("SECRET_BACKEND_DIAGNOSTIC_CANARY"),
    });
  });

  it("requires the current reference identity to match the immutable snapshot", async () => {
    let calls = 0;
    const backend: SecretReferenceBackend = {
      async resolve() {
        calls += 1;
        return {
          kind: "resolved",
          referenceIdentity: "keychain:sha256:drifted",
          bytes: new Uint8Array([1, 2, 3]),
        };
      },
    };
    await expect(
      new ProfileSecretResolver(backend).resolve(snapshot(["keychain:sha256:expected"])),
    ).rejects.toMatchObject({ code: "ConfirmationRequired" });
    expect(calls).toBe(0);
  });

  it("rejects duplicate references and zeroes resolved material above the bound", async () => {
    let calls = 0;
    const oversized = new Uint8Array(FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes + 1).fill(7);
    const backend: SecretReferenceBackend = {
      async resolve(reference) {
        calls += 1;
        return {
          kind: "resolved",
          referenceIdentity: secretReferenceIdentity(reference),
          bytes: oversized,
        };
      },
    };
    const resolver = new ProfileSecretResolver(backend);
    const base = snapshot();
    await expect(
      resolver.resolve({
        ...base,
        secretRefs: [REFERENCE, REFERENCE],
        secretReferenceIdentities: [
          secretReferenceIdentity(REFERENCE),
          secretReferenceIdentity(REFERENCE),
        ],
      }),
    ).rejects.toMatchObject({ code: "ConfirmationRequired" });
    expect(calls).toBe(0);

    await expect(resolver.resolve(base)).rejects.toMatchObject({
      code: "CapabilityUnavailable",
    });
    expect([...oversized]).toEqual(new Array(oversized.byteLength).fill(0));
  });

  it("resolves Keychain references through the macOS Keychain runner without persisting values", async () => {
    const backend = new KeychainSecretReferenceBackend({
      async findGenericPassword(service, account) {
        expect({ service, account }).toEqual({
          service: "agents-fleet",
          account: "profile-anthropic-api",
        });
        return { ok: true, bytes: new Uint8Array([7, 8, 9]) };
      },
    });
    await expect(backend.resolve(REFERENCE)).resolves.toEqual({
      kind: "resolved",
      referenceIdentity: secretReferenceIdentity(REFERENCE),
      bytes: new Uint8Array([7, 8, 9]),
    });
    await expect(
      backend.resolve({
        kind: "agent-owned",
        referenceId: "claude-account",
        agentId: "claude-code",
        accountRef: "account-reference",
      }),
    ).resolves.toMatchObject({ kind: "failed" });
  });
});
