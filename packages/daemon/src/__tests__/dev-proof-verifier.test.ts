import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import type { ProofTranscript } from "@agents-fleet/transport";
import { afterEach, describe, expect, it } from "vitest";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";

const T: ProofTranscript = {
  clientNonce: "cn",
  daemonNonce: "dn",
  selectedProtocolVersion: 1,
  clientInstanceId: "c",
  clientKind: "test",
  daemonId: "d",
  daemonGeneration: 1,
  platformMatrixVersion: PLATFORM_MATRIX_VERSION,
  runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
};

describe("DevProofVerifier (D4 hard gate)", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDev = process.env.AGENTS_FLEET_DEV_AUTH;

  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevDev === undefined) delete process.env.AGENTS_FLEET_DEV_AUTH;
    else process.env.AGENTS_FLEET_DEV_AUTH = prevDev;
  });

  const v = () => new DevProofVerifier();

  it("accepts the dev proof when the gate is open and not production", () => {
    process.env.NODE_ENV = "test";
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    expect(v().verify({ transcript: T, clientProof: "dev-proof" }).ok).toBe(true);
  });

  it("rejects when the dev env is unset", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGENTS_FLEET_DEV_AUTH;
    expect(v().verify({ transcript: T, clientProof: "dev-proof" }).ok).toBe(false);
  });

  it("rejects in production even when the gate is open", () => {
    process.env.NODE_ENV = "production";
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    expect(v().verify({ transcript: T, clientProof: "dev-proof" }).ok).toBe(false);
  });

  it("rejects a wrong proof even when the gate is open", () => {
    process.env.NODE_ENV = "test";
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    expect(v().verify({ transcript: T, clientProof: "nope" }).ok).toBe(false);
  });
});
