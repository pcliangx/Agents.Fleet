// RT-LAUNCH-01..08 — LaunchIntent status.
// Prepared -> Authorized|Aborted; Authorized -> Aborted; Aborted is terminal.
// (The inert bootstrap PROCESS is implemented in #9/#10; here we encode only the intent state.)

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type LaunchIntentStatus = "Prepared" | "Authorized" | "Aborted";

export const LAUNCH_INTENT_TRANSITIONS = {
  Prepared: ["Authorized", "Aborted"],
  Authorized: ["Aborted"],
  Aborted: [],
} as const satisfies TransitionTable<LaunchIntentStatus>;

export const LAUNCH_INTENT_TERMINAL_STATES = [
  "Aborted",
] as const satisfies readonly LaunchIntentStatus[];

export const canTransition = (from: LaunchIntentStatus, to: LaunchIntentStatus): boolean =>
  canTrans(LAUNCH_INTENT_TRANSITIONS, from, to);

export const allowedNext = (from: LaunchIntentStatus): readonly LaunchIntentStatus[] =>
  allNext(LAUNCH_INTENT_TRANSITIONS, from);

export const isTerminalLaunchIntent = (s: LaunchIntentStatus): boolean =>
  (LAUNCH_INTENT_TERMINAL_STATES as readonly string[]).includes(s);
