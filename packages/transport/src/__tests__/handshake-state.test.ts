import type { ClientHello } from "@agents-fleet/contracts";
import { describe, expect, it } from "vitest";
import {
  type DaemonHandshakeConfig,
  negotiate,
  selectProtocolVersion,
} from "../handshake-state.js";

const config = (over: Partial<DaemonHandshakeConfig> = {}): DaemonHandshakeConfig => ({
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
  ...over,
});

const pc = { daemonNonce: "n" as never, daemonProof: "p" };

const hello = (over: Partial<ClientHello>): ClientHello => ({
  protocolVersions: [1],
  expectedPlatformMatrixVersion: 0,
  expectedRuntimeLimitProfileVersion: 0,
  clientInstanceId: "c",
  clientKind: "test",
  clientNonce: "cn" as never,
  ...over,
});

describe("handshake-state (RT-HS-01..05)", () => {
  it("selects the highest common protocol version", () => {
    expect(
      selectProtocolVersion(
        config({ supportedProtocolVersions: [1, 2] }),
        hello({ protocolVersions: [2, 3] }),
      ),
    ).toBe(2);
  });

  it("returns null when there is no common version", () => {
    expect(
      selectProtocolVersion(
        config({ supportedProtocolVersions: [1] }),
        hello({ protocolVersions: [2] }),
      ),
    ).toBeNull();
  });

  it("negotiates a challenge on a full match", () => {
    expect(negotiate(config(), hello({}), pc).kind).toBe("challenge");
  });

  it("is fatal UnsupportedVersion with no common protocol (RT-HS-03, no best-effort)", () => {
    expect(
      negotiate(config({ supportedProtocolVersions: [1] }), hello({ protocolVersions: [2] }), pc)
        .kind,
    ).toBe("fatal");
  });

  it("is fatal on platform matrix mismatch", () => {
    expect(
      negotiate(
        config({ platformMatrixVersion: 1 }),
        hello({ expectedPlatformMatrixVersion: 0 }),
        pc,
      ).kind,
    ).toBe("fatal");
  });

  it("is fatal on runtime-limit profile mismatch", () => {
    expect(
      negotiate(
        config({ runtimeLimitProfileVersion: 1 }),
        hello({ expectedRuntimeLimitProfileVersion: 0 }),
        pc,
      ).kind,
    ).toBe("fatal");
  });
});
