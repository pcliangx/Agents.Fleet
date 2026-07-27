// R1-07 — authenticated Control Dispatcher command surface.
//
// The observable seam is CommandEnvelope -> public result/error after the
// handshake. SQLite and SessionRuntime are real; only the PTY process boundary
// is replaced, and this first routing slice never reaches it.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ClientAuth,
  ClientHello,
  CommandEnvelope,
  LaunchCommandPayload,
  WorktreeManager,
} from "@agents-fleet/contracts";
import {
  COMMAND_KINDS,
  PLATFORM_MATRIX_VERSION,
  RUNTIME_LIMIT_PROFILE_VERSION,
} from "@agents-fleet/contracts";
import { FakeAdapter } from "@agents-fleet/testing";
import type { DaemonHandshakeConfig } from "@agents-fleet/transport";
import { signConfirmation } from "@agents-fleet/transport";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../agent-adapters/claude-code-adapter.js";
import { DevProofVerifier } from "../auth/dev-proof-verifier.js";
import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { type ConnectionSink, ControlDispatcher } from "../control-dispatcher.js";
import { defaultGitExec, RestrictedGitRunner } from "../git/restricted-git.js";
import {
  type ExecutableRunner,
  HostEnvironmentError,
  LocalHostEnvironment,
} from "../host-environment/host-environment.js";
import {
  copyNodePtyWithHelperMode,
  type TempNodePtyCopy,
} from "../native-artifact/temp-node-pty-copy.js";
import { TrustCommandRouter } from "../repository-trust/trust-command-router.js";
import { TrustService } from "../repository-trust/trust-service.js";
import { RuntimeCommandRouter } from "../runtime-command-router.js";
import {
  createProcessSupervisor,
  type ProcessSupervisor,
  type PtyDriver,
  type PtyDriverProcess,
} from "../session-runtime/process-supervisor.js";
import { SessionRuntime } from "../session-runtime/session-runtime.js";
import { AgentProfileStore } from "../storage/agent-profile-store.js";
import { openDatabase } from "../storage/database.js";
import { EnvironmentSnapshotStore } from "../storage/environment-snapshot-store.js";
import { IdempotencyStore } from "../storage/idempotency.js";
import { ALL_MIGRATIONS } from "../storage/migrations.js";
import { RepositoryTrustStore } from "../storage/repository-trust-store.js";
import { TaskStore } from "../storage/task-store.js";
import { WorktreeStore } from "../storage/worktree-store.js";
import { LaunchCommandCoordinator } from "../task-orchestrator/launch-command-coordinator.js";
import { TaskOrchestrator } from "../task-orchestrator/task-orchestrator.js";
import { WorktreeManagerImpl } from "../worktree-manager/worktree-manager.js";

const TOKEN = new TextEncoder().encode("r1-07-command-surface");
const config: DaemonHandshakeConfig = {
  supportedProtocolVersions: [1],
  daemonId: "daemon-r1-07" as never,
  daemonGeneration: 1 as never,
  platformMatrixVersion: PLATFORM_MATRIX_VERSION,
  runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
};

class CapturingSink implements ConnectionSink {
  readonly sent: unknown[] = [];
  send(message: unknown): void {
    this.sent.push(message);
  }
  close(): void {}
}

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const runtimes: { readonly db: DatabaseSync; readonly runtime: SessionRuntime }[] = [];
const nativeCopies: TempNodePtyCopy[] = [];

