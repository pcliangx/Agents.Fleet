import type {
  ClientAuth,
  ClientHello,
  CommandEnvelope,
  DaemonHello,
} from "@agents-fleet/contracts";
import type { DaemonHandshakeConfig } from "@agents-fleet/transport";
import { beforeAll, describe, expect, it } from "vitest";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";
import { type ConnectionSink, ControlDispatcher } from "../control-dispatcher.js";

const config: DaemonHandshakeConfig = {
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: 0,
  runtimeLimitProfileVersion: 0,
  daemonNonce: "dn" as never,
  daemonProof: "p",
};

const hello = (over: Partial<ClientHello> = {}): ClientHello => ({
  protocolVersions: [1],
  expectedPlatformMatrixVersion: 0,
  expectedRuntimeLimitProfileVersion: 0,
  clientInstanceId: "c",
  clientKind: "electron-main",
  clientNonce: "cn" as never,
  ...over,
});

class CapturingSink implements ConnectionSink {
  readonly sent: unknown[] = [];
  closed = false;
  send(m: unknown): void {
    this.sent.push(m);
  }
  close(): void {
    this.closed = true;
  }
}

const errCode = (m: unknown): string | undefined =>
  (m as { error?: { code?: string } })?.error?.code;

describe("ControlDispatcher handshake (RT-HS-01..05)", () => {
  beforeAll(() => {
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    process.env.NODE_ENV = "test";
  });

  it("completes challenge -> DaemonHello on a full match", async () => {
    const sink = new CapturingSink();
    const d = new ControlDispatcher(config, new DevProofVerifier(), sink);
    await d.onMessage(hello());
    expect(d.currentState).toBe("awaiting-auth");
    expect(sink.sent).toHaveLength(1);

    await d.onMessage({ clientProof: "dev-proof" } as ClientAuth);
    expect(d.currentState).toBe("ready");
    expect(sink.sent).toHaveLength(2);
    expect((sink.sent[1] as DaemonHello).selectedProtocolVersion).toBe(1);
  });

  it("is fatal UnsupportedVersion + closed when no common protocol (RT-HS-03)", async () => {
    const sink = new CapturingSink();
    const d = new ControlDispatcher(config, new DevProofVerifier(), sink);
    await d.onMessage(hello({ protocolVersions: [99] }));
    expect(d.currentState).toBe("closed");
    expect(sink.closed).toBe(true);
    expect(errCode(sink.sent[0])).toBe("UnsupportedVersion");
  });

  it("fail-closes on a wrong proof with no DaemonHello (RT-HS-04)", async () => {
    const sink = new CapturingSink();
    const d = new ControlDispatcher(config, new DevProofVerifier(), sink);
    await d.onMessage(hello());
    await d.onMessage({ clientProof: "wrong" } as ClientAuth);
    expect(d.currentState).toBe("closed");
    expect(sink.closed).toBe(true);
    expect(sink.sent).toHaveLength(1); // challenge only, never DaemonHello
  });

  it("routes commands as not-implemented in the #1 stub", async () => {
    const sink = new CapturingSink();
    const d = new ControlDispatcher(config, new DevProofVerifier(), sink);
    await d.onMessage(hello());
    await d.onMessage({ clientProof: "dev-proof" } as ClientAuth);
    await d.onMessage({
      commandId: "c1" as never,
      schemaVersion: 1,
      payload: { kind: "Attach" },
    } as unknown as CommandEnvelope);
    expect(sink.sent).toHaveLength(3);
    expect(errCode(sink.sent[2])).toBe("InternalFailure");
  });
});
