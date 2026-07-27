// R1-02 — production-chain e2e over a REAL Unix socket, REAL SQLite
// (openDatabase + ALL_MIGRATIONS) and a REAL temporary git repository:
//
//   PrepareTrustCandidate → IssueRepositoryTrustChallenge →
//   GetConfirmationChallenge → (Main seam) signConfirmation →
//   ConfirmRepositoryTrust(receipt) → ValidateAndActivateTrust →
//   InspectRepositoryTrust → RevokeRepositoryTrust → Inspect ⇒ Conflict
//
// Security properties proven on the wire:
// - no Git runs before the first confirmation (SV1-TRUST-04): every GitExec
//   call is recorded and must be empty until ValidateAndActivateTrust;
// - a forged receipt (attacker token) fails closed to ConfirmationRequired
//   and does NOT burn the challenge (RT-CMD-16 consume rollback);
// - a replayed receipt fails already-consumed → ConfirmationRequired;
// - after revoke, inspection reports Conflict (RT-REPO-05).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClientHello,
  CommandEnvelope,
  ConfirmationChallenge,
  DaemonChallenge,
  DaemonHello,
  Nonce,
  RepositoryCandidatePayload,
} from "@agents-fleet/contracts";
import { PLATFORM_MATRIX_VERSION, RUNTIME_LIMIT_PROFILE_VERSION } from "@agents-fleet/contracts";
import {
  buildProofTranscript,
  computeProof,
  NdjsonDecoder,
  signConfirmation,
  verifyProof,
} from "@agents-fleet/transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeychainCapabilityProofVerifier } from "../auth/keychain-capability-proof-verifier.js";
import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import {
  defaultGitExec,
  type GitExec,
  type GitExecRequest,
  RestrictedGitRunner,
} from "../git/restricted-git.js";
import { TrustCommandRouter } from "../repository-trust/trust-command-router.js";
import { TrustService } from "../repository-trust/trust-service.js";
import { type StartedServer, startServer } from "../server.js";
import { openDatabase } from "../storage/database.js";
import { IdempotencyStore } from "../storage/idempotency.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";

const TOKEN = new TextEncoder().encode("r1-02-e2e-capability-token");
const ATTACKER_TOKEN = new TextEncoder().encode("attacker-without-keychain");
const GIT = "/usr/bin/git";
const USER = "uid:501";

const config = {
  supportedProtocolVersions: [1],
  daemonId: "d" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: PLATFORM_MATRIX_VERSION,
  runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
};

// --- fixtures ---------------------------------------------------------------

