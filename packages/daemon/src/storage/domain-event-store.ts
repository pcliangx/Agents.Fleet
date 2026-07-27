// RT-EVENT-01..03 / RT-STO-01 — one transaction-scoped writer for the
// authoritative DomainEvent envelope. Callers own the surrounding lifecycle
// transaction; this helper keeps sequence allocation and envelope shape from
// drifting between stores and runtime modules.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const EVENT_SCHEMA_VERSION = 1;

export interface AppendDomainEventInput {
  readonly taskId: string;
  readonly attemptId?: string | null;
  readonly sessionId?: string | null;
  readonly type: string;
  readonly payload: unknown;
}

export const appendDomainEvent = (
  db: DatabaseSync,
  input: AppendDomainEventInput,
  now: () => number = Date.now,
): void => {
  const observedAt = new Date(now()).toISOString();
  const sequence = db
    .prepare(
      "SELECT COALESCE(MAX(timeline_seq), 0) + 1 AS seq FROM domain_events WHERE task_id = ?",
    )
    .get(input.taskId) as { seq: number };
  db.prepare(
    `INSERT INTO domain_events
     (event_id, schema_version, task_id, attempt_id, session_id, timeline_seq,
      type, source, confidence, payload_json, occurred_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'daemon', 'authoritative', ?, ?, ?)`,
  ).run(
    `ev_${randomUUID()}`,
    EVENT_SCHEMA_VERSION,
    input.taskId,
    input.attemptId ?? null,
    input.sessionId ?? null,
    sequence.seq,
    input.type,
    JSON.stringify(input.payload),
    observedAt,
    observedAt,
  );
};
