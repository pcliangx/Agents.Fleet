// RT-STO-05 — centralized, version-unique migration registry.
//
// Every store shares one `PRAGMA user_version`, so migration versions must be
// unique across stores. Centralizing the merge + uniqueness check here (instead
// of each caller spelling out `[...TASK_MIGRATIONS, ...IdempotencyStore.migrations]`)
// prevents two stores from silently colliding on the same version (A4/I2).

import type { Migration } from "./database.js";
import { IdempotencyStore } from "./idempotency.js";
import { TASK_MIGRATIONS } from "./task-store.js";

export const ALL_MIGRATIONS: readonly Migration[] = (() => {
  const all = [...TASK_MIGRATIONS, ...IdempotencyStore.migrations].sort(
    (a, b) => a.version - b.version,
  );
  const versions = all.map((m) => m.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error(
      `migration versions must be unique across stores; got ${[...versions].sort((a, b) => a - b).join(",")}`,
    );
  }
  return all;
})();
