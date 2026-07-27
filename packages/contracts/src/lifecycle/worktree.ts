// RT-WORKTREE-10 — Worktree state & role (two coupled machines) + state/role pairing.
// Planned -> Ready|Failed|Orphaned; Orphaned -> Ready|Failed; Ready -> Disposed.
// Role: Pending -> Active|Historical; Active -> Historical.
// Pairing invariants: Planned/Orphaned only Pending; Failed not Active; Disposed only Historical.

import type { WorktreeId } from "../identity.js";
import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

// RT-WORKTREE-02 / RT-ENV-03 — the target confirmed before launch. Planned
// targets bind only facts that already exist, including the planned canonical
// path; Ready later adds the actual filesystem identity without pretending it
// was known at confirmation time.
export interface PlannedWorktreeTargetBinding {
  readonly kind: "Planned";
  readonly worktreeId: WorktreeId;
  readonly canonicalPath: string;
  readonly repositoryIdentity: string;
  readonly branchStrategy: {
    readonly kind: "create";
    readonly branchName: string;
    readonly onCollision: "fail";
  };
}

export interface FilesystemIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ExistingWorktreeTargetBinding {
  readonly kind: "Existing";
  readonly worktreeId: WorktreeId;
  readonly canonicalPath: string;
  readonly repositoryIdentity: string;
  readonly filesystemIdentity: FilesystemIdentity;
}

export type WorktreeTargetBinding = PlannedWorktreeTargetBinding | ExistingWorktreeTargetBinding;

export type WorktreeState = "Planned" | "Ready" | "Failed" | "Orphaned" | "Disposed";

export const WORKTREE_STATE_TRANSITIONS = {
  Planned: ["Ready", "Failed", "Orphaned"],
  Ready: ["Disposed"],
  Failed: [],
  Orphaned: ["Ready", "Failed"],
  Disposed: [],
} as const satisfies TransitionTable<WorktreeState>;

export const WORKTREE_STATE_TERMINAL_STATES = [
  "Failed",
  "Disposed",
] as const satisfies readonly WorktreeState[];

export type WorktreeRole = "Pending" | "Active" | "Historical";

export const WORKTREE_ROLE_TRANSITIONS = {
  Pending: ["Active", "Historical"],
  Active: ["Historical"],
  Historical: [],
} as const satisfies TransitionTable<WorktreeRole>;

// RT-WORKTREE-10 — legal (state, role) pairs.
export const isValidStateRolePair = (state: WorktreeState, role: WorktreeRole): boolean => {
  switch (state) {
    case "Planned":
    case "Orphaned":
      return role === "Pending";
    case "Disposed":
      return role === "Historical";
    case "Failed":
      return role !== "Active";
    case "Ready":
      return role === "Active" || role === "Historical";
  }
};

export const canTransitionState = (from: WorktreeState, to: WorktreeState): boolean =>
  canTrans(WORKTREE_STATE_TRANSITIONS, from, to);

export const allowedNextState = (from: WorktreeState): readonly WorktreeState[] =>
  allNext(WORKTREE_STATE_TRANSITIONS, from);

export const isTerminalWorktreeState = (s: WorktreeState): boolean =>
  (WORKTREE_STATE_TERMINAL_STATES as readonly string[]).includes(s);

export const canTransitionRole = (from: WorktreeRole, to: WorktreeRole): boolean =>
  canTrans(WORKTREE_ROLE_TRANSITIONS, from, to);

export const allowedNextRole = (from: WorktreeRole): readonly WorktreeRole[] =>
  allNext(WORKTREE_ROLE_TRANSITIONS, from);
