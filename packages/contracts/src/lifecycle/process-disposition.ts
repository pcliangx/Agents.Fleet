// RT-STATE-22 / RT-STATE-23 — Process Disposition.
// Records leftover-process facts during Reconciliation. Ordinary Attempts do
// not carry one; its absence does NOT mean Unknown.
//
// RT-STATE-23 freezes only the slot-holding PREDICATE, not a from->to table.
// The table below is PROVISIONAL — pending a spec issue to canonicalize it.
// Do not let the implementation silently define it; file/track the gap.

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type ProcessDisposition =
  | "Probing"
  | "ConfirmedAbsent"
  | "OrphanFound"
  | "KeepRequested"
  | "StopRequested"
  | "ConfirmedStopped";

// PROVISIONAL — pending spec clarification (RT-STATE-22/23 only froze the predicate).
export const PROCESS_DISPOSITION_TRANSITIONS = {
  Probing: ["ConfirmedAbsent", "OrphanFound"],
  OrphanFound: ["KeepRequested", "StopRequested"],
  KeepRequested: ["StopRequested"],
  StopRequested: ["ConfirmedStopped"],
  ConfirmedAbsent: [],
  ConfirmedStopped: [],
} as const satisfies TransitionTable<ProcessDisposition>;

// RT-STATE-23 — these dispositions mean a process may still exist: hold the
// scheduling slot, forbid replacement, block Worktree dispose. Only
// ConfirmedAbsent / ConfirmedStopped release.
export const PROCESS_DISPOSITION_HOLDS_SLOT: readonly ProcessDisposition[] = [
  "Probing",
  "OrphanFound",
  "KeepRequested",
  "StopRequested",
];

export const dispositionHoldsSlot = (d: ProcessDisposition): boolean =>
  (PROCESS_DISPOSITION_HOLDS_SLOT as readonly string[]).includes(d);

export const canTransition = (from: ProcessDisposition, to: ProcessDisposition): boolean =>
  canTrans(PROCESS_DISPOSITION_TRANSITIONS, from, to);

export const allowedNext = (from: ProcessDisposition): readonly ProcessDisposition[] =>
  allNext(PROCESS_DISPOSITION_TRANSITIONS, from);
