// R1-02 — ControlDispatcher command routing for the Repository Trust chain:
// each of the 7 kinds reaches its TrustService / PersistentChallengeIssuer
// method, StoreError codes map straight into the RT-ERR-01 error shape,
// unrouted kinds keep the not-implemented stub, malformed envelopes are
// InvalidRequest, and a read-only-recovery router fails mutating commands
// with RecoveryRequired (RT-STATE-27).

import type {
  ClientAuth,
  ClientHello,
  CommandEnvelope,
  ConfirmationChallenge,
} from "@agents-fleet/contracts";
import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import type { DaemonHandshakeConfig } from "@agents-fleet/transport";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";
import type { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { type ConnectionSink, ControlDispatcher } from "../control-dispatcher.js";
import { TrustCommandRouter } from "../repository-trust/trust-command-router.js";
import type { TrustService } from "../repository-trust/trust-service.js";
import { StoreError } from "../storage/task-store.js";

const config: DaemonHandshakeConfig = {
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: PLATFORM_MATRIX_VERSION,
  runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
};

const token = new Uint8Array([1, 2, 3, 4]);

const hello = (): ClientHello => ({
  protocolVersions: [1],
  expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
  expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
  clientInstanceId: "c",
  clientKind: "electron-main",
  clientNonce: "cn" as never,
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

const CANDIDATE = { canonicalRoot: "/repo", filesystemIdentity: { dev: 1, ino: 2 } };
const RECEIPT = {
  challengeId: "ch_1",
  proof: "ab".repeat(32),
  confirmedAt: "2027-01-01T00:00:00Z",
};

const CHALLENGE: ConfirmationChallenge = {
  challengeId: "ch_1",
  kind: "repository-trust",
  display: { title: "Grant Repository Trust", fields: [] },
  payloadHash: "aa".repeat(32),
  bindingHashes: [],
  impactSummaryHash: "bb".repeat(32),
  issuedAt: "2027-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:05:00Z",
};

const envelope = (
  kind: string,
  fields: Record<string, unknown>,
  over: Record<string, unknown> = {},
): CommandEnvelope =>
  ({
    commandId: `cmd-${kind}`,
    schemaVersion: 1,
    payload: { kind, ...fields },
    ...over,
  }) as unknown as CommandEnvelope;

interface Wired {
  readonly sink: CapturingSink;
  readonly dispatcher: ControlDispatcher;
  readonly service: ReturnType<typeof makeService>;
  readonly challenges: { getChallenge: ReturnType<typeof vi.fn> };
}

const makeService = () => ({
  prepareCandidate: vi.fn(async () => CANDIDATE),
  issueTrustChallenge: vi.fn(() => CHALLENGE),
  confirmTrust: vi.fn(async () => ({ trustId: "t_1", state: "PendingValidation" })),
  validateAndActivate: vi.fn(async () => ({
    trust: { state: "Active" },
    workspace: {},
    failure: null,
  })),
  revokeTrust: vi.fn(() => ({
    trust: { state: "Revoked" },
    affectedAttempts: [],
    processChoice: null,
  })),
  inspectRepository: vi.fn(async () => ({ headCommitSha: "sha" })),
});

const wire = async (
  routerOverrides: { recoveryReason?: string; nullService?: boolean } = {},
): Promise<Wired> => {
  const service = makeService();
  const challenges = { getChallenge: vi.fn((): ConfirmationChallenge | undefined => CHALLENGE) };
  const router = new TrustCommandRouter({
    service: routerOverrides.nullService === true ? null : (service as unknown as TrustService),
    challenges:
      routerOverrides.nullService === true
        ? null
        : (challenges as unknown as PersistentChallengeIssuer),
    recoveryReason: routerOverrides.recoveryReason,
  });
  const sink = new CapturingSink();
  const dispatcher = new ControlDispatcher(config, new DevProofVerifier(), sink, token, router);
  await dispatcher.onMessage(hello());
  await dispatcher.onMessage({ clientProof: "dev-proof" } as ClientAuth);
  return { sink, dispatcher, service, challenges };
};

const last = (sink: CapturingSink): unknown => sink.sent[sink.sent.length - 1];
const errCode = (m: unknown): string | undefined =>
  (m as { error?: { code?: string } })?.error?.code;

describe("ControlDispatcher trust command routing (R1-02)", () => {
  beforeAll(() => {
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    process.env.NODE_ENV = "test";
  });

  it("routes PrepareTrustCandidate to TrustService.prepareCandidate", async () => {
    const { sink, dispatcher, service } = await wire();
    await dispatcher.onMessage(envelope("PrepareTrustCandidate", { path: "/repo" }));
    expect(service.prepareCandidate).toHaveBeenCalledWith("cmd-PrepareTrustCandidate", "/repo");
    expect(last(sink)).toEqual({ commandId: "cmd-PrepareTrustCandidate", result: CANDIDATE });
  });

  it("routes IssueRepositoryTrustChallenge with the full display request", async () => {
    const { sink, dispatcher, service } = await wire();
    const fields = {
      candidate: CANDIDATE,
      userIdentity: "uid:501",
      plannedAgent: "claude",
      dataLocation: "~/.agents-fleet",
      hostPermissionUpperBound: "Balanced",
    };
    await dispatcher.onMessage(envelope("IssueRepositoryTrustChallenge", fields));
    expect(service.issueTrustChallenge).toHaveBeenCalledWith(
      "cmd-IssueRepositoryTrustChallenge",
      fields,
    );
    expect(last(sink)).toEqual({
      commandId: "cmd-IssueRepositoryTrustChallenge",
      result: CHALLENGE,
    });
  });

  it("routes ConfirmRepositoryTrust with the envelope receipt", async () => {
    const { sink, dispatcher, service } = await wire();
    await dispatcher.onMessage(
      envelope(
        "ConfirmRepositoryTrust",
        { candidate: CANDIDATE, userIdentity: "uid:501" },
        { repositoryTrustReceipt: RECEIPT },
      ),
    );
    expect(service.confirmTrust).toHaveBeenCalledWith(
      "cmd-ConfirmRepositoryTrust",
      CANDIDATE,
      RECEIPT,
      "uid:501",
    );
    expect(last(sink)).toEqual({
      commandId: "cmd-ConfirmRepositoryTrust",
      result: { trustId: "t_1", state: "PendingValidation" },
    });
  });

  it("fails ConfirmRepositoryTrust without a receipt as ConfirmationRequired (RT-CMD-06/16)", async () => {
    const { sink, dispatcher, service } = await wire();
    await dispatcher.onMessage(
      envelope("ConfirmRepositoryTrust", { candidate: CANDIDATE, userIdentity: "uid:501" }),
    );
    expect(service.confirmTrust).not.toHaveBeenCalled();
    expect(errCode(last(sink))).toBe("ConfirmationRequired");
  });

  it("routes ValidateAndActivateTrust / RevokeRepositoryTrust / InspectRepositoryTrust", async () => {
    const { sink, dispatcher, service } = await wire();
    await dispatcher.onMessage(envelope("ValidateAndActivateTrust", { trustId: "t_1" }));
    expect(service.validateAndActivate).toHaveBeenCalledWith("cmd-ValidateAndActivateTrust", "t_1");

    await dispatcher.onMessage(
      envelope("RevokeRepositoryTrust", { trustId: "t_1", runningProcessChoice: "keep" }),
    );
    expect(service.revokeTrust).toHaveBeenCalledWith("cmd-RevokeRepositoryTrust", "t_1", "keep");

    await dispatcher.onMessage(envelope("InspectRepositoryTrust", { workspaceId: "w_1" }));
    expect(service.inspectRepository).toHaveBeenCalledWith("w_1");
    expect(last(sink)).toEqual({
      commandId: "cmd-InspectRepositoryTrust",
      result: { headCommitSha: "sha" },
    });
  });

  it("routes GetConfirmationChallenge to the issuer; unknown IDs are NotFound", async () => {
    const { sink, dispatcher, challenges } = await wire();
    await dispatcher.onMessage(envelope("GetConfirmationChallenge", { challengeId: "ch_1" }));
    expect(challenges.getChallenge).toHaveBeenCalledWith("ch_1");
    expect(last(sink)).toEqual({ commandId: "cmd-GetConfirmationChallenge", result: CHALLENGE });

    challenges.getChallenge.mockReturnValue(undefined);
    await dispatcher.onMessage(envelope("GetConfirmationChallenge", { challengeId: "ch_x" }));
    expect(errCode(last(sink))).toBe("NotFound");
  });

  it("maps StoreError codes into the RT-ERR-01 error shape (retryable: false)", async () => {
    const { sink, dispatcher, service } = await wire();
    service.prepareCandidate.mockRejectedValue(
      new StoreError("IdempotencyConflict", "payload drift"),
    );
    await dispatcher.onMessage(envelope("PrepareTrustCandidate", { path: "/repo" }));
    expect(last(sink)).toEqual({
      error: {
        code: "IdempotencyConflict",
        message: "payload drift",
        retryable: false,
        commandId: "cmd-PrepareTrustCandidate",
      },
    });

    service.revokeTrust.mockImplementation(() => {
      throw new StoreError("ConfirmationRequired", "stop-or-keep choice required");
    });
    await dispatcher.onMessage(envelope("RevokeRepositoryTrust", { trustId: "t_1" }));
    expect(errCode(last(sink))).toBe("ConfirmationRequired");
  });

  it("collapses unknown exceptions to InternalFailure with a generic message (RT-ERR-01)", async () => {
    const { sink, dispatcher, service } = await wire();
    service.inspectRepository.mockRejectedValue(
      new Error("sqlite disk at /internal/path exploded"),
    );
    await dispatcher.onMessage(envelope("InspectRepositoryTrust", { workspaceId: "w_1" }));
    const err = (last(sink) as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("InternalFailure");
    expect(err.message).not.toContain("/internal/path");
  });

  it("keeps unrouted kinds on the not-implemented stub", async () => {
    const { sink, dispatcher } = await wire();
    await dispatcher.onMessage(envelope("Attach", {}));
    expect(errCode(last(sink))).toBe("InternalFailure");
    expect(sink.closed).toBe(false); // a command error never closes the connection
  });

  it("rejects malformed envelopes as InvalidRequest", async () => {
    const { sink, dispatcher } = await wire();
    await dispatcher.onMessage({ schemaVersion: 1, payload: { kind: "Attach" } } as never);
    expect(errCode(last(sink))).toBe("InvalidRequest");

    await dispatcher.onMessage({ commandId: "c1", payload: { kind: "Attach" } } as never);
    expect(errCode(last(sink))).toBe("InvalidRequest");

    await dispatcher.onMessage({ commandId: "c1", schemaVersion: 1, payload: {} } as never);
    expect(errCode(last(sink))).toBe("InvalidRequest");
  });

  it("rejects bad payload shapes as InvalidRequest before touching the service", async () => {
    const { sink, dispatcher, service } = await wire();
    await dispatcher.onMessage(envelope("PrepareTrustCandidate", { path: 42 }));
    expect(service.prepareCandidate).not.toHaveBeenCalled();
    expect(errCode(last(sink))).toBe("InvalidRequest");

    await dispatcher.onMessage(
      envelope("ConfirmRepositoryTrust", { candidate: { canonicalRoot: "/r" }, userIdentity: "u" }),
    );
    expect(service.confirmTrust).not.toHaveBeenCalled();
    expect(errCode(last(sink))).toBe("InvalidRequest");
  });

  it("read-only recovery: mutating commands fail RecoveryRequired, reads stay available (RT-STATE-27)", async () => {
    const { sink, dispatcher, service, challenges } = await wire({
      recoveryReason: "integrity_check failed on open",
    });
    await dispatcher.onMessage(envelope("PrepareTrustCandidate", { path: "/repo" }));
    expect(service.prepareCandidate).not.toHaveBeenCalled();
    expect(errCode(last(sink))).toBe("RecoveryRequired");

    await dispatcher.onMessage(envelope("RevokeRepositoryTrust", { trustId: "t_1" }));
    expect(errCode(last(sink))).toBe("RecoveryRequired");

    await dispatcher.onMessage(envelope("GetConfirmationChallenge", { challengeId: "ch_1" }));
    expect(challenges.getChallenge).toHaveBeenCalled();
    expect(last(sink)).toEqual({ commandId: "cmd-GetConfirmationChallenge", result: CHALLENGE });

    await dispatcher.onMessage(envelope("InspectRepositoryTrust", { workspaceId: "w_1" }));
    expect(service.inspectRepository).toHaveBeenCalled();
  });

  it("read-only recovery without a readable handle fails everything RecoveryRequired", async () => {
    const { sink, dispatcher } = await wire({
      recoveryReason: "cannot open database",
      nullService: true,
    });
    await dispatcher.onMessage(envelope("GetConfirmationChallenge", { challengeId: "ch_1" }));
    expect(errCode(last(sink))).toBe("RecoveryRequired");
    await dispatcher.onMessage(envelope("InspectRepositoryTrust", { workspaceId: "w_1" }));
    expect(errCode(last(sink))).toBe("RecoveryRequired");
  });
});
