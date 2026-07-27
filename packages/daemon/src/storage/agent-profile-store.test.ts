import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import { CLAUDE_CAPABILITY_PROFILE } from "@agents-fleet/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "./agent-profile-store.js";
import { openDatabase } from "./database.js";
import { ALL_MIGRATIONS } from "./migrations.js";
import { TaskStore } from "./task-store.js";

let root = "";
let database: DatabaseSync | null = null;

afterEach(() => {
  database?.close();
  database = null;
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  root = "";
});

const T0 = 1_800_000_000_000;

const setup = () => {
  root = mkdtempSync(join(tmpdir(), "af-r103-profile-"));
  const dbPath = join(root, "fleet.db");
  const opened = openDatabase({
    path: dbPath,
    migrations: ALL_MIGRATIONS,
    now: () => T0,
  });
  if (opened.kind !== "ready") throw new Error("database not ready");
  database = opened.db;
  const profiles = new AgentProfileStore(opened.db, () => T0);
  const tasks = new TaskStore(opened.db, () => T0);
  const task = tasks.createTask({
    workspaceId: "workspace-1",
    spec: { goal: "exercise immutable profile snapshots" },
  });
  tasks.startTask(task.taskId);
  const attempt = tasks.listAttempts(task.taskId)[0];
  if (attempt === undefined) throw new Error("attempt not created");
  return { db: opened.db, dbPath, profiles, tasks, attemptId: attempt.attemptId };
};

const profileInput = () => ({
  agentId: "claude-code",
  accountRef: "claude-account-reference",
  model: "sonnet",
  mode: null,
  permissionMode: "Balanced" as const,
  secretRefs: [
    {
      kind: "keychain" as const,
      referenceId: "anthropic-api",
      service: "agents-fleet",
      account: "profile-anthropic-api",
    },
  ],
});

const adapterFacts = {
  agentId: "claude-code",
  capabilities: CLAUDE_CAPABILITY_PROFILE.capabilities,
  permissionMappings: CLAUDE_CAPABILITY_PROFILE.permissionMappings,
} as const;

const BALANCED_PERMISSION_MAPPING = CLAUDE_CAPABILITY_PROFILE.permissionMappings[1];
if (BALANCED_PERMISSION_MAPPING === undefined) {
  throw new Error("Balanced fixture mapping is missing");
}

describe("AgentProfileStore (RT-PROFILE-01..03)", () => {
  it("versions saved selections and keeps the Attempt snapshot immutable after edit and delete", () => {
    const { profiles, attemptId } = setup();
    const created = profiles.createProfile(profileInput());
    expect(created).toMatchObject({
      profileVersion: 1,
      agentId: "claude-code",
      permissionMode: "Balanced",
      deletedAt: null,
    });

    const snapshot = profiles.createAttemptSnapshot({
      attemptId,
      profileId: created.profileId,
      adapter: adapterFacts,
    });
    expect(snapshot).toMatchObject({
      profileId: created.profileId,
      profileVersion: 1,
      agentId: "claude-code",
      permissionMode: "Balanced",
      adapterCapabilities: CLAUDE_CAPABILITY_PROFILE.capabilities,
      permissionMapping: CLAUDE_CAPABILITY_PROFILE.permissionMappings[1],
    });
    expect(snapshot.adapterCapabilitiesHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.permissionMappingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.secretReferenceIdentities).toEqual([
      expect.stringMatching(/^keychain:sha256:[a-f0-9]{64}$/),
    ]);

    const updated = profiles.updateProfile(created.profileId, 1, {
      ...profileInput(),
      model: "opus",
      permissionMode: "Manual",
    });
    expect(updated.profileVersion).toBe(2);
    const deleted = profiles.deleteProfile(created.profileId, 2);
    expect(deleted).toMatchObject({ profileVersion: 3 });
    expect(deleted.deletedAt).not.toBeNull();

    expect(profiles.getAttemptSnapshot(attemptId)).toEqual(snapshot);
    expect(() =>
      profiles.createAttemptSnapshot({
        attemptId,
        profileId: created.profileId,
        adapter: adapterFacts,
      }),
    ).toThrowError(expect.objectContaining({ code: "Conflict" }));
  });

  it("rejects plaintext-like secret fields and profiles above the frozen 16 KiB bound before persistence", () => {
    const { dbPath, profiles } = setup();
    const canary = "PLAINTEXT_SECRET_CANARY_R1_03";
    expect(() =>
      profiles.createProfile({
        ...profileInput(),
        secretRefs: [
          {
            kind: "keychain",
            referenceId: "bad",
            service: "agents-fleet",
            account: "bad",
            secretValue: canary,
          } as never,
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));
    expect(() =>
      profiles.createProfile({
        ...profileInput(),
        secretRefs: [
          {
            kind: "agent-owned",
            referenceId: "wrong-agent",
            agentId: "another-agent",
            accountRef: "account-reference",
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));
    expect(() =>
      profiles.createProfile({
        ...profileInput(),
        model: "x".repeat(FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes),
      }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));

    database?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const persisted = [
      readFileSync(dbPath),
      ...(existsSync(`${dbPath}-wal`) ? [readFileSync(`${dbPath}-wal`)] : []),
    ];
    expect(Buffer.concat(persisted).includes(Buffer.from(canary))).toBe(false);
  });

  it("blocks a Permission Mapping that is broader than the saved user intent", () => {
    const { profiles, attemptId } = setup();
    const created = profiles.createProfile(profileInput());
    expect(() =>
      profiles.createAttemptSnapshot({
        attemptId,
        profileId: created.profileId,
        adapter: {
          ...adapterFacts,
          permissionMappings: [
            {
              ...BALANCED_PERMISSION_MAPPING,
              effectiveMode: "YOLO",
            },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "ConfirmationRequired" }));
    expect(profiles.getAttemptSnapshot(attemptId)).toBeNull();

    expect(() =>
      profiles.createAttemptSnapshot({
        attemptId,
        profileId: created.profileId,
        adapter: {
          ...adapterFacts,
          capabilities: adapterFacts.capabilities.filter(
            (capability) => capability !== "PermissionMapping",
          ),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CapabilityUnavailable" }));
    expect(() =>
      profiles.createAttemptSnapshot({
        attemptId,
        profileId: created.profileId,
        adapter: {
          ...adapterFacts,
          permissionMappings: [BALANCED_PERMISSION_MAPPING, BALANCED_PERMISSION_MAPPING],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CapabilityUnavailable" }));
  });

  it("detects durable Agent Profile snapshot corruption before returning facts", () => {
    const { db, profiles, attemptId } = setup();
    const created = profiles.createProfile(profileInput());
    profiles.createAttemptSnapshot({
      attemptId,
      profileId: created.profileId,
      adapter: adapterFacts,
    });
    const row = db
      .prepare("SELECT snapshot_json FROM attempt_profile_snapshots WHERE attempt_id = ?")
      .get(attemptId) as { readonly snapshot_json: string };
    const tampered = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    tampered.model = "tampered-after-persistence";
    db.prepare("UPDATE attempt_profile_snapshots SET snapshot_json = ? WHERE attempt_id = ?").run(
      JSON.stringify(tampered),
      attemptId,
    );

    expect(() => profiles.getAttemptSnapshot(attemptId)).toThrowError(
      expect.objectContaining({ code: "DataIntegrityFailure" }),
    );
  });
});