afterEach(async () => {
  for (const { db, runtime } of runtimes.splice(0)) {
    const sessions = db
      .prepare("SELECT session_id FROM sessions WHERE availability = 'Alive'")
      .all() as { readonly session_id: string }[];
    await Promise.all(sessions.map(async ({ session_id }) => await runtime.terminate(session_id)));
  }
  for (const db of databases.splice(0)) db.close();
  for (const copy of nativeCopies.splice(0)) await copy.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface LaunchFixture {
  readonly taskId: string;
  readonly profileId: string;
  readonly workspaceId: string;
  readonly headSha: string;
  readonly repositoryRoot: string;
  readonly managedWorktreeRoot: string;
}

const wire = async (
  options: {
    readonly launch?: boolean;
    readonly resumeCapability?: boolean;
    readonly autoLaunch?: boolean;
    readonly gitUnavailableOnCommitVerification?: boolean;
    readonly launchProbeFailure?: boolean;
    readonly launchModel?: string;
  } = {},
): Promise<{
  readonly dispatcher: ControlDispatcher;
  readonly sink: CapturingSink;
  readonly db: DatabaseSync;
  readonly root: string;
  readonly tasks: TaskStore;
  readonly worktreeStore: WorktreeStore;
  readonly observedWorktreeIds: readonly string[];
  readonly worktreeInspectionControl: { fail: boolean };
  readonly launch: LaunchFixture | null;
  readonly sessions: SessionRuntime;
}> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "af-r107-command-")));
  roots.push(root);
  const opened = openDatabase({ path: join(root, "fleet.db"), migrations: ALL_MIGRATIONS });
  if (opened.kind !== "ready") throw new Error(opened.reason);
  databases.push(opened.db);

  let processSupervisor: ProcessSupervisor;
  if (options.autoLaunch === true) {
    const copy = await copyNodePtyWithHelperMode(0o755);
    nativeCopies.push(copy);
    const driver: PtyDriver = {
      spawn(executablePath, args, spawnOptions): PtyDriverProcess {
        const process = copy.nodePty.spawn(executablePath, [...args], {
          ...spawnOptions,
          env: { ...spawnOptions.env },
        });
        return {
          pid: process.pid,
          write: (data) => process.write(Buffer.from(data)),
          resize: (cols, rows) => process.resize(cols, rows),
          kill: () => process.kill(),
          onData: (listener) => {
            const subscription = process.onData((data) => listener(data as Uint8Array));
            return { dispose: () => subscription.dispose() };
          },
          onExit: (listener) =>
            process.onExit((event) =>
              listener({ exitCode: event.exitCode, signal: event.signal ?? 0 }),
            ),
        };
      },
    };
    processSupervisor = createProcessSupervisor(driver);
  } else {
    processSupervisor = {
      spawn() {
        throw new Error("this routing fixture must not spawn a process");
      },
    };
  }
  const challenges = new PersistentChallengeIssuer({ db: opened.db, token: TOKEN });
  const restrictedGit = new RestrictedGitRunner({
    exec: async (request) => {
      if (
        options.gitUnavailableOnCommitVerification === true &&
        request.argv.some((argument) => /^[0-9a-f]{40,64}\^\{commit\}$/.test(argument))
      ) {
        throw Object.assign(new Error("restricted Git executable is unavailable"), {
          code: "ENOENT",
        });
      }
      return await defaultGitExec(request);
    },
  });
  const sessions = new SessionRuntime({
    db: opened.db,
    storeDir: join(root, "runtime"),
    processSupervisor,
    confirmations: challenges,
  });
  runtimes.push({ db: opened.db, runtime: sessions });
  const worktreeStore = new WorktreeStore(opened.db);
  const worktreeManager = new WorktreeManagerImpl({
    db: opened.db,
    store: worktreeStore,
    idempotency: new IdempotencyStore(opened.db),
  });
  const observedWorktreeIds: string[] = [];
  const worktreeInspectionControl = { fail: false };
  const worktrees: WorktreeManager = {
    provision: async (input) => await worktreeManager.provision(input),
    inspect: async (input) => {
      observedWorktreeIds.push(input.worktreeId);
      if (worktreeInspectionControl.fail) {
        return {
          ok: false,
          failure: {
            kind: "GitFailure",
            detail: "injected Worktree Git observation failure",
          },
        };
      }
      return await worktreeManager.inspect(input);
    },
    previewDispose: async (input) => await worktreeManager.previewDispose(input),
    dispose: async (input) => await worktreeManager.dispose(input),
  };
  const tasks = new TaskStore(opened.db);
  let launchCoordinator: LaunchCommandCoordinator | undefined;
  const taskOrchestrator = new TaskOrchestrator({
    db: opened.db,
    sessions,
    prepareLaunch: async (attempt) => {
      if (launchCoordinator === undefined) {
        throw new Error("stop command fixture must not schedule a launch");
      }
      return launchCoordinator.prepareScheduledLaunch(attempt);
    },
  });
  let launch: LaunchFixture | null = null;
  if (options.launch === true) {
    const repositoryRoot = join(root, "repository");
    mkdirSync(repositoryRoot);
    const git = (args: readonly string[]): string =>
      execFileSync("/usr/bin/git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
    git(["init", "--initial-branch=main"]);
    writeFileSync(join(repositoryRoot, "README.md"), "launch fixture\n");
    git(["-c", "user.name=r1-07", "-c", "user.email=r1-07@example.invalid", "add", "."]);
    git([
      "-c",
      "user.name=r1-07",
      "-c",
      "user.email=r1-07@example.invalid",
      "commit",
      "-m",
      "init",
    ]);
    const headSha = git(["rev-parse", "HEAD"]);
    const commonGitDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const repositoryIdentity = statSync(repositoryRoot);
    const commonGitIdentity = statSync(commonGitDir);
    const now = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO repository_trusts
         (trust_id, trust_version, state, candidate_canonical_root, fs_dev, fs_ino,
          user_identity, challenge_id, created_at, updated_at)
         VALUES ('trust-launch', 1, 'Active', ?, ?, ?, 'uid:501',
                 'challenge-trust', ?, ?)`,
      )
      .run(repositoryRoot, repositoryIdentity.dev, repositoryIdentity.ino, now, now);
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (workspace_id, trust_id, canonical_root, common_git_dir, common_git_dev,
          common_git_ino, head_commit_sha, current_branch, default_base_ref,
          default_base_ref_sha, git_version, defaults_json, observed_at, created_at)
         VALUES ('workspace-launch', 'trust-launch', ?, ?, ?, ?, ?, 'main',
                 'refs/heads/main', ?, '2.50.1', '{}', ?, ?)`,
      )
      .run(
        repositoryRoot,
        commonGitDir,
        commonGitIdentity.dev,
        commonGitIdentity.ino,
        headSha,
        headSha,
        now,
        now,
      );
    const task = tasks.createTask({
      workspaceId: "workspace-launch",
      spec: { goal: "implement launch commands" },
    });
    const profiles = new AgentProfileStore(opened.db);
    const runner: ExecutableRunner = {
      async run() {
        if (options.launchProbeFailure === true) {
          throw new HostEnvironmentError("CapabilityUnavailable", "executable probe unavailable");
        }
        return { stdout: "2.1.218 (Claude Code)\n", stderr: "" };
      },
    };
    const appDataRoot = join(root, "app-data");
    const executableRoot = join(root, "bin");
    mkdirSync(executableRoot);
    const executablePath = join(executableRoot, "claude");
    writeFileSync(executablePath, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(executablePath, 0o755);
    const hostEnvironment = new LocalHostEnvironment({
      appDataRoot,
      explicitPathEntries: ["/usr/bin", "/bin"],
      inheritedEnvironment: {},
      runner,
    });
    const adapter =
      options.resumeCapability === false
        ? new FakeAdapter({
            agentId: "fake",
            capabilities: ["Discovery", "PermissionMapping"],
          })
        : new ClaudeCodeAdapter({
            candidateExecutablePath: executablePath,
            hostEnvironment,
          });
    const profile = profiles.createProfile({
      agentId: adapter.agentId,
      ...(options.launchModel === undefined ? {} : { model: options.launchModel }),
      permissionMode: "Balanced",
      secretRefs: [],
    });
    const managedWorktreeRoot = join(root, "managed-worktrees");
    launchCoordinator = new LaunchCommandCoordinator({
      db: opened.db,
      idempotency: new IdempotencyStore(opened.db),
      challenges,
      profiles,
      environments: new EnvironmentSnapshotStore(opened.db),
      trustStore: new RepositoryTrustStore(opened.db),
      worktreeStore,
      worktrees,
      git: restrictedGit,
      hostEnvironment,
      adapterFor: () => adapter,
      managedWorktreeRoot,
    });
    launch = {
      taskId: task.taskId,
      profileId: profile.profileId,
      workspaceId: "workspace-launch",
      headSha,
      repositoryRoot,
      managedWorktreeRoot,
    };
  }
  const router = new RuntimeCommandRouter({
    db: opened.db,
    idempotency: new IdempotencyStore(opened.db),
    challenges,
    taskOrchestrator,
    ...(launchCoordinator === undefined ? {} : { launches: launchCoordinator }),
    ...(options.autoLaunch === undefined ? {} : { autoLaunch: options.autoLaunch }),
    sessions,
    worktrees,
    fallback: new TrustCommandRouter({
      service: new TrustService({
        db: opened.db,
        challenges,
        idem: new IdempotencyStore(opened.db),
        runner: restrictedGit,
      }),
      challenges,
    }),
  });
  const sink = new CapturingSink();
  const dispatcher = new ControlDispatcher(config, new DevProofVerifier(), sink, TOKEN, router);
  const hello: ClientHello = {
    protocolVersions: [1],
    expectedPlatformMatrixVersion: PLATFORM_MATRIX_VERSION,
    expectedRuntimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
    clientInstanceId: "main-r1-07",
    clientKind: "electron-main",
    clientNonce: "nonce-r1-07" as never,
  };
  await dispatcher.onMessage(hello);
  await dispatcher.onMessage({ clientProof: "dev-proof" } as ClientAuth);
  return {
    dispatcher,
    sink,
    db: opened.db,
    root,
    tasks,
    worktreeStore,
    observedWorktreeIds,
    worktreeInspectionControl,
    launch,
    sessions,
  };
};

