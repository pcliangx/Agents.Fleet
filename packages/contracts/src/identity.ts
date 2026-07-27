// Branded identity types. Construct via `as TaskId` etc. in daemon/testing.
// RT-INV-03: a Session ID is first-class and never derived from a Worktree ID.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type TaskId = Brand<string, "TaskId">;
export type AttemptId = Brand<string, "AttemptId">;
export type SessionId = Brand<string, "SessionId">;
export type AttachmentId = Brand<string, "AttachmentId">;
export type WorktreeId = Brand<string, "WorktreeId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type CommandId = Brand<string, "CommandId">;
export type EventId = Brand<string, "EventId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type NotificationIntentId = Brand<string, "NotificationIntentId">;
export type ProfileId = Brand<string, "ProfileId">;

export type FencingToken = Brand<number, "FencingToken">;
export type Generation = Brand<number, "Generation">;
export type Seq = Brand<number, "Seq">;

export type DaemonId = Brand<string, "DaemonId">;
export type Nonce = Brand<string, "Nonce">;
export type Receipt = Brand<string, "Receipt">;
