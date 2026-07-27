// RT-MOD-12 / RT-ENV-01..06 — local macOS Host Environment implementation.
//
// The public Interface is deliberately small. All filesystem hashing,
// interpreter/closure sampling, code-signing inspection, environment
// sanitization and drift checks stay behind discoverCandidate/probe.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ErrorCode } from "@agents-fleet/contracts";
import {
  type CandidateExecutable,
  type CodeSigningIdentity,
  type CreateEnvironmentSnapshotInput,
  type EnvironmentSnapshot,
  type EnvironmentSnapshotRecord,
  type EnvironmentSnapshotVerification,
  type ExecutableFileIdentity,
  type ExecutableIdentity,
  type ExecutableIdentityCoverage,
  type ExecutableProbeInput,
  type ExecutableProbeResult,
  FROZEN_RUNTIME_LIMIT_PROFILE,
  type HostEnvironment,
  type HostFileIdentity,
  PLATFORM_MATRIX_VERSION,
} from "@agents-fleet/contracts";
import { canonicalSha256 } from "../crypto/canonical-hash.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_INHERITED_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
] as const;

const PROBE_TIMEOUT_MS = 10_000;

export class HostEnvironmentError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostEnvironmentError";
    this.code = code;
  }
}

export interface ExecutableRunInput {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ExecutableRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecutableRunner {
  run(input: ExecutableRunInput): Promise<ExecutableRunResult>;
}

const NODE_EXECUTABLE_RUNNER: ExecutableRunner = {
  async run(input) {
    try {
      const result = await execFileAsync(input.executablePath, [...input.arguments], {
        cwd: input.cwd,
        env: { ...input.environment },
        encoding: "utf8",
        maxBuffer: input.maxOutputBytes,
        timeout: input.timeoutMs,
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "executable probe failed in the verified Host Environment",
      );
    }
  },
};

export interface LocalHostEnvironmentOptions {
  readonly appDataRoot: string;
  readonly explicitPathEntries: readonly string[];
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly inheritedVariableAllowlist?: readonly string[];
  readonly runner?: ExecutableRunner;
  readonly now?: () => number;
}

const fileIdentity = (path: string, followSymlink: boolean): HostFileIdentity => {
  const info = followSymlink ? statSync(path) : lstatSync(path);
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
  };
};

const sameFileIdentity = (left: HostFileIdentity, right: HostFileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size;

const sameCandidate = (left: CandidateExecutable, right: CandidateExecutable): boolean =>
  left.explicitEntryPath === right.explicitEntryPath &&
  left.canonicalEntryPath === right.canonicalEntryPath &&
  sameFileIdentity(left.entryFilesystemIdentity, right.entryFilesystemIdentity) &&
  ((left.symlinkFilesystemIdentity === null && right.symlinkFilesystemIdentity === null) ||
    (left.symlinkFilesystemIdentity !== null &&
      right.symlinkFilesystemIdentity !== null &&
      sameFileIdentity(left.symlinkFilesystemIdentity, right.symlinkFilesystemIdentity)));

const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const hashFile = async (path: string): Promise<string> =>
  await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });

const firstBytes = (path: string): Buffer => {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(4_096);
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
};

const isMachO = (bytes: Buffer): boolean => {
  if (bytes.byteLength < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
};

const directInterpreterPath = (bytes: Buffer): string | null => {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  const firstLine = bytes.toString("utf8").split("\n", 1)[0] ?? "";
  const command = firstLine.slice(2).trim().split(/\s+/, 1)[0] ?? "";
  if (!isAbsolute(command) || command === "/usr/bin/env") return null;
  return command;
};

const executableFileIdentity = async (path: string): Promise<ExecutableFileIdentity> => {
  const canonicalPath = realpathSync(path);
  return {
    canonicalPath,
    filesystemIdentity: fileIdentity(canonicalPath, true),
    contentHash: await hashFile(canonicalPath),
  };
};

const identityFacts = (identity: ExecutableIdentity): Omit<ExecutableIdentity, "observedAt"> => {
  const { observedAt: _observedAt, ...facts } = identity;
  return facts;
};

const inspectCodeSigning = async (
  path: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<CodeSigningIdentity | null> => {
  try {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", path], {
      cwd,
      env: { ...environment },
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: PROBE_TIMEOUT_MS,
    });
    const detail = await execFileAsync("/usr/bin/codesign", ["-d", "--verbose=4", path], {
      cwd,
      env: { ...environment },
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: PROBE_TIMEOUT_MS,
    });
    const text = `${detail.stdout}\n${detail.stderr}`;
    const values = new Map<string, string>();
    const authorities: string[] = [];
    for (const line of text.split("\n")) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === "Authority") authorities.push(value);
      else values.set(key, value);
    }
    return {
      identifier: values.get("Identifier") ?? null,
      teamIdentifier: values.get("TeamIdentifier") ?? null,
      authorities,
      cdHash: values.get("CDHash") ?? null,
    };
  } catch (error) {
    const diagnostic = String(
      (error as { stderr?: string | Buffer }).stderr ??
        (error as { message?: string }).message ??
        "",
    );
    if (/not signed at all|code object is not signed/i.test(diagnostic)) return null;
    throw new HostEnvironmentError(
      "CapabilityUnavailable",
      "executable code-signing identity could not be verified",
    );
  }
};

