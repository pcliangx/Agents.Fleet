// R0-07 — coordinator unit tests (in-process, real SQLite + real bootstrap
// children, no crash injection). Covers RT-CMD-02 idempotency, RT-LAUNCH-01
// transaction atomicity, the RT-LAUNCH-08 abort path, and nonce finality.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { argvHashOf, type LaunchCommand, LaunchCoordinator, LaunchRuntime } from "./coordinator.js";
import { abortPath, agentIdentityPath, bootstrapExitPath } from "./paths.js";
import { openLifecycleDb, type SqliteDatabase } from "./schema.js";

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

const setup = (kind: "start" | "retry" = "start") => {
  const workDir = mkdtempSync(join(tmpdir(), "r0-07-coord-"));
  dirs.push(workDir);
  writeFileSync(join(workDir, "facts.json"), JSON.stringify({ binding: "wt-1" }));
  const db = openLifecycleDb(join(workDir, "lifecycle.db"));
  dbs.push(db);
  db.prepare("INSERT INTO tasks (task_id, status) VALUES ('task-1', ?)").run(
    kind === "start" ? "Draft" : "Runnable",
  );
  const opts = {
    db,
    workDir,
    bootstrapPath: BOOTSTRAP,
    agentPath: AGENT,
    observeAgentTimeoutMs: 400,
    bootstrapTimeoutMs: 3000,
  };
  return { db, workDir, opts, coordinator: new LaunchCoordinator(opts) };
};

const cmd: LaunchCommand = {
  commandId: "cmd-1",
  kind: "start",
  taskId: "task-1",
  argv: ["agent", "run"],
};

