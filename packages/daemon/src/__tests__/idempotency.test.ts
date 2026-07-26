// S3 — idempotent command records (RT-CMD-02/07): same commandId + same
// payload replays the original result, same id + different payload is
// IdempotencyConflict, records survive ≥30 days, tombstones outlive
// retention.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../storage/database.js";
import { IdempotencyStore } from "../storage/idempotency.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

const makeStore = (now: () => number = () => T0): IdempotencyStore => {
  dir = mkdtempSync(join(tmpdir(), "af-r101-idem-"));
  const result = openDatabase({
    path: join(dir, "fleet.db"),
    migrations: IdempotencyStore.migrations,
  });
  if (result.kind !== "ready") throw new Error("db not ready");
  return new IdempotencyStore(result.db, now);
};

describe("IdempotencyStore (RT-CMD-02)", () => {
  it("records and replays the original result for the same commandId + payload", () => {
    const store = makeStore();
    expect(store.lookup("cmd_1", "hash-a")).toBeNull();
    store.record("cmd_1", "hash-a", { status: "ok", attemptId: "at_1" });
    expect(store.lookup("cmd_1", "hash-a")).toEqual({ status: "ok", attemptId: "at_1" });
  });

  it("same commandId with a different payload hash is IdempotencyConflict", () => {
    const store = makeStore();
    store.record("cmd_1", "hash-a", { status: "ok" });
    expect(() => store.lookup("cmd_1", "hash-b")).toThrowError(
      expect.objectContaining({ code: "IdempotencyConflict" }),
    );
    expect(() => store.record("cmd_1", "hash-b", { status: "ok" })).toThrowError(
      expect.objectContaining({ code: "IdempotencyConflict" }),
    );
  });

  it("a replayed record returns the original result, not the new one", () => {
    const store = makeStore();
    store.record("cmd_1", "hash-a", { status: "first" });
    store.record("cmd_1", "hash-a", { status: "second" });
    expect(store.lookup("cmd_1", "hash-a")).toEqual({ status: "first" });
  });
});

describe("IdempotencyStore retention (RT-CMD-07)", () => {
  it("live records are never purged, tombstones only after 30 days", () => {
    let now = T0;
    const store = makeStore(() => now);
    store.record("cmd_live", "hash-a", { status: "ok" });
    store.record("cmd_dead", "hash-b", { status: "ok" });
    store.tombstone("cmd_dead");

    now = T0 + 29 * DAY_MS;
    store.purgeExpired();
    expect(store.lookup("cmd_live", "hash-a")).toEqual({ status: "ok" });
    expect(store.lookup("cmd_dead", "hash-b")).toEqual({ status: "ok" }); // tombstone < 30d

    now = T0 + 31 * DAY_MS;
    store.purgeExpired();
    expect(store.lookup("cmd_live", "hash-a")).toEqual({ status: "ok" });
    expect(store.lookup("cmd_dead", "hash-b")).toBeNull();
  });
});