const inspectNativeDependencies = async (
  path: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<readonly string[]> => {
  try {
    const result = await execFileAsync("/usr/bin/otool", ["-L", path], {
      cwd,
      env: { ...environment },
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  } catch {
    throw new HostEnvironmentError(
      "CapabilityUnavailable",
      "package and runtime closure could not be verified",
    );
  }
};

export class LocalHostEnvironment implements HostEnvironment {
  readonly #neutralCwd: string;
  readonly #explicitPath: string;
  readonly #inheritedVariableAllowlist: readonly string[];
  readonly #inheritedEnvironment: Readonly<Record<string, string>>;
  readonly #runner: ExecutableRunner;
  readonly #now: () => number;

  constructor(options: LocalHostEnvironmentOptions) {
    if (
      !isAbsolute(options.appDataRoot) ||
      options.appDataRoot.includes("\0") ||
      Buffer.byteLength(options.appDataRoot, "utf8") > FROZEN_RUNTIME_LIMIT_PROFILE.pathBytes
    ) {
      throw new HostEnvironmentError("InvalidRequest", "app data root must be absolute");
    }
    if (
      options.explicitPathEntries.length === 0 ||
      options.explicitPathEntries.some(
        (entry) =>
          !isAbsolute(entry) || entry.length === 0 || entry.includes("\0") || entry.includes(":"),
      )
    ) {
      throw new HostEnvironmentError(
        "InvalidRequest",
        "Host Environment PATH entries must be non-empty absolute paths",
      );
    }
    const explicitPath = options.explicitPathEntries.join(":");
    if (
      Buffer.byteLength(explicitPath, "utf8") > FROZEN_RUNTIME_LIMIT_PROFILE.pathBytes ||
      explicitPath.includes("\0")
    ) {
      throw new HostEnvironmentError("InvalidRequest", "Host Environment PATH is invalid");
    }

    const neutralCwd = resolve(options.appDataRoot, "host-environment", "probe");
    mkdirSync(neutralCwd, { recursive: true, mode: 0o700 });
    const canonicalNeutralCwd = realpathSync(neutralCwd);
    const neutralInfo = statSync(canonicalNeutralCwd);
    const uid = process.getuid?.();
    if (
      (uid !== undefined && neutralInfo.uid !== uid) ||
      (neutralInfo.mode & 0o022) !== 0 ||
      !neutralInfo.isDirectory()
    ) {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "neutral probe directory is not application-owned",
      );
    }

    const allowlist = options.inheritedVariableAllowlist ?? DEFAULT_INHERITED_ENVIRONMENT_ALLOWLIST;
    if (
      new Set(allowlist).size !== allowlist.length ||
      allowlist.some(
        (key) => !(DEFAULT_INHERITED_ENVIRONMENT_ALLOWLIST as readonly string[]).includes(key),
      )
    ) {
      throw new HostEnvironmentError(
        "InvalidRequest",
        "Host Environment inherited variable allowlist is invalid",
      );
    }
    const source = options.inheritedEnvironment ?? process.env;
    const inherited: Record<string, string> = {};
    for (const key of allowlist) {
      const value = source[key];
      if (value === undefined) continue;
      if (
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
      ) {
        throw new HostEnvironmentError(
          "InvalidRequest",
          "Host Environment inherited variable value is invalid",
        );
      }
      inherited[key] = value;
    }
    if (
      Buffer.byteLength(JSON.stringify(inherited), "utf8") >
      FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
    ) {
      throw new HostEnvironmentError(
        "InvalidRequest",
        "Host Environment inherited variables exceed the runtime limit",
      );
    }

    this.#neutralCwd = canonicalNeutralCwd;
    this.#explicitPath = explicitPath;
    this.#inheritedVariableAllowlist = Object.freeze([...allowlist]);
    this.#inheritedEnvironment = Object.freeze(inherited);
    this.#runner = options.runner ?? NODE_EXECUTABLE_RUNNER;
    this.#now = options.now ?? (() => Date.now());
  }

  async discoverCandidate(explicitEntryPath: string): Promise<CandidateExecutable> {
    if (
      !isAbsolute(explicitEntryPath) ||
      explicitEntryPath.includes("\0") ||
      Buffer.byteLength(explicitEntryPath, "utf8") > FROZEN_RUNTIME_LIMIT_PROFILE.pathBytes
    ) {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "candidate executable path is unavailable",
      );
    }
    try {
      const explicit = resolve(explicitEntryPath);
      const linkInfo = lstatSync(explicit);
      const canonical = realpathSync(explicit);
      const targetInfo = statSync(canonical);
      if (!targetInfo.isFile() || (targetInfo.mode & 0o111) === 0) {
        throw new Error("not executable");
      }
      return deepFreeze({
        explicitEntryPath: explicit,
        canonicalEntryPath: canonical,
        symlinkFilesystemIdentity: linkInfo.isSymbolicLink() ? fileIdentity(explicit, false) : null,
        entryFilesystemIdentity: fileIdentity(canonical, true),
        observedAt: new Date(this.#now()).toISOString(),
      });
    } catch {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "candidate executable metadata is unavailable",
      );
    }
  }

  async #sampleIdentity(candidate: CandidateExecutable): Promise<ExecutableIdentity> {
    const current = await this.discoverCandidate(candidate.explicitEntryPath);
    if (!sameCandidate(candidate, current)) {
      throw new HostEnvironmentError(
        "ConfirmationRequired",
        "candidate executable identity drifted before probe",
      );
    }
    const entryBytes = firstBytes(current.canonicalEntryPath);
    const entry = await executableFileIdentity(current.canonicalEntryPath);
    const interpreterPath = directInterpreterPath(entryBytes);
    const interpreter =
      interpreterPath === null ? null : await executableFileIdentity(interpreterPath);
    const native = isMachO(entryBytes);
    if (!native && interpreter === null) {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "package and runtime closure coverage is incomplete",
      );
    }

    const dependencyTarget = native ? entry.canonicalPath : interpreter?.canonicalPath;
    const nativeDependencies =
      dependencyTarget === undefined
        ? []
        : await inspectNativeDependencies(
            dependencyTarget,
            this.#neutralCwd,
            this.#probeEnvironment(),
          );
    const codeSigningIdentity = native
      ? await inspectCodeSigning(entry.canonicalPath, this.#neutralCwd, this.#probeEnvironment())
      : null;
    const entries = interpreter === null ? [entry] : [entry, interpreter];
    const manifestWithoutHash = {
      kind: native ? ("native" as const) : ("script" as const),
      entries,
      nativeDependencies,
      platformMatrixVersion: PLATFORM_MATRIX_VERSION,
    };
    const coverage: ExecutableIdentityCoverage[] = [
      "explicit-entry-path",
      "canonical-entry-path",
      "entry-filesystem",
      "entry-content",
      "package-runtime-closure",
      "code-signing",
    ];
    if (current.symlinkFilesystemIdentity !== null) coverage.push("entry-symlink");
    if (interpreter !== null) {
      coverage.push("interpreter-filesystem", "interpreter-content");
    }
    return deepFreeze({
      explicitEntryPath: current.explicitEntryPath,
      canonicalEntryPath: current.canonicalEntryPath,
      filesystemIdentity: current.entryFilesystemIdentity,
      symlinkFilesystemIdentity: current.symlinkFilesystemIdentity,
      entryContentHash: entry.contentHash,
      interpreterIdentity: interpreter,
      packageRuntimeClosureManifest: {
        ...manifestWithoutHash,
        manifestHash: canonicalSha256(manifestWithoutHash),
      },
      codeSigningIdentity,
      observedAt: new Date(this.#now()).toISOString(),
      identityCoverage: coverage,
    });
  }

  #probeEnvironment(): Readonly<Record<string, string>> {
    return { PATH: this.#explicitPath, ...this.#inheritedEnvironment };
  }

  async probe(input: ExecutableProbeInput): Promise<ExecutableProbeResult> {
    if (input.authorization.state !== "Active") {
      throw new HostEnvironmentError(
        "Forbidden",
        "Host Environment probe requires Active Repository Trust",
      );
    }
    if (
      input.versionArguments.length === 0 ||
      input.versionArguments.some((argument) => argument.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(input.versionArguments), "utf8") >
        FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
    ) {
      throw new HostEnvironmentError("InvalidRequest", "executable probe arguments are invalid");
    }
    let canonicalRepositoryRoot: string;
    try {
      canonicalRepositoryRoot = realpathSync(input.authorization.repositoryRoot);
    } catch {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "trusted Repository root is unavailable for the environment probe",
      );
    }
    if (
      isWithin(canonicalRepositoryRoot, this.#neutralCwd) ||
      isWithin(this.#neutralCwd, canonicalRepositoryRoot)
    ) {
      throw new HostEnvironmentError(
        "CapabilityUnavailable",
        "neutral probe directory overlaps the Repository",
      );
    }

    const before = await this.#sampleIdentity(input.candidate);
    const run = await this.#runner.run({
      executablePath: before.canonicalEntryPath,
      arguments: input.versionArguments,
      cwd: this.#neutralCwd,
      environment: this.#probeEnvironment(),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: FROZEN_RUNTIME_LIMIT_PROFILE.adapterObservationBytes,
    });
    const after = await this.#sampleIdentity(input.candidate);
    if (canonicalSha256(identityFacts(before)) !== canonicalSha256(identityFacts(after))) {
      throw new HostEnvironmentError(
        "ConfirmationRequired",
        "executable identity drifted during probe",
      );
    }
    return deepFreeze({
      executableIdentity: after,
      stdout: run.stdout,
      environment: {
        neutralCwd: this.#neutralCwd,
        explicitPath: this.#explicitPath,
        inheritedVariableAllowlist: this.#inheritedVariableAllowlist,
        inheritedEnvironment: this.#inheritedEnvironment,
      },
    });
  }

  createSnapshot(input: CreateEnvironmentSnapshotInput): EnvironmentSnapshotRecord {
    if (
      input.cliVersion.length === 0 ||
      input.cliVersion.includes("\0") ||
      Buffer.byteLength(input.cliVersion, "utf8") > FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
    ) {
      throw new HostEnvironmentError("InvalidRequest", "verified CLI version is invalid");
    }
    if (
      input.launchArguments.some((argument) => argument.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(input.launchArguments), "utf8") >
        FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
    ) {
      throw new HostEnvironmentError("InvalidRequest", "launch arguments contain invalid data");
    }
    if (
      input.secretReferenceIdentities.some((identity) => identity.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(input.secretReferenceIdentities), "utf8") >
        FROZEN_RUNTIME_LIMIT_PROFILE.profileBytes
    ) {
      throw new HostEnvironmentError(
        "InvalidRequest",
        "secret reference identities contain invalid data",
      );
    }
    const snapshot: EnvironmentSnapshot = {
      snapshotVersion: 1,
      executableIdentity: structuredClone(input.probe.executableIdentity),
      cliVersion: input.cliVersion,
      argvHash: canonicalSha256([
        input.probe.executableIdentity.canonicalEntryPath,
        ...input.launchArguments,
      ]),
      worktreeTarget: structuredClone(input.worktreeTarget),
      explicitPath: input.probe.environment.explicitPath,
      inheritedVariableAllowlist: [...input.probe.environment.inheritedVariableAllowlist],
      inheritedEnvironment: { ...input.probe.environment.inheritedEnvironment },
      secretReferenceIdentities: [...input.secretReferenceIdentities],
      capturedAt: new Date(this.#now()).toISOString(),
    };
    if (
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
      FROZEN_RUNTIME_LIMIT_PROFILE.snapshotBytes
    ) {
      throw new HostEnvironmentError(
        "InvalidRequest",
        "Environment Snapshot exceeds the runtime limit",
      );
    }
    return deepFreeze({ snapshot, hash: canonicalSha256(snapshot) });
  }

  async verifySnapshot(
    record: EnvironmentSnapshotRecord,
  ): Promise<EnvironmentSnapshotVerification> {
    if (canonicalSha256(record.snapshot) !== record.hash) {
      return { ok: false, reason: "snapshot-integrity-failure" };
    }
    const identity = record.snapshot.executableIdentity;
    const candidate: CandidateExecutable = {
      explicitEntryPath: identity.explicitEntryPath,
      canonicalEntryPath: identity.canonicalEntryPath,
      symlinkFilesystemIdentity: identity.symlinkFilesystemIdentity,
      entryFilesystemIdentity: identity.filesystemIdentity,
      observedAt: identity.observedAt,
    };
    try {
      const current = await this.#sampleIdentity(candidate);
      if (canonicalSha256(identityFacts(current)) !== canonicalSha256(identityFacts(identity))) {
        return { ok: false, reason: "executable-identity-drift" };
      }
      return { ok: true, observedAt: current.observedAt };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof HostEnvironmentError && error.code === "ConfirmationRequired"
            ? "executable-identity-drift"
            : "executable-identity-unverifiable",
      };
    }
  }
}
