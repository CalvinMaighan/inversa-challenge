-- Reef heat stress (L3, NOAA Coral Reef Watch) reuses `readings` with four new params, and the
-- `crw` source runs in a third mode, `webhook`: polled as a backstop, nudged by ERDDAP on change.
--
-- SQLite cannot alter a CHECK constraint. `sources` is the parent of five foreign keys, so a
-- copy-and-rename rebuild fails its deferred FK check at commit; both constraints are widened in
-- place instead (https://sqlite.org/lang_altertable.html#otheralter: a change that leaves the
-- stored data valid). `writable_schema = reset` reloads this connection's schema; the create/drop
-- bumps the schema cookie so every other connection reloads too.
pragma writable_schema = on;

update sqlite_schema
set sql = replace(sql, 'check (mode in (''push'', ''poll''))', 'check (mode in (''push'', ''poll'', ''webhook''))')
where type = 'table' and name = 'sources';

update sqlite_schema
set sql = replace(sql, '''wind_ms'', ''fire_frp''))', '''wind_ms'', ''fire_frp'', ''sst'', ''sst_anomaly'', ''dhw'', ''baa''))')
where type = 'table' and name = 'readings';

pragma writable_schema = reset;

create table schema_cookie_bump (x integer);
drop table schema_cookie_bump;
