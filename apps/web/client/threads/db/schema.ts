/**
 * Local SQLite schema (PRD §12 "New tech 2"). Idempotent: every statement is `IF NOT EXISTS`, so the worker
 * runs it on each open. The dialect is plain SQLite so bun:sqlite runs the same statements in tests.
 */

/** 3: cached evidence bodies carried the pre-app media path `/v1/media/<id>`; `migrate` drops cached query bodies when upgrading from an older version. */
export const SCHEMA_VERSION = 3;

/** Columns added after a version shipped: `ALTER TABLE` has no IF NOT EXISTS, so `migrate` tries each and ignores a duplicate. */
export const SCHEMA_UPGRADES: readonly string[] = ["ALTER TABLE messages ADD COLUMN to_node TEXT", "ALTER TABLE messages ADD COLUMN thread TEXT"];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- One EVF2 frame per row: a self-describing single-frame body (72-byte header + frame), raw bytes.
CREATE TABLE IF NOT EXISTS cache_frames (
  frame_at INTEGER NOT NULL,
  step INTEGER NOT NULL,
  etag TEXT,
  body BLOB NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (frame_at, step)
);

CREATE TABLE IF NOT EXISTS cache_queries (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL
);

-- Every op applied locally, ours and theirs. seq is NULL until the server assigns one.
CREATE TABLE IF NOT EXISTS ops (
  id TEXT PRIMARY KEY,
  seq INTEGER,
  hlc TEXT NOT NULL,
  board_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  node_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_board_seq ON ops (board_id, seq);

-- LWW registers, one row per (entity id, field).
CREATE TABLE IF NOT EXISTS missions (
  board_id TEXT NOT NULL,
  id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  hlc TEXT NOT NULL,
  PRIMARY KEY (board_id, id, field)
);
CREATE TABLE IF NOT EXISTS notes (
  board_id TEXT NOT NULL,
  id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  hlc TEXT NOT NULL,
  PRIMARY KEY (board_id, id, field)
);

CREATE TABLE IF NOT EXISTS messages (
  board_id TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  hlc TEXT NOT NULL,
  node_id TEXT NOT NULL,
  to_node TEXT,
  thread TEXT,
  PRIMARY KEY (board_id, id)
);

-- Grow-only counter, one row per node.
CREATE TABLE IF NOT EXISTS removal_counts (
  board_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (board_id, entity_id, node_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY REFERENCES ops (id),
  board_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_at);
`;

/** Statements, one per element, for drivers that run a single statement per call. */
export const SCHEMA_STATEMENTS: readonly string[] = SCHEMA_SQL.split(";")
  .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
  .filter((s) => s.length > 0);
