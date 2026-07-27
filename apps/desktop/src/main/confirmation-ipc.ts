// R1-02 / SV1-ELECTRON-06/07 / SV1-AUTH-05/10 / SV1-TRUST-09/10 — the Main-side
// IPC for the Repository Trust chain and the native confirmation flow.
//
// Two groups of command-named channels (no generic send/invoke):
//
// - Trust command forwards (prepareTrustCandidate / issueTrustChallenge /
//   validateAndActivateTrust / revokeTrust / inspectRepository): Main validates
//   the renderer's arguments, mints a fresh commandId, forwards the command to
//   the daemon over the authenticated socket (SV1-AUTH-05 — the Renderer never
//   touches it) and returns the daemon's structured response.
//
// - requestConfirmation(challengeId): the ONLY confirmation entry point. The
//   Renderer can name an already-issued challenge ID and nothing else — any
//   display text or payload it sends is ignored by construction (there is no
//   parameter for it). Main fetches the challenge from the daemon
//   (GetConfirmationChallenge), renders ONLY the daemon's fixed display fields
//   in the native dialog, and only after a real confirm gesture signs the
//   receipt with the capability token (SV1-TRUST-09) and sends the
//   kind-matching confirm command (this slice: repository-trust →
//   ConfirmRepositoryTrust with envelope.repositoryTrustReceipt).
//
// Expired / unknown challenges, user cancel and daemon rejections all return
// structured results — the IPC never throws a bare error at the Renderer.
//
// TrustIpcCore is the pure, Electron-free logic (the dialog, the clock and
// the command sender are injected seams); registerTrustIpc wires it to
// handleTrustedIpc + showNativeConfirmation in the real app.

import { randomUUID } from "node:crypto";
import type {
  ChallengeDisplay,
  ConfirmationChallenge,
  ConfirmationReceipt,
  ConfirmRepositoryTrustPayload,
  ErrorShape,
} from "@agents-fleet/contracts";
import { isChallengeExpired } from "@agents-fleet/contracts";
import { signConfirmation } from "@agents-fleet/transport";
import { showNativeConfirmation } from "./confirmation-dialog.js";
import { type CommandResponse, isCommandError, type OutgoingCommand } from "./daemon-client.js";
import type { TrustedSenderContext } from "./ipc-guard.js";
import { handleTrustedIpc } from "./trusted-ipc.js";

export interface DaemonErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly commandId?: string | undefined;
}

/** Uniform result of the trust-command forward methods. Never throws. */
export type TrustCommandIpcResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: DaemonErrorInfo };

/** Result of requestConfirmation. `rejected` covers unknown/expired
 *  challenges, missing confirm context and daemon-side refusals. */
export type ConfirmationIpcResult =
  | { readonly status: "confirmed"; readonly result: unknown }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly error: DaemonErrorInfo };

/** The seam TrustIpcCore talks to the daemon through (DaemonClient in prod). */
export interface TrustCommandSender {
  sendCommand(command: OutgoingCommand): Promise<CommandResponse>;
}

export interface TrustIpcCoreDeps {
  readonly sender: TrustCommandSender;
  /** Capability token for the receipt MAC; never leaves Main (SV1-AUTH-08). */
  readonly token: Uint8Array;
  readonly showDialog: (display: ChallengeDisplay) => Promise<"confirm" | "cancel">;
  readonly now?: (() => number) | undefined;
}

const errorInfo = (e: ErrorShape): DaemonErrorInfo => ({
  code: e.code,
  message: e.message,
  retryable: e.retryable,
  commandId: e.commandId,
});