const envelope = (
  kind: string,
  fields: Record<string, unknown> = {},
  identities: Record<string, unknown> = {},
): CommandEnvelope =>
  ({
    commandId: `cmd-${kind}`,
    schemaVersion: 1,
    payload: { kind, ...fields },
    ...identities,
  }) as unknown as CommandEnvelope;

const last = (sink: CapturingSink): unknown => sink.sent[sink.sent.length - 1];
const errorCode = (message: unknown): string | undefined =>
  (message as { readonly error?: { readonly code?: string } }).error?.code;
const resultOf = (message: unknown): unknown => (message as { readonly result?: unknown }).result;

const required = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const sign = (challenge: {
  readonly challengeId: string;
  readonly kind: "repository-trust" | "launch" | "side-effect";
  readonly display: {
    readonly title: string;
    readonly fields: readonly { readonly label: string; readonly value: string }[];
  };
  readonly payloadHash: string;
  readonly bindingHashes: readonly string[];
  readonly impactSummaryHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}) => {
  const confirmedAt = new Date().toISOString();
  return {
    challengeId: challenge.challengeId,
    confirmedAt,
    proof: signConfirmation(challenge as never, confirmedAt, TOKEN),
  };
};

const displayFields = (challenge: Parameters<typeof sign>[0]): ReadonlyMap<string, string> =>
  new Map(challenge.display.fields.map((field) => [field.label, field.value]));

