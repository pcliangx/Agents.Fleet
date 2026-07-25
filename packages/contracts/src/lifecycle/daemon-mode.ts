// RT-STATE-27 — DaemonOperatingMode.
// Normal -> Draining -> Normal (handoff terminates the old Daemon; no 4th mode).
// Normal|Draining -> ReadOnlyRecovery on integrity/migration/recovery failure.
// ReadOnlyRecovery -> Normal only after verified restore + generation bump.

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type DaemonOperatingMode = "Normal" | "Draining" | "ReadOnlyRecovery";

export const DAEMON_MODE_TRANSITIONS = {
  Normal: ["Draining", "ReadOnlyRecovery"],
  Draining: ["Normal", "ReadOnlyRecovery"],
  ReadOnlyRecovery: ["Normal"],
} as const satisfies TransitionTable<DaemonOperatingMode>;

export const canTransition = (from: DaemonOperatingMode, to: DaemonOperatingMode): boolean =>
  canTrans(DAEMON_MODE_TRANSITIONS, from, to);

export const allowedNext = (from: DaemonOperatingMode): readonly DaemonOperatingMode[] =>
  allNext(DAEMON_MODE_TRANSITIONS, from);
