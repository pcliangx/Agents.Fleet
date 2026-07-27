// R1-02 — Main-side confirmation + trust IPC core (SV1-ELECTRON-07 /
// SV1-AUTH-10 / SV1-TRUST-09/10), proven through injected seams:
//
// - the Renderer can only NAME a challenge ID: the dialog receives exactly the
//   daemon challenge's display, and the confirm command carries exactly the
//   (candidate, userIdentity) captured when the challenge was issued — there
//   is no parameter through which renderer display text, hashes or signing
//   material could flow;
// - the receipt Main signs verifies against the capability token;
// - cancel / unknown / expired challenges and daemon rejections return
//   structured results, never bare throws.

import type { ChallengeDisplay, ConfirmationChallenge } from "@agents-fleet/contracts";
import { verifyConfirmation } from "@agents-fleet/transport";
import { describe, expect, it, vi } from "vitest";
import {
  type ConfirmationIpcResult,
  type TrustCommandIpcResult,
  TrustIpcCore,
} from "./confirmation-ipc.js";
import type { CommandResponse, OutgoingCommand } from "./daemon-client.js";

const TOKEN = new TextEncoder().encode("r1-02-main-ipc-token");
const NOW = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const CANDIDATE = { canonicalRoot: "/repo", filesystemIdentity: { dev: 1, ino: 2 } };
const REQUEST = {
  candidate: CANDIDATE,
  userIdentity: "uid:501",
  plannedAgent: "claude",
  dataLocation: "~/.agents-fleet/data",
  hostPermissionUpperBound: "Balanced",
};

const CHALLENGE: ConfirmationChallenge = {
  challengeId: "ch_1",
  kind: "repository-trust",
  display: {
    title: "Grant Repository Trust",
    fields: [{ label: "Repository", value: "/repo" }],
  },
  payloadHash: "aa".repeat(32),
  bindingHashes: ["bb".repeat(32)],
  impactSummaryHash: "cc".repeat(32),
  issuedAt: iso(NOW),
  expiresAt: iso(NOW + 60_000),
};

class StubSender {
  readonly sent: OutgoingCommand[] = [];
  constructor(
    private readonly answer: (c: OutgoingCommand) => CommandResponse | Promise<CommandResponse>,
  ) {}
  async sendCommand(command: OutgoingCommand): Promise<CommandResponse> {
    this.sent.push(command);
    return await this.answer(command);
  }
}

const okWith = (result: unknown): CommandResponse => ({ commandId: "x" as never, result });

const wire = (opts: {
  answer: (c: OutgoingCommand) => CommandResponse | Promise<CommandResponse>;
  gesture?: "confirm" | "cancel";
  now?: () => number;
}) => {
  const sender = new StubSender(opts.answer);
  const showDialog = vi.fn(async (_display: ChallengeDisplay) => opts.gesture ?? "confirm");
  const core = new TrustIpcCore({
    sender,
    token: TOKEN,
    showDialog,
    now: opts.now ?? (() => NOW + 1000),
  });
  return { core, sender, showDialog };
};

