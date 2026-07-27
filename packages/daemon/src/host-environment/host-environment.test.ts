import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHostEnvironment } from "./host-environment.js";

let root = "";

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  root = "";
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const makeProbeExecutable = (path: string, canaryPath: string): void => {
  writeFileSync(
    path,
    `#!/bin/sh
: > ${shellQuote(canaryPath)}
printf 'cwd=%s\\n' "$PWD"
printf 'PATH=%s\\n' "$PATH"
printf 'HOME=%s\\n' "\${HOME-unset}"
printf 'LANG=%s\\n' "\${LANG-unset}"
printf 'ZDOTDIR=%s\\n' "\${ZDOTDIR-unset}"
printf 'GIT_CONFIG_GLOBAL=%s\\n' "\${GIT_CONFIG_GLOBAL-unset}"
printf 'BASH_ENV=%s\\n' "\${BASH_ENV-unset}"
printf 'ENV=%s\\n' "\${ENV-unset}"
printf 'NODE_OPTIONS=%s\\n' "\${NODE_OPTIONS-unset}"
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
};

const parseLines = (stdout: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

describe("LocalHostEnvironment neutral probe (RT-ENV-02 / SV1-T-22)", () => {
  it("executes only after Active Trust, from the app-owned neutral cwd with a cleaned environment", async () => {
    root = mkdtempSync(join(tmpdir(), "af-r103-host-env-"));
    const appDataRoot = join(root, "app-data");
    const repositoryRoot = join(root, "repository");
    const installRoot = join(root, "install");
    const home = join(root, "home");
    const canaryPath = join(root, "agent-executed");
    mkdirSync(repositoryRoot);
    mkdirSync(installRoot);
    mkdirSync(home);
    const executablePath = join(installRoot, "claude");
    makeProbeExecutable(executablePath, canaryPath);

    const environment = new LocalHostEnvironment({
      appDataRoot,
      explicitPathEntries: ["/usr/bin", "/bin"],
      inheritedEnvironment: {
        HOME: home,
        LANG: "C.UTF-8",
        PATH: join(root, "malicious-path"),
        ZDOTDIR: join(root, "malicious-zdotdir"),
        GIT_CONFIG_GLOBAL: join(root, "malicious-gitconfig"),
        BASH_ENV: join(root, "malicious-bash-env"),
        ENV: join(root, "malicious-shell-env"),
        NODE_OPTIONS: "--require=malicious-module",
      },
    });
    expect(
      () =>
        new LocalHostEnvironment({
          appDataRoot: join(root, "bad-app-data"),
          explicitPathEntries: ["/usr/bin", "/bin"],
          inheritedVariableAllowlist: ["HOME", "BASH_ENV"],
        }),
    ).toThrowError(expect.objectContaining({ code: "InvalidRequest" }));
    const candidate = await environment.discoverCandidate(executablePath);
    const baseAuthorization = {
      trustId: "trust-1",
      trustVersion: 1,
      repositoryRoot,
      repositoryIdentity: "repository-1",
    } as const;

    await expect(
      environment.probe({
        authorization: { ...baseAuthorization, state: "PendingValidation" },
        candidate,
        versionArguments: ["--version"],
      }),
    ).rejects.toMatchObject({ code: "Forbidden" });
    expect(existsSync(canaryPath)).toBe(false);

    await expect(
      environment.probe({
        authorization: { ...baseAuthorization, state: "Active" },
        candidate,
        versionArguments: ["--version\0--injected"],
      }),
    ).rejects.toMatchObject({ code: "InvalidRequest" });
    expect(existsSync(canaryPath)).toBe(false);

    const result = await environment.probe({
      authorization: { ...baseAuthorization, state: "Active" },
      candidate,
      versionArguments: ["--version"],
    });
    expect(existsSync(canaryPath)).toBe(true);
    expect(parseLines(result.stdout)).toEqual({
      cwd: realpathSync(join(appDataRoot, "host-environment", "probe")),
      PATH: "/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      ZDOTDIR: "unset",
      GIT_CONFIG_GLOBAL: "unset",
      BASH_ENV: "unset",
      ENV: "unset",
      NODE_OPTIONS: "unset",
    });
    expect(result.environment.inheritedVariableAllowlist).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TMPDIR",
    ]);
  });

  it("creates an immutable Environment Snapshot and detects executable drift before launch", async () => {
    root = mkdtempSync(join(tmpdir(), "af-r103-snapshot-"));
    const appDataRoot = join(root, "app-data");
    const repositoryRoot = join(root, "repository");
    const installRoot = join(root, "install");
    mkdirSync(repositoryRoot);
    mkdirSync(installRoot);
    const executablePath = join(installRoot, "claude");
    makeProbeExecutable(executablePath, join(root, "agent-executed"));
    const environment = new LocalHostEnvironment({
      appDataRoot,
      explicitPathEntries: ["/usr/bin", "/bin"],
      inheritedEnvironment: { HOME: join(root, "home"), LANG: "C.UTF-8" },
      now: () => 1_800_000_000_000,
    });
    const candidate = await environment.discoverCandidate(executablePath);
    const probe = await environment.probe({
      authorization: {
        trustId: "trust-1",
        trustVersion: 1,
        state: "Active",
        repositoryRoot,
        repositoryIdentity: "repository-1",
      },
      candidate,
      versionArguments: ["--version"],
    });
    const launchArguments = ["--permission-mode", "default"];
    const secretReferenceIdentities = ["keychain:sha256:reference-only"];
    const worktreeTarget = {
      kind: "Planned",
      worktreeId: "wt-1" as never,
      canonicalPath: join(root, "worktrees", "task-1"),
      repositoryIdentity: "repository-1",
      branchStrategy: {
        kind: "create",
        branchName: "fleet/task-1",
        onCollision: "fail",
      },
    } as const;

    const record = environment.createSnapshot({
      probe,
      cliVersion: "2.1.218",
      launchArguments,
      worktreeTarget,
      secretReferenceIdentities,
    });
    const sameFacts = environment.createSnapshot({
      probe,
      cliVersion: "2.1.218",
      launchArguments: [...launchArguments],
      worktreeTarget: { ...worktreeTarget },
      secretReferenceIdentities: [...secretReferenceIdentities],
    });
    expect(record.hash).toBe(sameFacts.hash);
    expect(record.snapshot).toMatchObject({
      snapshotVersion: 1,
      cliVersion: "2.1.218",
      worktreeTarget,
      explicitPath: "/usr/bin:/bin",
      secretReferenceIdentities: ["keychain:sha256:reference-only"],
    });
    expect(record.snapshot.argvHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.snapshot)).toBe(true);
    expect(Object.isFrozen(record.snapshot.executableIdentity)).toBe(true);
    expect(Object.isFrozen(record.snapshot.worktreeTarget)).toBe(true);

    launchArguments.push("--drifted-after-snapshot");
    secretReferenceIdentities.push("actual-secret-value");
    expect(JSON.stringify(record)).not.toContain("actual-secret-value");
    await expect(environment.verifySnapshot(record)).resolves.toEqual({
      ok: true,
      observedAt: new Date(1_800_000_000_000).toISOString(),
    });

    writeFileSync(executablePath, `${readFileSync(executablePath, "utf8")}# content drift\n`, {
      mode: 0o700,
    });
    await expect(environment.verifySnapshot(record)).resolves.toEqual({
      ok: false,
      reason: "executable-identity-drift",
    });
  });

  it("blocks entry symlink and interpreter drift across the RT-T-29 identity coverage", async () => {
    root = mkdtempSync(join(tmpdir(), "af-r103-identity-coverage-"));
    const repositoryRoot = join(root, "repository");
    const installRoot = join(root, "install");
    mkdirSync(repositoryRoot);
    mkdirSync(installRoot);

    const interpreterPath = join(installRoot, "verified-sh");
    copyFileSync("/bin/sh", interpreterPath);
    chmodSync(interpreterPath, 0o700);
    const firstEntry = join(installRoot, "claude-v1");
    const secondEntry = join(installRoot, "claude-v2");
    writeFileSync(firstEntry, `#!${interpreterPath}\nprintf '2.1.218\\n'\n`, {
      mode: 0o700,
    });
    writeFileSync(secondEntry, `#!${interpreterPath}\nprintf '2.1.218\\n'\n`, {
      mode: 0o700,
    });
    const executablePath = join(installRoot, "claude");
    symlinkSync(firstEntry, executablePath);

    const environment = new LocalHostEnvironment({
      appDataRoot: join(root, "app-data"),
      explicitPathEntries: ["/usr/bin", "/bin"],
      inheritedEnvironment: {},
      now: () => 1_800_000_000_000,
      runner: {
        async run() {
          return { stdout: "2.1.218\n", stderr: "" };
        },
      },
    });
    const candidate = await environment.discoverCandidate(executablePath);
    const probe = await environment.probe({
      authorization: {
        trustId: "trust-1",
        trustVersion: 1,
        state: "Active",
        repositoryRoot,
        repositoryIdentity: "repository-1",
      },
      candidate,
      versionArguments: ["--version"],
    });
    const worktreeTarget = {
      kind: "Planned",
      worktreeId: "wt-coverage" as never,
      canonicalPath: join(root, "worktrees", "task-coverage"),
      repositoryIdentity: "repository-1",
      branchStrategy: {
        kind: "create",
        branchName: "fleet/task-coverage",
        onCollision: "fail",
      },
    } as const;
    const record = environment.createSnapshot({
      probe,
      cliVersion: "2.1.218",
      launchArguments: ["--permission-mode", "default"],
      worktreeTarget,
      secretReferenceIdentities: [],
    });

    appendFileSync(interpreterPath, Buffer.from([0]));
    await expect(environment.verifySnapshot(record)).resolves.toEqual({
      ok: false,
      reason: "executable-identity-drift",
    });

    // A fresh snapshot then proves that repointing the entry symlink also
    // fails closed before any Agent execution.
    copyFileSync("/bin/sh", interpreterPath);
    chmodSync(interpreterPath, 0o700);
    const freshCandidate = await environment.discoverCandidate(executablePath);
    const freshProbe = await environment.probe({
      authorization: {
        trustId: "trust-1",
        trustVersion: 1,
        state: "Active",
        repositoryRoot,
        repositoryIdentity: "repository-1",
      },
      candidate: freshCandidate,
      versionArguments: ["--version"],
    });
    const freshRecord = environment.createSnapshot({
      probe: freshProbe,
      cliVersion: "2.1.218",
      launchArguments: ["--permission-mode", "default"],
      worktreeTarget,
      secretReferenceIdentities: [],
    });
    unlinkSync(executablePath);
    symlinkSync(secondEntry, executablePath);
    await expect(environment.verifySnapshot(freshRecord)).resolves.toEqual({
      ok: false,
      reason: "executable-identity-drift",
    });
  });
});