const IDENTITY = ["-c", "user.name=r1-02-e2e", "-c", "user.email=r1-02-e2e@example.invalid"];
const git = (args: readonly string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();

let workDir: string;
let repoRoot: string;
let server: StartedServer;
let gitCalls: GitExecRequest[];

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "af-r102-e2e-")));
  repoRoot = join(workDir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "--initial-branch=main"], repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "r1-02 e2e fixture\n");
  git([...IDENTITY, "add", "README.md"], repoRoot);
  git([...IDENTITY, "commit", "-m", "init"], repoRoot);

  const opened = openDatabase({ path: join(workDir, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(`db not ready: ${opened.reason}`);
  const db = opened.db;
  gitCalls = [];
  const recording: GitExec = async (req) => {
    gitCalls.push({ argv: [...req.argv], cwd: req.cwd, env: { ...req.env } });
    return await defaultGitExec(req);
  };
  const idem = new IdempotencyStore(db);
  const challenges = new PersistentChallengeIssuer({ db, token: TOKEN });
  const runner = new RestrictedGitRunner({ exec: recording });
  const service = new TrustService({ db, challenges, idem, runner });
  const router = new TrustCommandRouter({ service, challenges });

  server = await startServer({
    socketDir: join(workDir, "run"),
    config,
    verifier: new KeychainCapabilityProofVerifier(TOKEN),
    token: TOKEN,
    router,
  });
});

afterAll(async () => {
  await server?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// --- client -----------------------------------------------------------------

const readOne = (sock: Socket, dec: NdjsonDecoder, timeoutMs = 5000): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
    const onData = (chunk: Buffer): void => {
      dec.feed(chunk);
      const objs = dec.drain();
      if (objs.length > 0) {
        clearTimeout(timer);
        sock.off("data", onData);
        resolve(objs[0]);
      }
    };
    sock.on("data", onData);
  });

interface Session {
  readonly sock: Socket;
  readonly dec: NdjsonDecoder;
  send: (
    kind: string,
    fields: Record<string, unknown>,
    over?: Record<string, unknown>,
  ) => Promise<unknown>;
}

const connectSession = async (): Promise<Session> => {
  const sock: Socket = connect(server.socketPath);
  await new Promise<void>((resolve) => sock.on("connect", () => resolve()));
  const dec = new NdjsonDecoder();
  const clientNonce = randomUUID() as Nonce;
  const hello: ClientHello = {
    protocolVersions: [1],
    expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
    expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
    clientInstanceId: "e2e",
    clientKind: "electron-main",
    clientNonce,
  };
  sock.write(`${JSON.stringify(hello)}\n`);
  const challenge = (await readOne(sock, dec)) as DaemonChallenge;
  const transcript = buildProofTranscript(hello, challenge);
  expect(verifyProof("daemon", transcript, TOKEN, challenge.daemonProof)).toBe(true);
  sock.write(`${JSON.stringify({ clientProof: computeProof("client", transcript, TOKEN) })}\n`);
  const helloBack = (await readOne(sock, dec)) as DaemonHello;
  expect(helloBack.daemonGeneration).toBe(1);

  return {
    sock,
    dec,
    send: async (kind, fields, over = {}) => {
      const env = {
        commandId: randomUUID(),
        schemaVersion: 1,
        payload: { kind, ...fields },
        ...over,
      } as unknown as CommandEnvelope;
      sock.write(`${JSON.stringify(env)}\n`);
      return await readOne(sock, dec);
    },
  };
};

const resultOf = (m: unknown): unknown => (m as { result?: unknown }).result;
const errorOf = (m: unknown): { code: string; retryable: boolean } | undefined =>
  (m as { error?: { code: string; retryable: boolean } }).error;

describe("repository trust production chain e2e (R1-02)", () => {
  it("candidate → challenge → native confirm → validate/activate → inspect → revoke", async () => {
    const s = await connectSession();
    try {
      // RT-REPO-01 — candidate; pre-Trust this cannot spawn Git (SV1-TRUST-04).
      const prepared = resultOf(await s.send("PrepareTrustCandidate", { path: repoRoot }));
      const candidate = prepared as RepositoryCandidatePayload;
      expect(candidate.canonicalRoot).toBe(repoRoot);
      expect(gitCalls).toHaveLength(0);

      // RT-REPO-06 — the one-time challenge; still no Git, no trust row.
      const challenge = resultOf(
        await s.send("IssueRepositoryTrustChallenge", {
          candidate,
          userIdentity: USER,
          plannedAgent: "claude",
          dataLocation: "~/.agents-fleet/data",
          hostPermissionUpperBound: "Balanced",
        }),
      ) as ConfirmationChallenge;
      expect(challenge.kind).toBe("repository-trust");
      expect(challenge.display.title).toBe("Grant Repository Trust");
      expect(gitCalls).toHaveLength(0);

      // SV1-AUTH-10 — Main fetches the challenge to render its fixed display.
      const fetched = resultOf(
        await s.send("GetConfirmationChallenge", { challengeId: challenge.challengeId }),
      ) as ConfirmationChallenge;
      expect(fetched.display).toEqual(challenge.display);

      // Forgery: a receipt minted without the capability token fails closed,
      // and the failed consume must NOT burn the challenge (RT-CMD-16).
      const forgedAt = new Date().toISOString();
      const forged = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(challenge, forgedAt, ATTACKER_TOKEN),
        confirmedAt: forgedAt,
      };
      const forgedResp = await s.send(
        "ConfirmRepositoryTrust",
        { candidate, userIdentity: USER },
        { repositoryTrustReceipt: forged },
      );
      expect(errorOf(forgedResp)?.code).toBe("ConfirmationRequired");
      expect(errorOf(forgedResp)?.retryable).toBe(false);
      expect(gitCalls).toHaveLength(0);

      // (Main seam) the same challenge, genuinely confirmed and signed with
      // the real capability token (SV1-TRUST-09), enters PendingValidation.
      const confirmedAt = new Date().toISOString();
      const receipt = {
        challengeId: challenge.challengeId,
        proof: signConfirmation(challenge, confirmedAt, TOKEN),
        confirmedAt,
      };
      const confirmed = resultOf(
        await s.send(
          "ConfirmRepositoryTrust",
          { candidate, userIdentity: USER },
          { repositoryTrustReceipt: receipt },
        ),
      ) as { trustId: string; state: string };
      expect(confirmed.state).toBe("PendingValidation");
      expect(gitCalls).toHaveLength(0); // confirmation alone still runs no Git

      // Receipt replay (new commandId, same receipt) → already-consumed.
      const replayed = await s.send(
        "ConfirmRepositoryTrust",
        { candidate, userIdentity: USER },
        { repositoryTrustReceipt: receipt },
      );
      expect(errorOf(replayed)?.code).toBe("ConfirmationRequired");

      // RT-REPO-02/03 — the FIRST Git in the whole chain: the restricted plan.
      const outcome = resultOf(
        await s.send("ValidateAndActivateTrust", { trustId: confirmed.trustId }),
      ) as {
        trust: { state: string };
        workspace: { workspaceId: string } | null;
        failure: unknown;
      };
      expect(outcome.failure).toBeNull();
      expect(outcome.trust.state).toBe("Active");
      expect(outcome.workspace).not.toBeNull();
      expect(gitCalls.length).toBeGreaterThan(0);
      const workspaceId = outcome.workspace?.workspaceId;
      if (workspaceId === undefined) throw new Error("expected a workspace on Active");

      // RT-REPO-04 — Active-only declared read-only inspection.
      const inspection = resultOf(await s.send("InspectRepositoryTrust", { workspaceId })) as {
        headCommitSha: string;
        currentBranch: string;
      };
      expect(inspection.currentBranch).toBe("main");

      // RT-REPO-05 — revoke is terminal; inspection then reports Conflict.
      const revoked = resultOf(
        await s.send("RevokeRepositoryTrust", { trustId: confirmed.trustId }),
      ) as { trust: { state: string } };
      expect(revoked.trust.state).toBe("Revoked");
      const afterRevoke = await s.send("InspectRepositoryTrust", { workspaceId });
      expect(errorOf(afterRevoke)?.code).toBe("Conflict");
    } finally {
      s.sock.destroy();
    }
  });

  it("unrouted kinds stay not-implemented; malformed envelopes are InvalidRequest", async () => {
    const s = await connectSession();
    try {
      const stub = await s.send("Attach", {});
      expect(errorOf(stub)?.code).toBe("InternalFailure");

      s.sock.write(`${JSON.stringify({ schemaVersion: 1, payload: { kind: "Attach" } })}\n`);
      const malformed = await readOne(s.sock, s.dec);
      expect(errorOf(malformed)?.code).toBe("InvalidRequest");
    } finally {
      s.sock.destroy();
    }
  });
});
