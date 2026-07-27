// RT-MOD-12 / RT-ENV-01..06 — Host Environment facts.
//
// CandidateExecutable is deliberately metadata-only: pre-Trust discovery may
// canonicalize/stat an installed executable, but it does not hash or execute
// it and does not claim a version or Capability. ExecutableIdentity is the
// post-Active-Trust evidence bound into an Environment Snapshot.

import type { RepositoryTrustState } from "./lifecycle/repository-trust.js";
import type { WorktreeTargetBinding } from "./lifecycle/worktree.js";

export interface HostFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
}

export interface CandidateExecutable {
  /** The absolute path supplied by installation metadata; never a PATH lookup. */
  readonly explicitEntryPath: string;
  readonly canonicalEntryPath: string;
  /** lstat identity when the explicit path is a symlink; null otherwise. */
  readonly symlinkFilesystemIdentity: HostFileIdentity | null;
  /** stat identity of canonicalEntryPath. */
  readonly entryFilesystemIdentity: HostFileIdentity;
  readonly observedAt: string;
}

export interface ExecutableFileIdentity {
  readonly canonicalPath: string;
  readonly filesystemIdentity: HostFileIdentity;
  readonly contentHash: string;
}

export interface CodeSigningIdentity {
  readonly identifier: string | null;
  readonly teamIdentifier: string | null;
  readonly authorities: readonly string[];
  readonly cdHash: string | null;
}

export interface PackageRuntimeClosureManifest {
  readonly kind: "native" | "script";
  readonly entries: readonly ExecutableFileIdentity[];
  /** Native load-command identities, or the interpreter's native dependencies for a script. */
  readonly nativeDependencies: readonly string[];
  readonly platformMatrixVersion: number;
  readonly manifestHash: string;
}

export type ExecutableIdentityCoverage =
  | "explicit-entry-path"
  | "canonical-entry-path"
  | "entry-symlink"
  | "entry-filesystem"
  | "entry-content"
  | "interpreter-filesystem"
  | "interpreter-content"
  | "package-runtime-closure"
  | "code-signing";

export interface ExecutableIdentity {
  readonly explicitEntryPath: string;
  readonly canonicalEntryPath: string;
  readonly filesystemIdentity: HostFileIdentity;
  readonly symlinkFilesystemIdentity: HostFileIdentity | null;
  readonly entryContentHash: string;
  readonly interpreterIdentity: ExecutableFileIdentity | null;
  readonly packageRuntimeClosureManifest: PackageRuntimeClosureManifest;
  readonly codeSigningIdentity: CodeSigningIdentity | null;
  readonly observedAt: string;
  readonly identityCoverage: readonly ExecutableIdentityCoverage[];
}

export interface RepositoryTrustProbeAuthorization {
  readonly trustId: string;
  readonly trustVersion: number;
  readonly state: RepositoryTrustState;
  readonly repositoryRoot: string;
  readonly repositoryIdentity: string;
}

export interface ProbeEnvironment {
  readonly neutralCwd: string;
  readonly explicitPath: string;
  readonly inheritedVariableAllowlist: readonly string[];
  readonly inheritedEnvironment: Readonly<Record<string, string>>;
}

export interface ExecutableProbeResult {
  readonly executableIdentity: ExecutableIdentity;
  /** Bounded probe output for Adapter-owned version parsing; never persisted as a secret source. */
  readonly stdout: string;
  readonly environment: ProbeEnvironment;
}

export interface EnvironmentSnapshot {
  readonly snapshotVersion: 1;
  readonly executableIdentity: ExecutableIdentity;
  readonly cliVersion: string;
  readonly argvHash: string;
  readonly worktreeTarget: WorktreeTargetBinding;
  readonly explicitPath: string;
  readonly inheritedVariableAllowlist: readonly string[];
  readonly inheritedEnvironment: Readonly<Record<string, string>>;
  /** Stable reference identities only — never secret values. */
  readonly secretReferenceIdentities: readonly string[];
  readonly capturedAt: string;
}

export interface EnvironmentSnapshotRecord {
  readonly snapshot: EnvironmentSnapshot;
  readonly hash: string;
}

export type EnvironmentSnapshotVerification =
  | { readonly ok: true; readonly observedAt: string }
  | {
      readonly ok: false;
      readonly reason:
        | "snapshot-integrity-failure"
        | "executable-identity-drift"
        | "executable-identity-unverifiable";
    };