describe("TrustIpcCore command forwards", () => {
  it("mints a fresh commandId and puts the kind on the payload", async () => {
    const { core, sender } = wire({ answer: () => okWith(CANDIDATE) });
    const r = (await core.prepareTrustCandidate("/repo")) as TrustCommandIpcResult;
    expect(r.ok).toBe(true);
    const cmd = sender.sent[0];
    if (cmd === undefined) throw new Error("expected a sent command");
    expect(cmd.payload).toEqual({ kind: "PrepareTrustCandidate", path: "/repo" });
    expect(cmd.schemaVersion).toBe(1);
    expect(typeof cmd.commandId).toBe("string");
    expect(cmd.commandId.length).toBeGreaterThan(0);
  });

  it("validates renderer arguments before sending anything", async () => {
    const { core, sender } = wire({ answer: () => okWith(null) });
    expect(((await core.prepareTrustCandidate(42)) as TrustCommandIpcResult).ok).toBe(false);
    expect(((await core.revokeTrust("t_1", "nuke")) as TrustCommandIpcResult).ok).toBe(false);
    expect(
      ((await core.issueTrustChallenge({ candidate: CANDIDATE })) as TrustCommandIpcResult).ok,
    ).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it("passes daemon domain errors through as structured results", async () => {
    const { core } = wire({
      answer: () => ({
        error: {
          code: "Conflict",
          message: "not runnable",
          retryable: false,
          commandId: "x" as never,
        },
      }),
    });
    const r = (await core.inspectRepository("w_1")) as TrustCommandIpcResult;
    expect(r).toEqual({
      ok: false,
      error: {
        code: "Conflict",
        message: "not runnable",
        retryable: false,
        commandId: "x" as never,
      },
    });
  });

  it("turns transport failures into structured results, never throws", async () => {
    const { core } = wire({
      answer: () => {
        throw new Error("daemon connection closed");
      },
    });
    const r = (await core.validateAndActivateTrust("t_1")) as TrustCommandIpcResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("InternalFailure");
  });
});

describe("TrustIpcCore.requestConfirmation (SV1-ELECTRON-07 / SV1-AUTH-10)", () => {
  const issueThenConfirm = async (core: TrustIpcCore): Promise<ConfirmationIpcResult> => {
    await core.issueTrustChallenge(REQUEST);
    return await core.requestConfirmation(CHALLENGE.challengeId);
  };

  const answer =
    (over: Partial<{ confirm: CommandResponse }> = {}) =>
    (c: OutgoingCommand): CommandResponse => {
      if (c.payload.kind === "GetConfirmationChallenge") return okWith(CHALLENGE);
      if (c.payload.kind === "IssueRepositoryTrustChallenge") return okWith(CHALLENGE);
      if (c.payload.kind === "ConfirmRepositoryTrust") {
        return over.confirm ?? okWith({ trustId: "t_1", state: "PendingValidation" });
      }
      throw new Error(`unexpected command: ${c.payload.kind}`);
    };

  it("confirm: dialog shows ONLY the daemon display; receipt verifies; confirm carries the issued context", async () => {
    const { core, sender, showDialog } = wire({ answer: answer() });
    const r = await issueThenConfirm(core);
    expect(r.status).toBe("confirmed");

    // The dialog rendered the daemon's challenge display — and nothing else
    // (SV1-TRUST-09/10: renderer display text can never reach it).
    expect(showDialog).toHaveBeenCalledWith(CHALLENGE.display);

    const confirmCmd = sender.sent.find((c) => c.payload.kind === "ConfirmRepositoryTrust");
    if (confirmCmd === undefined) throw new Error("expected a ConfirmRepositoryTrust command");
    expect(confirmCmd.payload.candidate).toEqual(CANDIDATE);
    expect(confirmCmd.payload.userIdentity).toBe("uid:501");
    const receipt = confirmCmd.repositoryTrustReceipt as {
      challengeId: string;
      proof: string;
      confirmedAt: string;
    };
    expect(receipt.challengeId).toBe(CHALLENGE.challengeId);
    // The receipt Main signed verifies against the shared capability token.
    expect(verifyConfirmation(CHALLENGE, receipt.confirmedAt, receipt.proof, TOKEN)).toBe(true);
  });

  it("cancel: structured cancelled result, no confirm command sent", async () => {
    const { core, sender } = wire({ answer: answer(), gesture: "cancel" });
    const r = await issueThenConfirm(core);
    expect(r).toEqual({ status: "cancelled" });
    expect(sender.sent.map((c) => c.payload.kind)).not.toContain("ConfirmRepositoryTrust");
  });

  it("unknown challenge: daemon NotFound propagates as a structured rejection", async () => {
    const { core } = wire({
      answer: () => ({
        error: {
          code: "NotFound",
          message: "unknown confirmation challenge",
          retryable: false,
          commandId: "x" as never,
        },
      }),
    });
    const r = await core.requestConfirmation("ch_nope");
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.error.code).toBe("NotFound");
  });

  it("expired challenge: rejected before the dialog is even shown", async () => {
    const { core, showDialog } = wire({
      answer: answer(),
      now: () => NOW + 120_000, // past expiresAt
    });
    await core.issueTrustChallenge(REQUEST);
    const r = await core.requestConfirmation(CHALLENGE.challengeId);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.error.code).toBe("ConfirmationRequired");
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("a challenge not issued through Main has no confirm context", async () => {
    const { core } = wire({ answer: answer() });
    const r = await core.requestConfirmation(CHALLENGE.challengeId);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.error.code).toBe("InvalidRequest");
  });

  it("daemon-side receipt refusal (replay/forgery) propagates as ConfirmationRequired", async () => {
    const { core } = wire({
      answer: answer({
        confirm: {
          error: {
            code: "ConfirmationRequired",
            message: "repository trust receipt rejected: already-consumed",
            retryable: false,
            commandId: "x" as never,
          },
        },
      }),
    });
    const r = await issueThenConfirm(core);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.error.code).toBe("ConfirmationRequired");
  });

  it("non-string challenge IDs are rejected without touching the daemon", async () => {
    const { core, sender } = wire({ answer: answer() });
    const r = await core.requestConfirmation({ challengeId: "ch_1" });
    expect(r.status).toBe("rejected");
    expect(sender.sent).toHaveLength(0);
  });
});
