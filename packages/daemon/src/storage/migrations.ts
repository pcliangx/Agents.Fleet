// RT-STO-05 — centralized, version-unique migration registry.
//
// Every store shares one `PRAGMA user_version`, so migration versions must be
// unique across stores. Centralizing the merge + uniqueness check here (instead
// of each caller spelling out `[...TASK_MIGRATIONS, ...IdempotencyStore.migrations]`)
// prevents two stores from silently colliding on the same version (A4/I2).

import { PersistentChallengeIssuer } from "../confirmation/persistent-challenge-issuer.js";
import { AGENT_PROFILE_MIGRATIONS } from "./agent-profile-store.js";
import type { Migration } from "./database.js";
import { ENVIRONMENT_SNAPSHOT_MIGRATIONS } from "./environment-snapshot-store.js";
import { IdempotencyStore } from "./idempotency.js";
import { REPOSITORY_TRUST_MIGRATIONS } from "./repository-trust-store.js";
import { SESSION_RUNTIME_MIGRATIONS } from "./session-runtime-store.js";
import { TASK_MIGRATIONS } from "./task-store.js";
import { WORKTREE_MIGRATIONS } from "./worktree-store.js";

export const ALL_MIGRATIONS: readonly Migration[] = (() => {
  const all = [
    ...TASK_MIGRATIONS,
    ...IdempotencyStore.migrations,
    ...REPOSITORY_TRUST_MIGRATIONS,
    ...PersistentChallengeIssuer.migrations,
    ...AGENT_PROFILE_MIGRATIONS,
    ...ENVIRONMENT_SNAPSHOT_MIGRATIONS,
    ...WORKTREE_MIGRATIONS,
    ...SESSION_RUNTIME_MIGRATIONS,
  ].sort((a, b) => a.version - b.version);
  const versions = all.map((m) => m.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error(
      `migration versions must be unique across stores; got ${[...versions].sort((a, b) => a - b).join(",")}`,
    );
  }
  return all;
})();
