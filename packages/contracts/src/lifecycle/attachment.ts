// RT-STATE-04 / RT-STATE-19 — Attachment status & mode.
// attach creates an Active Attachment; Closed/Invalidated are terminal.
// mode is a projection of SessionAvailability: Live only for Alive, else Restored.

import type { SessionAvailability } from "./session.js";
import {
  allowedNext as allNext,
  canTransition as canTrans,
  type TransitionTable,
} from "./table.js";

export type AttachmentStatus = "Active" | "Closed" | "Invalidated";

export const ATTACHMENT_TRANSITIONS = {
  Active: ["Closed", "Invalidated"],
  Closed: [],
  Invalidated: [],
} as const satisfies TransitionTable<AttachmentStatus>;

export const ATTACHMENT_TERMINAL_STATES = [
  "Closed",
  "Invalidated",
] as const satisfies readonly AttachmentStatus[];

export type AttachmentMode = "Live" | "Restored";

// RT-STATE-04 — a Live attachment is only possible for an Alive session;
// once the session becomes Exited/Lost the same attachment re-projects to Restored.
export const attachmentModeFor = (availability: SessionAvailability): AttachmentMode =>
  availability === "Alive" ? "Live" : "Restored";

export const canTransition = (from: AttachmentStatus, to: AttachmentStatus): boolean =>
  canTrans(ATTACHMENT_TRANSITIONS, from, to);

export const allowedNext = (from: AttachmentStatus): readonly AttachmentStatus[] =>
  allNext(ATTACHMENT_TRANSITIONS, from);

export const isTerminalAttachment = (s: AttachmentStatus): boolean =>
  (ATTACHMENT_TERMINAL_STATES as readonly string[]).includes(s);