const seedRunningAttempt = (db: DatabaseSync, root: string): void => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks
     (task_id, workspace_id, lifecycle, spec_json, task_spec_version,
      state_version, created_at, updated_at)
     VALUES ('task-1', 'workspace-1', 'Runnable', '{"goal":"test"}', 1, 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO attempts
     (attempt_id, task_id, status, spec_snapshot_json, task_spec_version,
      created_seq, state_version, created_at)
     VALUES ('attempt-1', 'task-1', 'Running', '{"goal":"test"}', 1, 1, 1, ?)`,
  ).run(now);
  for (const sessionId of ["session-1", "session-2"]) {
    db.prepare(
      `INSERT INTO sessions
       (session_id, attempt_id, availability, role, completion_policy,
        generation, created_at, updated_at)
       VALUES (?, 'attempt-1', 'Alive', 'Shell', 'BlocksAttemptCompletion', 1, ?, ?)`,
    ).run(sessionId, now, now);
  }
  writeFileSync(join(root, "untracked.txt"), "must survive stop\n");
};

const issueLaunch = async (
  fixture: Awaited<ReturnType<typeof wire>>,
  commandType: "Start" | "Retry" | "Resume",
  targetCommandId: string,
  command: LaunchCommandPayload,
  identities: Record<string, unknown>,
): Promise<{
  readonly challenge: Parameters<typeof sign>[0];
  readonly command: LaunchCommandPayload;
}> => {
  await fixture.dispatcher.onMessage(
    envelope(
      "IssueLaunchConfirmationChallenge",
      { commandType, targetCommandId, command },
      identities,
    ),
  );
  return resultOf(last(fixture.sink)) as {
    readonly challenge: Parameters<typeof sign>[0];
    readonly command: LaunchCommandPayload;
  };
};

const executeLaunch = async (
  fixture: Awaited<ReturnType<typeof wire>>,
  commandType: "Start" | "Retry" | "Resume",
  commandId: string,
  issued: {
    readonly challenge: Parameters<typeof sign>[0];
    readonly command: LaunchCommandPayload;
  },
  identities: Record<string, unknown>,
): Promise<unknown> => {
  await fixture.dispatcher.onMessage({
    ...envelope(commandType, issued.command as unknown as Record<string, unknown>, identities),
    commandId,
    launchConfirmationReceipt: sign(issued.challenge),
  } as CommandEnvelope);
  return resultOf(last(fixture.sink));
};

const seedResumableAttempt = (
  fixture: Awaited<ReturnType<typeof wire>>,
  status: "Interrupted" | "Uncertain" = "Uncertain",
): string => {
  const launch = required(fixture.launch, "launch fixture");
  const now = new Date().toISOString();
  fixture.db
    .prepare(
      `UPDATE tasks
       SET lifecycle = 'Runnable', state_version = state_version + 1, updated_at = ?
       WHERE task_id = ?`,
    )
    .run(now, launch.taskId);
  fixture.db
    .prepare(
      `INSERT INTO attempts
       (attempt_id, task_id, status, spec_snapshot_json, task_spec_version,
        created_seq, state_version, command_kind, created_at)
       VALUES ('attempt-resumable', ?, ?, '{"goal":"implement launch commands"}',
               1, 1, 1, 'Start', ?)`,
    )
    .run(launch.taskId, status, now);
  return "attempt-resumable";
};

describe("R1-07 Control Dispatcher command routing", () => {
  beforeAll(() => {
    process.env.AGENTS_FLEET_DEV_AUTH = "1";
    process.env.NODE_ENV = "test";
  });

  it("recognizes every declared command kind and rejects unknown kinds as InvalidRequest", async () => {
    const { dispatcher, sink } = await wire();
    for (const kind of COMMAND_KINDS) {
      await dispatcher.onMessage(envelope(kind));
      expect(errorCode(last(sink)), kind).not.toBe("InternalFailure");
    }

    await dispatcher.onMessage(envelope("RendererInventedCommand"));
    expect(errorCode(last(sink))).toBe("InvalidRequest");
  });

  it("routes Attach through the production SessionRuntime seam", async () => {
    const { dispatcher, sink } = await wire();

    await dispatcher.onMessage(
      envelope("Attach", { sessionId: "session-missing", fromSeq: undefined }),
    );

    expect(last(sink)).toEqual({
      error: {
        code: "NotFound",
        message: "Session session-missing does not exist",
        retryable: false,
        commandId: "cmd-Attach",
      },
    });
  });

  it.each([
    [
      "AcquireControl",
      envelope("AcquireControl", {}, { attachmentId: "attachment-missing" }),
      "NotFound",
    ],
    [
      "WriteSessionInput",
      envelope(
        "WriteSessionInput",
        { bytes: new Uint8Array([1, 2, 3]), source: "Keyboard" },
        {
          sessionId: "session-missing",
          expectedGeneration: 1,
          attachmentId: "attachment-missing",
          fencingToken: 1,
        },
      ),
      "NotFound",
    ],
    [
      "ResizeSession",
      envelope(
        "ResizeSession",
        { cols: 100, rows: 40 },
        {
          sessionId: "session-missing",
          expectedGeneration: 1,
          attachmentId: "attachment-missing",
          fencingToken: 1,
        },
      ),
      "NotFound",
    ],
  ] as const)("routes %s through SessionRuntime", async (_kind, command, expectedCode) => {
    const { dispatcher, sink } = await wire();

    await dispatcher.onMessage(command);

    expect(errorCode(last(sink))).toBe(expectedCode);
  });

  it("routes DisposeWorktree through the production WorktreeManager seam", async () => {
    const { dispatcher, sink } = await wire();

    await dispatcher.onMessage(
      envelope(
        "DisposeWorktree",
        {
          worktreeId: "worktree-missing",
          expectedFilesystemIdentity: { dev: 1, ino: 2 },
          expectedStateFingerprint: "fingerprint",
          integrationTarget: { ref: "refs/heads/main", sha: "a".repeat(40) },
          branchDisposition: "preserve",
        },
        { expectedStateVersion: 1 },
      ),
    );

    expect(errorCode(last(sink))).toBe("NotFound");
  });

  it("routes the TerminateSession challenge and rejects execution without its receipt", async () => {
    const identities = {
      sessionId: "session-missing",
      expectedGeneration: 1,
      attachmentId: "attachment-missing",
      fencingToken: 1,
    };
    const { dispatcher, sink } = await wire();

    await dispatcher.onMessage(
      envelope(
        "IssueSideEffectConfirmationChallenge",
        { commandType: "TerminateSession", targetCommandId: "cmd-terminate" },
        identities,
      ),
    );
    expect(errorCode(last(sink))).toBe("NotFound");

    await dispatcher.onMessage({
      ...envelope("TerminateSession", {}, identities),
      commandId: "cmd-terminate",
    } as CommandEnvelope);
    expect(errorCode(last(sink))).toBe("ConfirmationRequired");
  });

  it("RequestAttemptStop is receipt-bound, idempotent, and never cleans Worktree files", async () => {
    const { dispatcher, sink, db, root, tasks } = await wire();
    seedRunningAttempt(db, root);

    await dispatcher.onMessage(
      envelope(
        "IssueSideEffectConfirmationChallenge",
        { commandType: "RequestAttemptStop", targetCommandId: "cmd-stop" },
        { attemptId: "attempt-1" },
      ),
    );
    const challenge = resultOf(last(sink)) as Parameters<typeof sign>[0];
    expect(challenge).toMatchObject({
      kind: "side-effect",
      commandType: "RequestAttemptStop",
      sideEffectClass: "destructive",
      targetIdentities: [
        { targetType: "Attempt", targetId: "attempt-1" },
        { targetType: "Session", targetId: "session-1", generation: 1 },
        { targetType: "Session", targetId: "session-2", generation: 1 },
      ],
      expectedStateVersions: [
        { targetType: "Task", targetId: "task-1", stateVersion: 1 },
        { targetType: "Attempt", targetId: "attempt-1", stateVersion: 1 },
      ],
      display: { title: "Stop Attempt" },
    });
    await dispatcher.onMessage(
      envelope("GetConfirmationChallenge", { challengeId: challenge.challengeId }),
    );
    expect(resultOf(last(sink))).toEqual(challenge);

    const command = {
      ...envelope(
        "RequestAttemptStop",
        {},
        {
          attemptId: "attempt-1",
          expectedStateVersion: 1,
        },
      ),
      commandId: "cmd-stop",
      confirmationReceipt: sign(challenge),
    } as CommandEnvelope;
    await dispatcher.onMessage(command);

    expect(resultOf(last(sink))).toMatchObject({
      attemptId: "attempt-1",
      attemptStatus: "Stopping",
      stopRequestedSessionIds: ["session-1", "session-2"],
      gitCleanup: false,
    });
    expect(tasks.listAttempts("task-1")[0]).toMatchObject({
      status: "Stopping",
      stateVersion: 2,
    });
    expect(existsSync(join(root, "untracked.txt"))).toBe(true);

    await dispatcher.onMessage({ ...command, confirmationReceipt: undefined } as CommandEnvelope);
    expect(resultOf(last(sink))).toMatchObject({
      attemptId: "attempt-1",
      attemptStatus: "Stopping",
    });
    expect(tasks.listAttempts("task-1")).toHaveLength(1);
  });

  it("a RequestAttemptStop receipt cannot authorize CancelTask", async () => {
    const { dispatcher, sink, db, root, tasks } = await wire();
    seedRunningAttempt(db, root);

    await dispatcher.onMessage(
      envelope(
        "IssueSideEffectConfirmationChallenge",
        { commandType: "RequestAttemptStop", targetCommandId: "cmd-stop" },
        { attemptId: "attempt-1" },
      ),
    );
    const challenge = resultOf(last(sink)) as Parameters<typeof sign>[0];

    await dispatcher.onMessage({
      ...envelope(
        "CancelTask",
        {},
        {
          taskId: "task-1",
          expectedStateVersion: 1,
        },
      ),
      commandId: "cmd-cancel",
      confirmationReceipt: sign(challenge),
    } as CommandEnvelope);

    expect(errorCode(last(sink))).toBe("ConfirmationRequired");
    expect(tasks.listTasks("workspace-1")[0]?.lifecycle).toBe("Runnable");
    expect(tasks.listAttempts("task-1")[0]?.status).toBe("Running");

    await dispatcher.onMessage({
      ...envelope(
        "RequestAttemptStop",
        {},
        {
          attemptId: "attempt-1",
          expectedStateVersion: 1,
        },
      ),
      commandId: "cmd-stop",
      confirmationReceipt: sign(challenge),
    } as CommandEnvelope);
    expect(errorCode(last(sink))).toBeUndefined();
  });

  it("CancelTask is reversible without an Attempt and destructive with a running Attempt", async () => {
    const draft = await wire();
    const now = new Date().toISOString();
    draft.db
      .prepare(
        `INSERT INTO tasks
         (task_id, workspace_id, lifecycle, spec_json, task_spec_version,
          state_version, created_at, updated_at)
         VALUES ('task-draft', 'workspace-1', 'Draft', '{"goal":"test"}', 1, 1, ?, ?)`,
      )
      .run(now, now);

    await draft.dispatcher.onMessage(
      envelope("CancelTask", {}, { taskId: "task-draft", expectedStateVersion: 1 }),
    );
    expect(resultOf(last(draft.sink))).toMatchObject({
      taskId: "task-draft",
      taskLifecycle: "Cancelled",
      attemptId: null,
      stopRequestedSessionIds: [],
    });

    const running = await wire();
    seedRunningAttempt(running.db, running.root);
    await running.dispatcher.onMessage(
      envelope(
        "IssueSideEffectConfirmationChallenge",
        { commandType: "CancelTask", targetCommandId: "cmd-cancel" },
        { taskId: "task-1" },
      ),
    );
    const challenge = resultOf(last(running.sink)) as Parameters<typeof sign>[0];
    await running.dispatcher.onMessage({
      ...envelope("CancelTask", {}, { taskId: "task-1", expectedStateVersion: 1 }),
      commandId: "cmd-cancel",
      confirmationReceipt: sign(challenge),
    } as CommandEnvelope);

    expect(resultOf(last(running.sink))).toMatchObject({
      taskLifecycle: "Cancelled",
      attemptStatus: "Stopping",
      stopRequestedSessionIds: ["session-1", "session-2"],
      gitCleanup: false,
    });
    expect(running.tasks.listTasks("workspace-1")[0]?.lifecycle).toBe("Cancelled");
    expect(running.tasks.listAttempts("task-1")[0]?.status).toBe("Stopping");
    expect(existsSync(join(running.root, "untracked.txt"))).toBe(true);
  });

  it("start and retry preserve all three explicit Worktree modes", async () => {
    const fixture = await wire({
      launch: true,
      launchModel: "sensitive-looking-model-value",
    });
    const launch = required(fixture.launch, "launch fixture");
    const baseCommand: LaunchCommandPayload = {
      userIdentity: "uid:501",
      profileId: launch.profileId as never,
      worktreeMode: "CreateFromBase",
      baseCommitSha: launch.headSha,
    };

    const start = await issueLaunch(fixture, "Start", "cmd-start", baseCommand, {
      taskId: launch.taskId,
    });
    const startDisplay = displayFields(start.challenge);
    expect(startDisplay.get("Arguments (redacted)")).not.toContain("sensitive-looking-model-value");
    expect(startDisplay.get("Environment Snapshot")).toContain('"hash":"sha256:');
    expect(startDisplay.get("Executable coverage")).toContain("entry-content");
    expect(startDisplay.get("Package closure")).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(startDisplay.get("Worktree target")).toContain('"kind":"Planned"');
    expect(startDisplay.get("Worktree observed state")).toContain("not-materialized");
    expect(startDisplay.get("Dirty/untracked handling")).toContain("not copied");
    expect(startDisplay.get("Impact")).toContain('"mayRepeatPriorSideEffects":false');
    await fixture.dispatcher.onMessage({
      ...envelope("Start", start.command as unknown as Record<string, unknown>, {
        taskId: launch.taskId,
      }),
      commandId: "cmd-start",
    } as CommandEnvelope);
    expect(errorCode(last(fixture.sink))).toBe("ConfirmationRequired");

    await fixture.dispatcher.onMessage({
      ...envelope(
        "Start",
        { ...start.command, userIdentity: "uid:attacker" },
        { taskId: launch.taskId },
      ),
      commandId: "cmd-start",
      launchConfirmationReceipt: sign(start.challenge),
    } as CommandEnvelope);
    expect(errorCode(last(fixture.sink))).toBe("ConfirmationRequired");
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(0);

    const started = await executeLaunch(fixture, "Start", "cmd-start", start, {
      taskId: launch.taskId,
    });
    expect(started).toMatchObject({
      accepted: true,
      commandType: "Start",
      worktreeMode: "CreateFromBase",
    });
    const firstAttempt = required(fixture.tasks.listAttempts(launch.taskId)[0], "first Attempt");
    const firstWorktree = required(
      fixture.worktreeStore.worktreeForAttempt(firstAttempt.attemptId),
      "first Worktree",
    );
    expect({
      state: firstWorktree.state,
      role: firstWorktree.role,
      failureReason: firstWorktree.failureReason,
      failureDetail: firstWorktree.failureDetail,
    }).toEqual({
      state: "Ready",
      role: "Active",
      failureReason: null,
      failureDetail: null,
    });
    await fixture.dispatcher.onMessage({
      ...envelope("Start", start.command as unknown as Record<string, unknown>, {
        taskId: launch.taskId,
      }),
      commandId: "cmd-start",
    } as CommandEnvelope);
    expect(resultOf(last(fixture.sink))).toEqual(started);
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(1);
    fixture.db
      .prepare(
        "UPDATE attempts SET status = 'Failed', state_version = state_version + 1 WHERE attempt_id = ?",
      )
      .run(firstAttempt.attemptId);

    const continuedIssue = await issueLaunch(
      fixture,
      "Retry",
      "cmd-retry-continue",
      { ...baseCommand, worktreeMode: "ContinueCurrentWorktree" },
      { attemptId: firstAttempt.attemptId },
    );
    const continuedDisplay = displayFields(continuedIssue.challenge);
    expect(continuedDisplay.get("Worktree target")).toContain('"kind":"Existing"');
    expect(continuedDisplay.get("Worktree observed state")).toContain('"branchName":"fleet/');
    expect(continuedDisplay.get("Worktree observed state")).toContain('"untrackedCount":0');
    expect(continuedDisplay.get("Dirty/untracked handling")).toContain("preserved in place");
    expect(continuedDisplay.get("Impact")).toContain('"mayRepeatPriorSideEffects":true');
    const continued = await executeLaunch(fixture, "Retry", "cmd-retry-continue", continuedIssue, {
      attemptId: firstAttempt.attemptId,
    });
    expect(continued).toMatchObject({
      accepted: true,
      worktreeId: firstWorktree.worktreeId,
      worktreeMode: "ContinueCurrentWorktree",
    });
    const continueAttempt = required(
      fixture.tasks.listAttempts(launch.taskId)[1],
      "continued Attempt",
    );
    expect(fixture.worktreeStore.worktreeForAttempt(continueAttempt.attemptId)?.worktreeId).toBe(
      firstWorktree.worktreeId,
    );
    fixture.db
      .prepare(
        "UPDATE attempts SET status = 'Failed', state_version = state_version + 1 WHERE attempt_id = ?",
      )
      .run(continueAttempt.attemptId);

    const preservedPath = join(firstWorktree.canonicalPath, "preserved-untracked.txt");
    writeFileSync(preservedPath, "do not copy or clean\n");
    const rebaselineIssue = await issueLaunch(
      fixture,
      "Retry",
      "cmd-retry-rebaseline",
      { ...baseCommand, worktreeMode: "Rebaseline" },
      { attemptId: continueAttempt.attemptId },
    );
    const rebaselined = (await executeLaunch(
      fixture,
      "Retry",
      "cmd-retry-rebaseline",
      rebaselineIssue,
      { attemptId: continueAttempt.attemptId },
    )) as { readonly worktreeId: string };
    const rebaselineWorktree = fixture.worktreeStore.get(rebaselined.worktreeId);
    expect(rebaselineWorktree).toMatchObject({ state: "Ready", role: "Active" });
    expect(rebaselineWorktree.worktreeId).not.toBe(firstWorktree.worktreeId);
    expect(existsSync(preservedPath)).toBe(true);
    expect(existsSync(join(rebaselineWorktree.canonicalPath, "preserved-untracked.txt"))).toBe(
      false,
    );
    const rebaselineAttempt = required(
      fixture.tasks.listAttempts(launch.taskId)[2],
      "rebaseline Attempt",
    );
    fixture.db
      .prepare(
        "UPDATE attempts SET status = 'Failed', state_version = state_version + 1 WHERE attempt_id = ?",
      )
      .run(rebaselineAttempt.attemptId);

    const fromCommitIssue = await issueLaunch(
      fixture,
      "Retry",
      "cmd-retry-commit",
      { ...baseCommand, worktreeMode: "FromCommit" },
      { attemptId: rebaselineAttempt.attemptId },
    );
    const fromCommit = (await executeLaunch(fixture, "Retry", "cmd-retry-commit", fromCommitIssue, {
      attemptId: rebaselineAttempt.attemptId,
    })) as { readonly worktreeId: string };
    expect(fromCommit.worktreeId).not.toBe(rebaselineWorktree.worktreeId);
    expect(fixture.worktreeStore.get(fromCommit.worktreeId)).toMatchObject({
      state: "Ready",
      role: "Active",
      baseCommitSha: launch.headSha,
    });
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(4);
  });

  it("rejects missing and non-commit FromCommit objects before issuing a challenge", async () => {
    const fixture = await wire({ launch: true });
    const launch = required(fixture.launch, "launch fixture");
    const sourceAttemptId = seedResumableAttempt(fixture, "Interrupted");
    fixture.db
      .prepare("UPDATE attempts SET status = 'Failed' WHERE attempt_id = ?")
      .run(sourceAttemptId);
    const blobSha = execFileSync("/usr/bin/git", ["hash-object", "README.md"], {
      cwd: launch.repositoryRoot,
      encoding: "utf8",
    }).trim();

    for (const [label, baseCommitSha] of [
      ["missing", "f".repeat(40)],
      ["blob", blobSha],
    ] as const) {
      await fixture.dispatcher.onMessage(
        envelope(
          "IssueLaunchConfirmationChallenge",
          {
            commandType: "Retry",
            targetCommandId: `cmd-retry-${label}`,
            command: {
              userIdentity: "uid:501",
              profileId: launch.profileId,
              worktreeMode: "FromCommit",
              baseCommitSha,
            },
          },
          { attemptId: sourceAttemptId },
        ),
      );
      expect(errorCode(last(fixture.sink)), label).toBe("InvalidRequest");
    }

    expect(
      (
        fixture.db.prepare("SELECT COUNT(*) AS count FROM confirmation_challenges").get() as {
          readonly count: number;
        }
      ).count,
    ).toBe(0);
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(1);
    expect(fixture.worktreeStore.listForTask(launch.taskId)).toHaveLength(0);
  });

  it("reports a Git executable failure as CapabilityUnavailable during commit verification", async () => {
    const fixture = await wire({
      launch: true,
      gitUnavailableOnCommitVerification: true,
    });
    const launch = required(fixture.launch, "launch fixture");

    await fixture.dispatcher.onMessage(
      envelope(
        "IssueLaunchConfirmationChallenge",
        {
          commandType: "Start",
          targetCommandId: "cmd-start-without-git",
          command: {
            userIdentity: "uid:501",
            profileId: launch.profileId,
            worktreeMode: "CreateFromBase",
            baseCommitSha: launch.headSha,
          },
        },
        { taskId: launch.taskId },
      ),
    );

    expect(errorCode(last(fixture.sink))).toBe("CapabilityUnavailable");
    expect(
      (
        fixture.db.prepare("SELECT COUNT(*) AS count FROM confirmation_challenges").get() as {
          readonly count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("can replace an expired Launch Confirmation for the same target command", async () => {
    const fixture = await wire({ launch: true });
    const launch = required(fixture.launch, "launch fixture");
    const command: LaunchCommandPayload = {
      userIdentity: "uid:501",
      profileId: launch.profileId as never,
      worktreeMode: "CreateFromBase",
      baseCommitSha: launch.headSha,
    };
    const first = await issueLaunch(fixture, "Start", "cmd-start-after-expiry", command, {
      taskId: launch.taskId,
    });
    fixture.db
      .prepare("UPDATE confirmation_challenges SET expires_at = ? WHERE challenge_id = ?")
      .run("2000-01-01T00:00:00.000Z", first.challenge.challengeId);

    const replacement = await issueLaunch(fixture, "Start", "cmd-start-after-expiry", command, {
      taskId: launch.taskId,
    });

    expect(errorCode(last(fixture.sink))).toBeUndefined();
    expect(replacement.challenge.challengeId).not.toBe(first.challenge.challengeId);
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(0);
    expect(fixture.worktreeStore.listForTask(launch.taskId)).toHaveLength(0);
  });

  it("resume fails closed on Capability, Process Disposition, and confirmation drift", async () => {
    const noResume = await wire({ launch: true, resumeCapability: false });
    const noResumeLaunch = required(noResume.launch, "no-resume launch fixture");
    const noResumeAttempt = seedResumableAttempt(noResume);
    noResume.db
      .prepare(
        `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
         VALUES (?, 'ConfirmedAbsent', ?)`,
      )
      .run(noResumeAttempt, new Date().toISOString());
    await noResume.dispatcher.onMessage(
      envelope(
        "IssueLaunchConfirmationChallenge",
        {
          commandType: "Resume",
          targetCommandId: "cmd-resume-no-capability",
          command: {
            userIdentity: "uid:501",
            profileId: noResumeLaunch.profileId,
            worktreeMode: "FromCommit",
            baseCommitSha: noResumeLaunch.headSha,
          },
        },
        { attemptId: noResumeAttempt },
      ),
    );
    expect(errorCode(last(noResume.sink))).toBe("CapabilityUnavailable");
    expect(noResume.tasks.listAttempts(noResumeLaunch.taskId)).toHaveLength(1);
    expect(noResume.worktreeStore.listForTask(noResumeLaunch.taskId)).toHaveLength(0);

    const fixture = await wire({ launch: true });
    const launch = required(fixture.launch, "resume launch fixture");
    const sourceAttemptId = seedResumableAttempt(fixture);
    fixture.db
      .prepare(
        `INSERT INTO process_dispositions (attempt_id, disposition, updated_at)
         VALUES (?, 'Probing', ?)`,
      )
      .run(sourceAttemptId, new Date().toISOString());
    const resumeCommand: LaunchCommandPayload = {
      userIdentity: "uid:501",
      profileId: launch.profileId as never,
      worktreeMode: "FromCommit",
      baseCommitSha: launch.headSha,
    };
    await fixture.dispatcher.onMessage(
      envelope(
        "IssueLaunchConfirmationChallenge",
        {
          commandType: "Resume",
          targetCommandId: "cmd-resume-blocked",
          command: resumeCommand,
        },
        { attemptId: sourceAttemptId },
      ),
    );
    expect(errorCode(last(fixture.sink))).toBe("Conflict");

    fixture.db
      .prepare(
        `UPDATE process_dispositions
         SET disposition = 'ConfirmedAbsent', updated_at = ?
         WHERE attempt_id = ?`,
      )
      .run(new Date().toISOString(), sourceAttemptId);
    const drifted = await issueLaunch(fixture, "Resume", "cmd-resume-drift", resumeCommand, {
      attemptId: sourceAttemptId,
    });
    fixture.db
      .prepare(
        `UPDATE agent_profiles
         SET profile_version = profile_version + 1, updated_at = ?
         WHERE profile_id = ?`,
      )
      .run(new Date().toISOString(), launch.profileId);
    await executeLaunch(fixture, "Resume", "cmd-resume-drift", drifted, {
      attemptId: sourceAttemptId,
    });
    expect(errorCode(last(fixture.sink))).toBe("ConfirmationRequired");
    expect(fixture.tasks.listAttempts(launch.taskId)).toHaveLength(1);
    expect(fixture.worktreeStore.listForTask(launch.taskId)).toHaveLength(0);

    const confirmed = await issueLaunch(fixture, "Resume", "cmd-resume", resumeCommand, {
      attemptId: sourceAttemptId,
    });
    const resumed = await executeLaunch(fixture, "Resume", "cmd-resume", confirmed, {
      attemptId: sourceAttemptId,
    });
    expect(resumed).toMatchObject({
      accepted: true,
      commandType: "Resume",
      worktreeMode: "FromCommit",
    });
    const attempts = fixture.tasks.listAttempts(launch.taskId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: "Uncertain" });
    expect(attempts[1]).toMatchObject({
      status: "Queued",
      commandKind: "Resume",
      sourceAttemptId,
    });
    expect(fixture.worktreeStore.listForTask(launch.taskId)).toHaveLength(1);
  });

  it("preserves stable Host Environment error codes at the authenticated boundary", async () => {
    const fixture = await wire({ launch: true, launchProbeFailure: true });
    const launch = required(fixture.launch, "launch fixture");

    await fixture.dispatcher.onMessage(
      envelope(
        "IssueLaunchConfirmationChallenge",
        {
          commandType: "Start",
          targetCommandId: "cmd-start-probe-failure",
          command: {
            userIdentity: "uid:501",
            profileId: launch.profileId,
            worktreeMode: "CreateFromBase",
            baseCommitSha: launch.headSha,
          },
        },
        { taskId: launch.taskId },
      ),
    );

    expect(errorCode(last(fixture.sink))).toBe("CapabilityUnavailable");
  });

  it("a confirmed launch reaches one new Attempt and one new Session", async () => {
    const fixture = await wire({ launch: true, autoLaunch: true });
    const launch = required(fixture.launch, "launch fixture");
    const issued = await issueLaunch(
      fixture,
      "Start",
      "cmd-start-session",
      {
        userIdentity: "uid:501",
        profileId: launch.profileId as never,
        worktreeMode: "CreateFromBase",
        baseCommitSha: launch.headSha,
      },
      { taskId: launch.taskId },
    );
    expect(issued.challenge).toMatchObject({
      kind: "launch",
      commandType: "Start",
    });

    const accepted = await executeLaunch(fixture, "Start", "cmd-start-session", issued, {
      taskId: launch.taskId,
    });

    expect(last(fixture.sink)).toMatchObject({
      commandId: "cmd-start-session",
      result: {
        accepted: true,
        commandType: "Start",
      },
    });
    expect(accepted).toMatchObject({ accepted: true, commandType: "Start" });
    const attempts = fixture.tasks.listAttempts(launch.taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("Running");
    const attempt = required(attempts[0], "launched Attempt");
    const sessions = fixture.db
      .prepare(
        `SELECT session_id, attempt_id, availability
         FROM sessions WHERE attempt_id = ?`,
      )
      .all(attempt.attemptId) as {
      readonly session_id: string;
      readonly attempt_id: string;
      readonly availability: string;
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      attempt_id: attempt.attemptId,
      availability: "Alive",
    });
    const session = required(sessions[0], "launched Session");
    expect(fixture.sessions.inspectSession(session.session_id)).toMatchObject({
      attemptId: attempt.attemptId,
      availability: "Alive",
    });
  });

  it("TerminateSession stops exactly its leased Session and preserves Task/Worktree state", async () => {
    const fixture = await wire({ launch: true, autoLaunch: true });
    const launch = required(fixture.launch, "launch fixture");
    const issued = await issueLaunch(
      fixture,
      "Start",
      "cmd-start-for-terminate",
      {
        userIdentity: "uid:501",
        profileId: launch.profileId as never,
        worktreeMode: "CreateFromBase",
        baseCommitSha: launch.headSha,
      },
      { taskId: launch.taskId },
    );
    await executeLaunch(fixture, "Start", "cmd-start-for-terminate", issued, {
      taskId: launch.taskId,
    });
    const attempt = required(fixture.tasks.listAttempts(launch.taskId)[0], "launched Attempt");
    const targetSession = fixture.db
      .prepare("SELECT session_id, generation FROM sessions WHERE attempt_id = ?")
      .get(attempt.attemptId) as { readonly session_id: string; readonly generation: number };
    const now = new Date().toISOString();
    fixture.db
      .prepare(
        `INSERT INTO sessions
         (session_id, attempt_id, availability, role, completion_policy,
          generation, created_at, updated_at)
         VALUES ('session-untouched', ?, 'Alive', 'Shell',
                 'DoesNotBlockAttemptCompletion', 1, ?, ?)`,
      )
      .run(attempt.attemptId, now, now);
    const worktree = required(
      fixture.worktreeStore.worktreeForAttempt(attempt.attemptId),
      "launched Worktree",
    );
    const observationCountBeforeTerminate = fixture.observedWorktreeIds.length;
    const dirtyPath = join(worktree.canonicalPath, "terminate-must-not-clean.txt");
    writeFileSync(dirtyPath, "preserve\n");

    await fixture.dispatcher.onMessage(envelope("Attach", { sessionId: targetSession.session_id }));
    const attachment = resultOf(last(fixture.sink)) as {
      readonly attachmentId: string;
      readonly sessionId: string;
      readonly generation: number;
    };
    await fixture.dispatcher.onMessage(
      envelope("AcquireControl", {}, { attachmentId: attachment.attachmentId }),
    );
    const lease = resultOf(last(fixture.sink)) as {
      readonly sessionId: string;
      readonly generation: number;
      readonly attachmentId: string;
      readonly fencingToken: number;
    };
    const identities = {
      sessionId: lease.sessionId,
      expectedGeneration: lease.generation,
      attachmentId: lease.attachmentId,
      fencingToken: lease.fencingToken,
    };
    await fixture.dispatcher.onMessage(
      envelope(
        "IssueSideEffectConfirmationChallenge",
        { commandType: "TerminateSession", targetCommandId: "cmd-terminate-one" },
        identities,
      ),
    );
    const challenge = resultOf(last(fixture.sink)) as Parameters<typeof sign>[0];
    expect(challenge).toMatchObject({
      kind: "side-effect",
      commandType: "TerminateSession",
      sideEffectClass: "destructive",
      targetIdentities: [
        {
          targetType: "Session",
          targetId: targetSession.session_id,
          generation: targetSession.generation,
        },
        {
          targetType: "Attachment",
          targetId: attachment.attachmentId,
          generation: targetSession.generation,
          fencingToken: lease.fencingToken,
        },
      ],
      expectedStateVersions: [],
    });
    const terminateCommand = {
      ...envelope("TerminateSession", {}, identities),
      commandId: "cmd-terminate-one",
      confirmationReceipt: sign(challenge),
    } as CommandEnvelope;
    fixture.worktreeInspectionControl.fail = true;
    await fixture.dispatcher.onMessage(terminateCommand);

    expect(resultOf(last(fixture.sink))).toEqual({
      terminationRequested: true,
      sessionId: targetSession.session_id,
    });
    await waitFor(
      () => fixture.sessions.inspectSession(targetSession.session_id)?.availability === "Exited",
    );
    expect(fixture.sessions.inspectSession("session-untouched")?.availability).toBe("Alive");
    expect(fixture.tasks.listTasks(launch.workspaceId)[0]?.lifecycle).toBe("Runnable");
    expect(existsSync(dirtyPath)).toBe(true);
    expect(fixture.observedWorktreeIds.slice(observationCountBeforeTerminate)).toContain(
      worktree.worktreeId,
    );

    await fixture.dispatcher.onMessage({
      ...terminateCommand,
      confirmationReceipt: undefined,
    } as CommandEnvelope);
    expect(resultOf(last(fixture.sink))).toEqual({
      terminationRequested: true,
      sessionId: targetSession.session_id,
    });
  });
});
