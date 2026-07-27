// @agents-fleet/contracts — canonical RT-*/SV1-* types + state machines.
// Pure types + pure functions; zero runtime deps; no Electron/Node-only imports.

export * from "./adapter.js";
export * from "./environment.js";
export type { LoadClassBudget, PerformanceBudget } from "./frozen-performance-budget.js";
export { FROZEN_PERFORMANCE_BUDGET } from "./frozen-performance-budget.js";
export { FROZEN_PLATFORM_MATRIX, PLATFORM_MATRIX_VERSION } from "./frozen-platform-matrix.js";
export {
  FROZEN_RUNTIME_LIMIT_PROFILE,
  RUNTIME_LIMIT_PROFILE_VERSION,
} from "./frozen-runtime-limit-profile.js";
export * from "./identity.js";
export * as Attachment from "./lifecycle/attachment.js";
// Lifecycle state machines are namespaced: each exports canTransition/allowedNext,
// so a barrel `export *` would collide. Use `export * as <Name>`.
export * as Attempt from "./lifecycle/attempt.js";
export * as DaemonMode from "./lifecycle/daemon-mode.js";
export * as LaunchIntent from "./lifecycle/launch-intent.js";
export * as ProcessDisposition from "./lifecycle/process-disposition.js";
// Re-export the most-used projection types at top level (no collision with the namespaces).
export type {
  ProjectTaskViewInput,
  TaskView,
  TaskViewPhase,
  TaskViewStatus,
} from "./lifecycle/projection.js";
export * as TaskViewProjection from "./lifecycle/projection.js";
export * as RepositoryTrust from "./lifecycle/repository-trust.js";
export * as Session from "./lifecycle/session.js";
export * as Task from "./lifecycle/task.js";
export * as Worktree from "./lifecycle/worktree.js";
export type {
  LimitCheckResult,
  LimitViolation,
  ProfileLimitField,
  TerminalLimitField,
} from "./limit-guard.js";
export { checkLimit, checkTerminalLimit } from "./limit-guard.js";
export type { RuntimeLimitProfile, TerminalLimits } from "./limits.js";
export type {
  AgentAdapter,
  LaunchSpec,
  PrepareInput,
  VerifiedDiscoveryInput,
} from "./modules/agent-adapter.js";
export type {
  CreateEnvironmentSnapshotInput,
  ExecutableProbeInput,
  HostEnvironment,
} from "./modules/host-environment.js";
export type { CellCursor, TerminalSurface } from "./modules/terminal-surface.js";
export type {
  MinimumHardware,
  RendererPath,
  SupportedPlatformMatrix,
} from "./platform.js";
export type {
  HostCommandRunner,
  HostPlatform,
  PlatformCheckResult,
  UnsupportedPlatformReason,
} from "./platform-gate.js";
export {
  appleSiliconGeneration,
  checkPlatform,
  sampleHostPlatform,
} from "./platform-gate.js";
export * from "./profile.js";
export * from "./protocol/command.js";
export * from "./protocol/confirmation.js";
export * from "./protocol/error.js";
export * from "./protocol/handshake.js";
export * from "./protocol/stream.js";
export type { PtySink } from "./pty-sink.js";
export * from "./version.js";
