// R1-02 — production command routing for the Repository Trust chain
// (RT-REPO-01..06), plus the GetConfirmationChallenge read Main uses to fetch
// a challenge's fixed display fields (SV1-AUTH-10).
//
// The Control Dispatcher hands any envelope whose payload.kind is one of
// TRUST_COMMAND_KINDS to this router; every other kind stays on the
// not-implemented stub. The router does ONLY wire-shape validation
// (discriminant + required primitive fields); payload size/shape limits and
// all domain semantics stay in TrustService's existing guards.
//
// RT-STATE-27 — when the database opened read-only-recovery the router is
// constructed with `recoveryReason` set: every state-changing command fails
// closed to RecoveryRequired, while the bounded read-only queries
// (GetConfirmationChallenge, InspectRepositoryTrust) stay available whenever
// a readable handle exists. With no readable handle at all, everything
// returns RecoveryRequired.

import type {
  CommandEnvelope,
  CommandKind,
  ConfirmationReceipt,
  ErrorCode,
  RepositoryCandidatePayload,
} from "@agents-fleet/contracts";
import type { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import type { TrustService } from "./trust-service.js";

/** A routing-layer rejection with a stable RT-ERR-02 code. */
export class CommandError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export const TRUST_COMMAND_KINDS: readonly CommandKind[] = [
  "PrepareTrustCandidate",
  "IssueRepositoryTrustChallenge",
  "ConfirmRepositoryTrust",
  "ValidateAndActivateTrust",
  "RevokeRepositoryTrust",
  "InspectRepositoryTrust",
  "GetConfirmationChallenge",
];

// RT-STATE-27 — everything that writes (idempotency records, trust rows,
// challenge consume marks) is barred in read-only-recovery. The two
// read-only queries stay: GetConfirmationChallenge is a pure row read and
// InspectRepositoryTrust runs only the declared read-only Git queries
// (SV1-FILE-06); its drift-revoke write simply fails on a read-only handle,
// which is itself a fail-closed outcome.
const MUTATING_KINDS: ReadonlySet<CommandKind> = new Set([
  "PrepareTrustCandidate",
  "IssueRepositoryTrustChallenge",
  "ConfirmRepositoryTrust",
  "ValidateAndActivateTrust",
  "RevokeRepositoryTrust",
]);

export interface TrustCommandRouterOptions {
  readonly service: TrustService | null;
  readonly challenges: PersistentChallengeIssuer | null;
  /** RT-STATE-27 — set when openDatabase returned read-only-recovery. */
  readonly recoveryReason?: string | undefined;
}

const asRecord = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CommandError("InvalidRequest", `${what} must be an object`);
  }
  return v as Record<string, unknown>;
};

const reqString = (r: Record<string, unknown>, key: string): string => {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new CommandError("InvalidRequest", `payload.${key} must be a non-empty string`);
  }
  return v;
};

const reqCandidate = (v: unknown): RepositoryCandidatePayload => {
  const r = asRecord(v, "payload.candidate");
  const canonicalRoot = reqString(r, "canonicalRoot");
  const identity = asRecord(r.filesystemIdentity, "payload.candidate.filesystemIdentity");
  const { dev, ino } = identity;
  if (typeof dev !== "number" || typeof ino !== "number") {
    throw new CommandError(
      "InvalidRequest",
      "payload.candidate.filesystemIdentity.dev/.ino must be numbers",
    );
  }
  return { canonicalRoot, filesystemIdentity: { dev, ino } };
};

const reqReceipt = (v: unknown): ConfirmationReceipt => {
  // RT-CMD-06/16 shape — a command that requires confirmation and arrives
  // without a usable receipt fails closed to ConfirmationRequired.
  if (v === undefined || v === null) {
    throw new CommandError(
      "ConfirmationRequired",
      "ConfirmRepositoryTrust requires envelope.repositoryTrustReceipt",
    );
  }
  const r = asRecord(v, "repositoryTrustReceipt");
  return {
    challengeId: reqString(r, "challengeId"),
    proof: reqString(r, "proof"),
    confirmedAt: reqString(r, "confirmedAt"),
  };
};

export class TrustCommandRouter {
  readonly #service: TrustService | null;
  readonly #challenges: PersistentChallengeIssuer | null;
  readonly #recoveryReason: string | undefined;

  constructor(options: TrustCommandRouterOptions) {
    this.#service = options.service;
    this.#challenges = options.challenges;
    this.#recoveryReason = options.recoveryReason;
  }

  handles(kind: string): boolean {
    return (TRUST_COMMAND_KINDS as readonly string[]).includes(kind);
  }

  #requireService(): TrustService {
    if (this.#service === null) {
      throw new CommandError(
        "RecoveryRequired",
        `daemon is in read-only recovery (${this.#recoveryReason ?? "no database"})`,
      );
    }
    return this.#service;
  }

  async execute(kind: CommandKind, env: CommandEnvelope): Promise<unknown> {
    if (this.#recoveryReason !== undefined && MUTATING_KINDS.has(kind)) {
      throw new CommandError(
        "RecoveryRequired",
        `daemon is in read-only recovery: ${this.#recoveryReason}`,
      );
    }
    const commandId = env.commandId;
    switch (kind) {
      case "PrepareTrustCandidate": {
        const p = asRecord(env.payload, "payload");
        return await this.#requireService().prepareCandidate(commandId, reqString(p, "path"));
      }
      case "IssueRepositoryTrustChallenge": {
        const p = asRecord(env.payload, "payload");
        return this.#requireService().issueTrustChallenge(commandId, {
          candidate: reqCandidate(p.candidate),
          userIdentity: reqString(p, "userIdentity"),
          plannedAgent: reqString(p, "plannedAgent"),
          dataLocation: reqString(p, "dataLocation"),
          hostPermissionUpperBound: reqString(p, "hostPermissionUpperBound"),
        });
      }
      case "ConfirmRepositoryTrust": {
        const p = asRecord(env.payload, "payload");
        return await this.#requireService().confirmTrust(
          commandId,
          reqCandidate(p.candidate),
          reqReceipt(env.repositoryTrustReceipt),
          reqString(p, "userIdentity"),
        );
      }
      case "ValidateAndActivateTrust": {
        const p = asRecord(env.payload, "payload");
        return await this.#requireService().validateAndActivate(commandId, reqString(p, "trustId"));
      }
      case "RevokeRepositoryTrust": {
        const p = asRecord(env.payload, "payload");
        const choice = p.runningProcessChoice;
        if (choice !== undefined && choice !== "stop" && choice !== "keep") {
          throw new CommandError(
            "InvalidRequest",
            "payload.runningProcessChoice must be 'stop' or 'keep'",
          );
        }
        return this.#requireService().revokeTrust(commandId, reqString(p, "trustId"), choice);
      }
      case "InspectRepositoryTrust": {
        const p = asRecord(env.payload, "payload");
        return await this.#requireService().inspectRepository(reqString(p, "workspaceId"));
      }
      case "GetConfirmationChallenge": {
        const p = asRecord(env.payload, "payload");
        const challengeId = reqString(p, "challengeId");
        if (this.#challenges === null) {
          throw new CommandError(
            "RecoveryRequired",
            `daemon is in read-only recovery (${this.#recoveryReason ?? "no database"})`,
          );
        }
        const challenge = this.#challenges.getChallenge(challengeId);
        if (challenge === undefined) {
          throw new CommandError("NotFound", `unknown confirmation challenge: ${challengeId}`);
        }
        return challenge;
      }
      default:
        throw new CommandError("InvalidRequest", `unroutable command kind: ${kind as string}`);
    }
  }
}
