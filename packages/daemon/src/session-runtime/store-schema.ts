// R0-14 — chunk / Input Intent 崩溃注入 fixture 的独立 schema 与打开方式。
// R1 lifecycle DB 的唯一权威是 storage/migrations.ts；本文件只供 R0-14
// 子进程在隔离数据库中重放 durability 边界，不得用于打开 fleet.db。
// 真实 node:sqlite，WAL + synchronous=FULL（RT-STO-06 形状，与
// packages/testing/src/temp-sqlite.ts、r0-07 schema.ts 同一约定）。
// 每个 durability 步骤的 SQLite 写入都是单个 BEGIN IMMEDIATE … COMMIT：
// 崩溃要么落整个步骤，要么完全回滚（RT-STO-02、RT-T-23）。

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS chunks (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  chunk_path TEXT NOT NULL,      -- 相对 storeDir 的 chunk 文件路径
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, seq)
);

-- Durable Stream Cursor（RT-ORDER-07）：每 {sessionId, generation} 已完成
-- chunk durability protocol 的最大连续 seq；不得越过缺失、未索引或
-- checksum 未验证的 frame。
CREATE TABLE IF NOT EXISTS stream_cursors (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  durable_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation)
);

-- Input Intent（RT-INPUT-01..04、RT-STO-11）：原始 bytes 存 content object
-- （content_ref），DB 只保留 provenance、hash 与 byteLength，不存原始 bytes。
CREATE TABLE IF NOT EXISTS input_intents (
  input_intent_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,  -- 幂等键：一个 command 至多一个 intent
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attachment_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('Keyboard','IME','Paste','Mouse','Automation')),
  content_ref TEXT NOT NULL,        -- 相对 storeDir 的 content object 路径
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  redacted_preview TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Prepared','Dispatched','Uncertain')),
  data_gap INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  dispatched_at TEXT
);
`;

export const openSessionStoreDb = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(SCHEMA_DDL);
  return db;
};

/** 单步事务：全部或全无（RT-STO-02 的 index + cursor 提交必须是同一事务）。 */
export const withTx = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};
