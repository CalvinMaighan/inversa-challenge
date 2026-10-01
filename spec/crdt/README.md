# CRDT golden vectors

Shared by `api/src/crdt.rs` and `apps/web/client/threads/crdt/`. Each file:

```
{name, board?, ops: [Op], expected: {missions: {id: {field: value}}, notes: {...},
                                     messages: [{id, body, hlc, to?, thread?}], removals: {entityId: total}}}
```

`Op` is PLAN.md C5. Runners apply ops board by board in file order, then compare the view of
`board` (default: the first op's `boardId`) with `expected`.

Rules the vectors pin down:

- HLC `"<wallMs>:<counter>:<nodeId>"` orders by wallMs, then counter, then nodeId as a string.
- Mission and note: last-writer-wins by HLC per `(entity, entityId, field)`. `_deleted` is a
  register like any other: a later `_deleted=false` undeletes. Writes after a delete are stored
  but the entity reads as deleted while `_deleted` is true. The view omits deleted entities and
  strips `_deleted` from the rest.
- Message: defined by its lowest-HLC op (its creation); any later op for the same id is ignored.
  Message ids are global (one primary key), so they are never reused across boards. The `body`
  value is a string (a team-wide message) or `{body, to, thread}` (a direct message, PLAN.md
  C-A7); the view carries `to` and `thread` only when set (`message-thread`,
  `message-concurrent-commit`).
- Removal: grow-only counter. `value` is the node's running total; the merged total is the
  per-node max summed over nodes.
- Apply is idempotent on op `id`. Any invalid op rejects the whole batch.
- Validation: entity in the enum, non-empty field, serialized value at most 16 KB, a parseable
  HLC (wallMs and counter are 1 to 15 decimal digits), `_deleted` boolean, message
  `field="body"` with a string value or `{body: string, to?: string, thread?: string}` (ids 1 to
  256 bytes, no other keys), removal value a non-negative integer at most
  `Number.MAX_SAFE_INTEGER`.
