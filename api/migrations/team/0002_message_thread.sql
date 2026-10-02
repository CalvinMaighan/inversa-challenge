-- Direct messages (PLAN.md C-A7): a message may be addressed to one node inside a thread.
-- Null on both for a team-wide message.
alter table messages add column to_node text;
alter table messages add column thread text;
create index messages_thread_hlc on messages(board_id, thread, hlc);
