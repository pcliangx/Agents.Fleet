// withTempSqlite — open a real SQLite DB in a temp dir, close + remove on exit.
// Uses Node's built-in node:sqlite (DatabaseSync). RT-STO-06 pragmas (WAL,
// synchronous=FULL) are applied via exec('PRAGMA ...') by the daemon later.
// Lives in the testing package only: Main/Renderer never touch SQLite (SV1-AUTH-09).
//
// Note: better-sqlite3 was the original choice (D2) but does not build on Node 26
// (no prebuild + source compile fails). node:sqlite is built-in and sufficient.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export const withTempSqlite = async <T>(cb: (db: DatabaseSync) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "af-sqlite-"));
  const db = new DatabaseSync(join(dir, "lifecycle.db"));
  try {
    return await cb(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
};
