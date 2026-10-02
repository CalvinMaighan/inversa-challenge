-- NWS gridpoint precipitation and gusts (gates/leaf-FX.md, carp): two more `readings.param`
-- values written by the gridpoint adapter (api/src/ingest/poll/nws_forecast.rs):
--   pop_pct       probability of precipitation, percent, per 12 h forecast period
--   wind_gust_ms  wind gust, m/s (the raw grid's km/h converted), per hour
-- QPF reuses `rain_mm` (an amount over the raw grid's 6 h window starting at observed_at).
-- Same in-place widening as 0009_discharge.sql: SQLite cannot alter a CHECK, and the stored
-- rows stay valid under the wider constraint.
pragma writable_schema = on;

update sqlite_schema
set sql = replace(sql, '''current_ms'', ''current_dir_deg'', ''discharge_cfs''))', '''current_ms'', ''current_dir_deg'', ''discharge_cfs'', ''pop_pct'', ''wind_gust_ms''))')
where type = 'table' and name = 'readings';

pragma writable_schema = reset;

create table schema_cookie_bump (x integer);
drop table schema_cookie_bump;
