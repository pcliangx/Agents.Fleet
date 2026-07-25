// R0-07 — Reconciliation unit tests over crafted durable states (the states a
// crashed coordinator can leave behind). No crash injection here; the matrix
// test covers real crashes. Focus: the RT-LAUNCH-08 tail (delivery unknown ⇒
// Uncertain, never Aborted), RT-LAUNCH-05 finality, and RT-LAUNCH-06 probing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { argvHashOf, LaunchRuntime } from "./coordinator.js";
import { agentIdentityPath, commitPath, receiptPath } from "./paths.js";
import { reconcile } from "./reconcile.js";
import { openLifecycleDb, type SqliteDatabase } from "./schema.js";
import { atomicPublish } from "./shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(here, "children", "bootstrap.mjs");
const AGENT = join(here, "children", "fake-agent.mjs");

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ARGV = ["agent", "run"];

/** Craft the durable state a crash left: Starting attempt + intent at `intentStatus`. */
const craft = (opts: {
  intentStatus: "Prepared" | "Authorized";
  withReceipt?: boolean;
  withCommitFile?: boolean;
  commitSentAt?: string | null;
  bootstrapPid?: number | null;
}) => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-07-rec-"));
  dirs.push(workDir);
  writeFileSync(join(workDir, "facts.json"), JSON.stringify({ binding: "wt-1" }));
  const db = openLifecycleDb(join(workDir, "lifecycle.db"));
  dbs.push(db);
  db.prepare("INSERT INTO tasks (task_id, status) VALUES ('task-1', 'Runnable')").run();
  const rt = new LaunchRuntime({
    db,
    workDir,
    bootstrapPath: BOOTSTRAP,
    agentPath: AGENT,
    observeAgentTimeoutMs: 250,
  });
  const snapshot = JSON.stringify({
    kind: "start",
    argv: ARGV,
    argvHash: argvHashOf(ARGV),
    factHash: rt.factHash(),
  });
  db.prepare(
    "INSERT INTO attempts (attempt_id, command_id, task_id, kind, status, snapshot_json, created_at) VALUES ('att-cmd-1', 'cmd-1', 'task-1', 'start', 'Starting', ?, 'now')",
  ).run(snapshot);
  db.prepare(
    "INSERT INTO launch_intents (launch_nonce, attempt_id, command_id, argv_hash, status, bootstrap_pid, commit_sent_at, created_at) VALUES ('ln-att-cmd-1', 'att-cmd-1', 'cmd-1', ?, ?, ?, ?, 'now')",
  ).run(argvHashOf(ARGV), opts.intentStatus, opts.bootstrapPid ?? null, opts.commitSentAt ?? null);
  db.prepare(
    "INSERT INTO slot_leases (slot_id, attempt_id, released) VALUES ('slot-att-cmd-1', 'att-cmd-1', 0)",
  ).run();
  db.prepare(
    "INSERT INTO sessions (session_id, attempt_id, availability) VALUES ('ses-att-cmd-1', 'att-cmd-1', 'Planned')",
  ).run();
  db.prepare(
    "INSERT INTO idempotency (command_id, payload_hash, status) VALUES ('cmd-1', 'h', 'pending')",
  ).run();
  if (opts.withReceipt) {
    writeFileSync(
      receiptPath(workDir, "ln-att-cmd-1"),
      JSON.stringify({
        nonce: "ln-att-cmd-1",
        pid: deadPid(),
        pgid: 0,
        lstart: "x",
        argvHash: argvHashOf(ARGV),
      }),
    );
  }
  if (opts.withCommitFile) {
    atomicPublish(
      commitPath(workDir, "ln-att-cmd-1"),
      JSON.stringify({ nonce: "ln-att-cmd-1", argvHash: argvHashOf(ARGV) }),
    );
  }
  return { db, workDir, rt };
};

/** A pid that is guaranteed gone (ran /bin/true to completion). */
const deadPid = (): number => {
  const pid = Number(
    execFileSync("/bin/sh", ["-c", "/bin/true & echo $!; wait"], { encoding: "utf8" }).trim(),
  );
  return pid;
};

describe("R0-07 Reconciliation over crafted crash states", () => {
  it("RT-LAUNCH-08 tail: commit file present + no agent → Uncertain, intent stays Authorized, lease kept", async () => {
    const { db, rt } = craft({ intentStatus: "Authorized", withCommitFile: true });
    const report = await reconcile({ rt });
    expect(report.actions.map((a) => a.action)).toEqual(["uncertain-commit-delivery-unknown"]);
    expect((db.prepare("SELECT status FROM attempts").get() as { status: string }).status).toBe(
      "Uncertain",
    );
    // the intent is NOT Aborted — CommitLaunch may have been delivered
    expect(
      (db.prepare("SELECT status FROM launch_intents").get() as { status: string }).status,
    ).toBe("Authorized");
    // slot lease kept; session marked Lost; idempotent result records Uncertain
    expect(
      (db.prepare("SELECT released FROM slot_leases").get() as { released: number }).released,
    ).toBe(0);
    expect(
      (db.prepare("SELECT availability FROM sessions").get() as { availability: string })
        .availability,
    ).toBe("Lost");
    // reconcile is idempotent: a second pass touches nothing
    const second = await reconcile({ rt });
    expect(second.actions).toEqual([]);
  });

  it("RT-LAUNCH-08: abortTx REFUSES to abort once CommitLaunch may be delivered", async () => {
    const { rt } = craft({ intentStatus: "Authorized", withCommitFile: true });
    expect(() => rt.abortTx("ln-att-cmd-1", "fact-drift")).toThrow(/must go Uncertain/);
  });

  it("commit provably never sent (file absent) → Authorized aborts cleanly to Failed", async () => {
    const { db, rt } = craft({ intentStatus: "Authorized", bootstrapPid: deadPid() });
    const report = await reconcile({ rt });
    expect(report.actions.map((a) => a.action)).toEqual(["aborted-commit-never-sent"]);
    expect((db.prepare("SELECT status FROM attempts").get() as { status: string }).status).toBe(
      "Failed",
    );
    expect(
      (db.prepare("SELECT status FROM launch_intents").get() as { status: string }).status,
    ).toBe("Aborted");
    expect(
      (db.prepare("SELECT released FROM slot_leases").get() as { released: number }).released,
    ).toBe(1);
  });

  it("Prepared + orphaned receipt (dead bootstrap) → aborted, never continued", async () => {
    const { db, rt } = craft({ intentStatus: "Prepared", withReceipt: true });
    const report = await reconcile({ rt });
    expect(report.actions.map((a) => a.action)).toEqual(["aborted-bootstrap-lost"]);
    expect((db.prepare("SELECT status FROM attempts").get() as { status: string }).status).toBe(
      "Failed",
    );
  });

  it("RT-LAUNCH-05: Prepared + no receipt → the SAME handshake continues to exactly one Agent", async () => {
    const { db, workDir, rt } = craft({ intentStatus: "Prepared" });
    const report = await reconcile({ rt });
    expect(report.actions.map((a) => a.action)).toEqual(["continued-from-prepared"]);
    expect((db.prepare("SELECT status FROM attempts").get() as { status: string }).status).toBe(
      "Running",
    );
    const agent = JSON.parse(readFileSync(agentIdentityPath(workDir, "ln-att-cmd-1"), "utf8")) as {
      pid: number;
    };
    process.kill(agent.pid, "SIGKILL");
  });
});
