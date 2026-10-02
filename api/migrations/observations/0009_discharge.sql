-- USGS discharge (parameter 00060, ft^3/s) for the carp app's gauges (leaf C4) is one more
-- `readings.param`. Same in-place widening as 0008_lionfish_ingest.sql: SQLite cannot alter a CHECK,
-- and the stored rows stay valid under the wider constraint.
pragma writable_schema = on;

update sqlite_schema
set sql = replace(sql, '''current_ms'', ''current_dir_deg''))', '''current_ms'', ''current_dir_deg'', ''discharge_cfs''))')
where type = 'table' and name = 'readings';

pragma writable_schema = reset;

create table schema_cookie_bump (x integer);
drop table schema_cookie_bump;
