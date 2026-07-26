// SV1-FILE-11 / RT-WORKTREE-11 / SV1-T-27 — no-external-program Worktree
// checkout. A Fleet-managed worktree is materialized with every config-declared
// external program disabled; Repository-declared filters fail closed because
// disabling them would make the checkout semantically incomplete.

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorktree, type WorktreeMaterializeResult } from "../git/worktree-checkout.js";

const GIT = "/usr/bin/git";
const run = (args: readonly string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=r0-11", "-c", "user.email=r0-11@example.invalid"];

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

const withParent = async <T>(cb: (parent: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "af-r011-")));
  dirs.push(dir);
  return cb(dir);
};

/** A clean one-commit repo at `src`, returns its HEAD SHA. */
const makeCleanRepo = async (parent: string): Promise<{ src: string; head: string }> => {
  const src = join(parent, "src");
  mkdirSync(src, { recursive: true });
  run(["init", "--initial-branch=main"], src);
  writeFileSync(join(src, "README.md"), "r0-11 fixture\n");
  run([...ID, "add", "README.md"], src);
  run([...ID, "commit", "-m", "init"], src);
  return { src, head: run(["rev-parse", "HEAD"], src) };
};

const expectOk = (r: WorktreeMaterializeResult) => {
  if (!r.ok) expect.unreachable(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe("SV1-FILE-11 no-external-program worktree checkout", () => {
  it("materializes a clean worktree at the base commit", async () => {
    await withParent(async (parent) => {
      const { src, head } = await makeCleanRepo(parent);
      const target = join(parent, "wt");
      const r = expectOk(
        await materializeWorktree({ sourceRoot: src, baseCommitSha: head, targetPath: target }),
      );
      expect(r.headCommitSha).toBe(head);
      expect(existsSync(join(target, "README.md"))).toBe(true);
    });
  });

  it("does not run the post-checkout hook (core.hooksPath=/dev/null)", async () => {
    await withParent(async (parent) => {
      const { src, head } = await makeCleanRepo(parent);
      const hookPath = join(src, ".git", "hooks", "post-checkout");
      const canary = join(parent, "canary-hook");
      writeFileSync(hookPath, `#!/bin/sh\necho ran > "${canary}"\n`);
      chmodSync(hookPath, 0o755); // arm the hook; only the disable keeps it from running
      const target = join(parent, "wt");
      const r = expectOk(
        await materializeWorktree({ sourceRoot: src, baseCommitSha: head, targetPath: target }),
      );
      expect(r.headCommitSha).toBe(head);
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("fails closed (CapabilityUnavailable) when a filter applies to a checked-out path", async () => {
    await withParent(async (parent) => {
      const { src } = await makeCleanRepo(parent);
      // Declare a smudge filter applying to all paths + a driver for it.
      appendFileSync(join(src, ".gitattributes"), "* filter=myfilter\n");
      appendFileSync(
        join(src, ".git", "config"),
        '[filter "myfilter"]\n\tsmudge = echo SMUDGE\n\tclean = cat\n',
      );
      run([...ID, "add", ".gitattributes"], src);
      run([...ID, "commit", "-m", "filter"], src);
      const head = run(["rev-parse", "HEAD"], src);
      const target = join(parent, "wt");
      const r = await materializeWorktree({
        sourceRoot: src,
        baseCommitSha: head,
        targetPath: target,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure.kind).toBe("CapabilityUnavailable");
      expect(r.failure).toMatchObject({ reason: "declared-filter" });
      expect(existsSync(target)).toBe(false); // never materialized → filter never ran
    });
  });
});
