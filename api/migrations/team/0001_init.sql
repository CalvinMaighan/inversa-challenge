-- Team board store. Ops are the source of truth (PLAN.md C5); the rest is materialized.

create table ops (
  seq integer primary key autoincrement,
  id text not null unique,
  board_id text not null,
  hlc text not null,
  entity text not null check (entity in ('mission', 'note', 'message', 'removal')),
  entity_id text not null,
  field text not null,
  value text,                               -- JSON
  node_id text not null,
  received_at integer not null
);
create index ops_board_seq on ops(board_id, seq);

-- Last-writer-wins registers for mission and note fields.
create table fields (
  board_id text not null,
  entity text not null,
  entity_id text not null,
  field text not null,
  value text,
  hlc text not null,
  primary key (board_id, entity, entity_id, field)
) without rowid;

create table messages (
  id text primary key,
  board_id text not null,
  body text not null,
  hlc text not null,
  node_id text not null
);
create index messages_board_hlc on messages(board_id, hlc);

-- Grow-only counter: one running total per (entity, node); merged value is the sum.
create table removal_counts (
  board_id text not null,
  entity_id text not null,
  node_id text not null,
  total integer not null,
  primary key (board_id, entity_id, node_id)
) without rowid;
