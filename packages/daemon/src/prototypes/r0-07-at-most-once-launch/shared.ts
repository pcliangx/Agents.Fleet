// R0-07 — small shared helpers for the at-most-once launch prototype:
// async/file utilities, snapshot reads, and the SINGLE place where raw DB
// status strings are narrowed to the contracts lifecycle types (fail fast on
// anything the state machines do not know — a corrupt row must never be
// silently coerced into a transition decision).

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Attempt, LaunchIntent } from "@agents-fleet/contracts";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Crash-atomic file publish: write tmp + rename (either fully visible or absent). */
export const atomicPublish = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

export const readJsonFile = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

/** RT-STATE-18 — narrow a persisted Attempt status; unknown values are corruption. */
export const asAttemptStatus = (status: string): Attempt.AttemptStatus => {
  if ((Attempt.ATTEMPT_ALL_STATES as readonly string[]).includes(status)) {
    return status as Attempt.AttemptStatus;
  }
  throw new Error(`corrupt attempt status in store: ${JSON.stringify(status)}`);
};

/** RT-LAUNCH-01..08 — narrow a persisted LaunchIntent status. */
export const asLaunchIntentStatus = (status: string): LaunchIntent.LaunchIntentStatus => {
  if (Object.keys(LaunchIntent.LAUNCH_INTENT_TRANSITIONS).includes(status)) {
    return status as LaunchIntent.LaunchIntentStatus;
  }
  throw new Error(`corrupt launch intent status in store: ${JSON.stringify(status)}`);
};

export interface AttemptSnapshot {
  readonly kind: string;
  readonly taskId: string;
  readonly argv: readonly string[];
  readonly argvHash: string;
  readonly factHash: string;
  readonly snapshotId?: string;
}

/** The immutable snapshot written by the RT-LAUNCH-01 command transaction. */
export const readSnapshot = (db: DatabaseSync, attemptId: string): AttemptSnapshot => {
  const row = db.prepare("SELECT snapshot_json FROM attempts WHERE attempt_id = ?").get(attemptId);
  if (!row) throw new Error(`readSnapshot: no attempt ${attemptId}`);
  return JSON.parse((row as { snapshot_json: string }).snapshot_json) as AttemptSnapshot;
};