describe("R0-07 launch coordinator (in-process)", () => {
  it("happy path: Running, task flipped, idempotent reissue (RT-CMD-02)", async () => {
    const { db, workDir, coordinator } = setup();
    const result = await coordinator.launch(cmd);
    expect(result.status).toBe("Running");
    // RT-LAUNCH-01: start flipped Draft → Runnable in the command transaction
    expect((db.prepare("SELECT status FROM tasks").get() as { status: string }).status).toBe(
      "Runnable",
    );
    // RT-CMD-02: same commandId + same payload returns the ORIGINAL result
    const again = await coordinator.launch(cmd);
    expect(again.status).toBe("Running");
    expect((again as { attemptId: string }).attemptId).toBe("att-cmd-1");
    // RT-CMD-02: same commandId + different payload → IdempotencyConflict
    const conflict = await coordinator.launch({ ...cmd, argv: ["agent", "other"] });
    expect(conflict.status).toBe("IdempotencyConflict");
    // exactly one agent identity was ever written
    expect(existsSync(agentIdentityPath(workDir, "ln-att-cmd-1"))).toBe(true);
    // cleanup the live fake agent
    const agent = JSON.parse(readFileSync(agentIdentityPath(workDir, "ln-att-cmd-1"), "utf8"));
    process.kill(agent.pid, "SIGKILL");
  });

  it("RT-LAUNCH-08: fact drift aborts in one tx; the Aborted nonce can never be resurrected", async () => {
    const { db, workDir, opts, coordinator } = setup();
    const drifting = new LaunchCoordinator({
      ...opts,
      beforeRevalidation: () =>
        writeFileSync(join(workDir, "facts.json"), JSON.stringify({ binding: "wt-DRIFTED" })),
    });
    const result = await drifting.launch(cmd);
    expect(result).toEqual({ status: "Failed", attemptId: "att-cmd-1", reason: "fact-drift" });

    const intent = db
      .prepare("SELECT * FROM launch_intents WHERE launch_nonce = 'ln-att-cmd-1'")
      .get() as { status: string; abort_reason: string };
    expect(intent.status).toBe("Aborted");
    // Attempt Failed, slot released, planned session gone — one transaction.
    expect((db.prepare("SELECT status FROM attempts").get() as { status: string }).status).toBe(
      "Failed",
    );
    expect(
      (db.prepare("SELECT released FROM slot_leases").get() as { released: number }).released,
    ).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    // AbortLaunch was sent; the bootstrap took it and never exec'd.
    expect(existsSync(abortPath(workDir, "ln-att-cmd-1"))).toBe(true);
    const exitPath = bootstrapExitPath(workDir, "ln-att-cmd-1");
    const deadline = Date.now() + 3000;
    while (!existsSync(exitPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const exit = JSON.parse(readFileSync(exitPath, "utf8"));
    expect(exit.reason).toBe("aborted");
    expect(exit.exec).toBe(false);
    expect(existsSync(agentIdentityPath(workDir, "ln-att-cmd-1"))).toBe(false);

    // RT-LAUNCH-05: reissue returns the original failure — no resume, no nonce swap.
    expect((await coordinator.launch(cmd)).status).toBe("Failed");
    // the Aborted nonce can never be authorized again (RT-LAUNCH-08 terminal)
    const rt = new LaunchRuntime(opts);
    expect(() =>
      rt.authorizeTx("ln-att-cmd-1", {
        nonce: "ln-att-cmd-1",
        pid: 1,
        pgid: 1,
        lstart: "x",
        argvHash: argvHashOf(cmd.argv),
      }),
    ).toThrow(/cannot authorize/);
  });

  it("RT-LAUNCH-01: a failing command transaction leaves NO partial Attempt/binding", async () => {
    const { db, coordinator } = setup();
    // sabotage: an attempt row with the same id makes the INSERT fail mid-tx
    db.prepare(
      "INSERT INTO attempts (attempt_id, command_id, task_id, kind, status, snapshot_json, created_at) VALUES ('att-cmd-1', 'other', 'task-1', 'start', 'Failed', '{}', 'now')",
    ).run();
    await expect(coordinator.launch(cmd)).rejects.toThrow();
    // everything rolled back: no idempotency record, task still Draft
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT status FROM tasks").get() as { status: string }).status).toBe(
      "Draft",
    );
  });

  it("RT-LAUNCH-01: a failing launch transaction leaves the Attempt Queued with no intent/lease/session", async () => {
    const { db, coordinator } = setup();
    // sabotage: conflicting slot lease makes the launch tx fail mid-tx
    db.prepare(
      "INSERT INTO slot_leases (slot_id, attempt_id, released) VALUES ('slot-att-cmd-1', 'other', 0)",
    ).run();
    await expect(coordinator.launch(cmd)).rejects.toThrow();
    const attempt = db.prepare("SELECT status FROM attempts").get() as { status: string };
    expect(attempt.status).toBe("Queued"); // rolled back, not partially Starting
    expect(db.prepare("SELECT COUNT(*) AS n FROM launch_intents").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM slot_leases WHERE attempt_id = 'att-cmd-1'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("RT-LAUNCH-06: CommitLaunch sent but Agent never observed → Uncertain (not Aborted)", async () => {
    const { db, workDir, opts } = setup();
    const deadAgentOpts = { ...opts, agentPath: join(workDir, "no-such-agent.mjs") };
    const coordinator = new LaunchCoordinator(deadAgentOpts);
    const result = await coordinator.launch(cmd);
    expect(result.status).toBe("Uncertain");
    const intent = db.prepare("SELECT status, commit_sent_at FROM launch_intents").get() as {
      status: string;
      commit_sent_at: string | null;
    };
    // RT-LAUNCH-08 tail: delivery unknown ⇒ intent stays Authorized, NOT Aborted
    expect(intent.status).toBe("Authorized");
    expect(intent.commit_sent_at).not.toBeNull();
    // slot lease is KEPT while the outcome is Uncertain (Process Disposition)
    expect(
      (db.prepare("SELECT released FROM slot_leases").get() as { released: number }).released,
    ).toBe(0);
  });
});
