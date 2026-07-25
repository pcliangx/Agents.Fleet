import { afterEach, describe, expect, it } from "vitest";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";

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
    expect(v().verify({ transcript: {}, clientProof: "dev-proof" }).ok).toBe(true);
  });

  it("rejects when the dev env is unset", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGENTS_FLEET_DEV_AUTH;
    expect(v().verify({ transcript: {}, clientProof: "dev-proof" }).ok).toBe(false);
  });

  it("rejects in production even when the gate is open", () => {
    process.env.NODE_ENV = "production";
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    expect(v().verify({ transcript: {}, clientProof: "dev-proof" }).ok).toBe(false);
  });

  it("rejects a wrong proof even when the gate is open", () => {
    process.env.NODE_ENV = "test";
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    expect(v().verify({ transcript: {}, clientProof: "nope" }).ok).toBe(false);
  });
});
