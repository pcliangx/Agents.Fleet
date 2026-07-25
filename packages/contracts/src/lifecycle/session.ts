// RT-STATE-03 / RT-STATE-11..14 — SessionAvailability.
// Initial availability is always Alive (RT-STATE-11); Alive may only become
// Exited or Lost; neither returns to Alive (RT-STATE-12/14).

import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type SessionAvailability = "Alive" | "Exited" | "Lost";

export const SESSION_TRANSITIONS = {
  Alive: ["Exited", "Lost"],
  Exited: [],
  Lost: [],
} as const satisfies TransitionTable<SessionAvailability>;

export const SESSION_TERMINAL_STATES = [
  "Exited",
  "Lost",
] as const satisfies readonly SessionAvailability[];

// RT-STATE-11 — a freshly observed PTY owner is always Alive.
export const INITIAL_SESSION_AVAILABILITY: SessionAvailability = "Alive";

export const canTransition = (from: SessionAvailability, to: SessionAvailability): boolean =>
  canTrans(SESSION_TRANSITIONS, from, to);

export const allowedNext = (from: SessionAvailability): readonly SessionAvailability[] =>
  allNext(SESSION_TRANSITIONS, from);

export const isTerminalSession = (s: SessionAvailability): boolean =>
  (SESSION_TERMINAL_STATES as readonly string[]).includes(s);