const transportFailure = (e: unknown): DaemonErrorInfo => ({
  code: "InternalFailure",
  message: `daemon command failed: ${(e as Error).message}`,
  retryable: false,
});

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (r: Record<string, unknown>, key: string): string | null => {
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

export class TrustIpcCore {
  readonly #sender: TrustCommandSender;
  readonly #token: Uint8Array;
  readonly #showDialog: (display: ChallengeDisplay) => Promise<"confirm" | "cancel">;
  readonly #now: () => number;
  // challengeId → the (candidate, userIdentity) the challenge was issued for,
  // captured when Main forwarded IssueRepositoryTrustChallenge. The receipt
  // binds these facts; the Renderer cannot supply substitutes at confirm time.
  readonly #confirmContexts = new Map<string, ConfirmRepositoryTrustPayload>();

  constructor(deps: TrustIpcCoreDeps) {
    this.#sender = deps.sender;
    this.#token = deps.token;
    this.#showDialog = deps.showDialog;
    this.#now = deps.now ?? (() => Date.now());
  }

  async #send(
    kind: string,
    fields: Record<string, unknown>,
    receipt?: ConfirmationReceipt,
  ): Promise<TrustCommandIpcResult> {
    const command: OutgoingCommand = {
      commandId: randomUUID(),
      schemaVersion: 1,
      repositoryTrustReceipt: receipt,
      payload: { kind, ...fields },
    };
    let response: CommandResponse;
    try {
      response = await this.#sender.sendCommand(command);
    } catch (e) {
      return { ok: false, error: transportFailure(e) };
    }
    if (isCommandError(response)) return { ok: false, error: errorInfo(response.error) };
    return { ok: true, result: response.result };
  }

  // --- trust command forwards (no receipt signing here) --------------------

  /** RT-REPO-01 — canonicalize + stat only; the daemon runs no Git here. */
  async prepareTrustCandidate(path: unknown): Promise<TrustCommandIpcResult> {
    if (typeof path !== "string" || path.length === 0) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message: "path must be a non-empty string",
          retryable: false,
        },
      };
    }
    return await this.#send("PrepareTrustCandidate", { path });
  }

  /** RT-REPO-06 — issue the one-time Trust challenge; Main remembers the
   *  (candidate, userIdentity) context so a later requestConfirmation for the
   *  returned challengeId can send the matching confirm command. */
  async issueTrustChallenge(request: unknown): Promise<TrustCommandIpcResult> {
    const r = asRecord(request);
    const candidate = r?.candidate;
    const userIdentity = r !== null ? str(r, "userIdentity") : null;
    const plannedAgent = r !== null ? str(r, "plannedAgent") : null;
    const dataLocation = r !== null ? str(r, "dataLocation") : null;
    const hostPermissionUpperBound = r !== null ? str(r, "hostPermissionUpperBound") : null;
    if (
      r === null ||
      asRecord(candidate) === null ||
      userIdentity === null ||
      plannedAgent === null ||
      dataLocation === null ||
      hostPermissionUpperBound === null
    ) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message:
            "request must carry candidate, userIdentity, plannedAgent, dataLocation, hostPermissionUpperBound",
          retryable: false,
        },
      };
    }
    const result = await this.#send("IssueRepositoryTrustChallenge", {
      candidate,
      userIdentity,
      plannedAgent,
      dataLocation,
      hostPermissionUpperBound,
    });
    if (result.ok) {
      const challenge = result.result as ConfirmationChallenge;
      this.#confirmContexts.set(challenge.challengeId, {
        candidate: candidate as ConfirmRepositoryTrustPayload["candidate"],
        userIdentity,
      });
    }
    return result;
  }

  async validateAndActivateTrust(trustId: unknown): Promise<TrustCommandIpcResult> {
    if (typeof trustId !== "string" || trustId.length === 0) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message: "trustId must be a non-empty string",
          retryable: false,
        },
      };
    }
    return await this.#send("ValidateAndActivateTrust", { trustId });
  }

  async revokeTrust(
    trustId: unknown,
    runningProcessChoice: unknown,
  ): Promise<TrustCommandIpcResult> {
    if (typeof trustId !== "string" || trustId.length === 0) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message: "trustId must be a non-empty string",
          retryable: false,
        },
      };
    }
    if (
      runningProcessChoice !== undefined &&
      runningProcessChoice !== "stop" &&
      runningProcessChoice !== "keep"
    ) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message: "runningProcessChoice must be 'stop' or 'keep'",
          retryable: false,
        },
      };
    }
    return await this.#send("RevokeRepositoryTrust", { trustId, runningProcessChoice });
  }

  /** RT-REPO-04 — Active-only, declared read-only inspection (SV1-FILE-06). */
  async inspectRepository(workspaceId: unknown): Promise<TrustCommandIpcResult> {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return {
        ok: false,
        error: {
          code: "InvalidRequest",
          message: "workspaceId must be a non-empty string",
          retryable: false,
        },
      };
    }
    return await this.#send("InspectRepositoryTrust", { workspaceId });
  }

  // --- the confirmation flow (SV1-ELECTRON-07 / SV1-AUTH-10) ---------------

  /**
   * Open the native confirmation for an already-issued challenge. The
   * Renderer supplies ONLY the challenge ID; display content always comes
   * from the daemon's challenge (SV1-TRUST-09/10).
   */
  async requestConfirmation(challengeId: unknown): Promise<ConfirmationIpcResult> {
    if (typeof challengeId !== "string" || challengeId.length === 0) {
      return {
        status: "rejected",
        error: {
          code: "InvalidRequest",
          message: "challengeId must be a non-empty string",
          retryable: false,
        },
      };
    }
    const fetched = await this.#send("GetConfirmationChallenge", { challengeId });
    if (!fetched.ok) return { status: "rejected", error: fetched.error };
    const challenge = fetched.result as ConfirmationChallenge;

    if (isChallengeExpired(challenge, this.#now())) {
      return {
        status: "rejected",
        error: {
          code: "ConfirmationRequired",
          message: "confirmation challenge expired",
          retryable: false,
        },
      };
    }

    // ONLY the daemon's structured display reaches the native dialog.
    const gesture = await this.#showDialog(challenge.display);
    if (gesture !== "confirm") return { status: "cancelled" };

    const confirmedAt = new Date(this.#now()).toISOString();
    const receipt: ConfirmationReceipt = {
      challengeId: challenge.challengeId,
      proof: signConfirmation(challenge, confirmedAt, this.#token),
      confirmedAt,
    };

    // The receipt is dispatched by challenge kind; this slice implements
    // repository-trust only (RT-REPO-06).
    if (challenge.kind !== "repository-trust") {
      return {
        status: "rejected",
        error: {
          code: "InvalidRequest",
          message: `unsupported confirmation kind in this slice: ${challenge.kind}`,
          retryable: false,
        },
      };
    }
    const context = this.#confirmContexts.get(challenge.challengeId);
    this.#confirmContexts.delete(challenge.challengeId);
    if (context === undefined) {
      return {
        status: "rejected",
        error: {
          code: "InvalidRequest",
          message:
            "no confirm context for this challenge (issue the trust challenge via Main first)",
          retryable: false,
        },
      };
    }
    const confirmed = await this.#send(
      "ConfirmRepositoryTrust",
      { candidate: context.candidate, userIdentity: context.userIdentity },
      receipt,
    );
    if (!confirmed.ok) return { status: "rejected", error: confirmed.error };
    return { status: "confirmed", result: confirmed.result };
  }
}

export interface TrustIpcOptions {
  readonly context: TrustedSenderContext;
  readonly sender: TrustCommandSender;
  readonly token: Uint8Array;
  /** Test seam; production uses the Electron-native dialog. */
  readonly showDialog?: (display: ChallengeDisplay) => Promise<"confirm" | "cancel">;
  readonly now?: () => number;
}

/** SV1-ELECTRON-06 — command-named channels only; registered through
 *  handleTrustedIpc so sender/frame/origin validation cannot be skipped. */
export const registerTrustIpc = (opts: TrustIpcOptions): TrustIpcCore => {
  const core = new TrustIpcCore({
    sender: opts.sender,
    token: opts.token,
    showDialog: opts.showDialog ?? showNativeConfirmation,
    now: opts.now,
  });
  handleTrustedIpc("af:prepare-trust-candidate", opts.context, (path) =>
    core.prepareTrustCandidate(path),
  );
  handleTrustedIpc("af:issue-trust-challenge", opts.context, (request) =>
    core.issueTrustChallenge(request),
  );
  handleTrustedIpc("af:request-confirmation", opts.context, (challengeId) =>
    core.requestConfirmation(challengeId),
  );
  handleTrustedIpc("af:validate-and-activate-trust", opts.context, (trustId) =>
    core.validateAndActivateTrust(trustId),
  );
  handleTrustedIpc("af:revoke-trust", opts.context, (trustId, choice) =>
    core.revokeTrust(trustId, choice),
  );
  handleTrustedIpc("af:inspect-repository", opts.context, (workspaceId) =>
    core.inspectRepository(workspaceId),
  );
  return core;
};
