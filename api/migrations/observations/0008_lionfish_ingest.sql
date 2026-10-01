-- Lionfish ingest (L4, gates/leaf-L4.md).
--
-- 1. `sightings.submitted_at`: when the record reached its source (iNat `created_at`), next to
--    `observed_at` (when the animal was seen). Measured lag is median 5 d, p90 2099 d
--    (docs/evidence/data-proof.md), so windows count by `observed_at` and "newly submitted" is a
--    separate filter on this column. Null for sources without a submission time (GBIF, NAS).
-- 2. Marine forecast params on `readings`: wave period (s), ocean current speed (m/s, converted
--    from Open-Meteo's km/h) and direction (degrees, the direction the current flows towards).
-- 3. `marine_forecasts`: every Open-Meteo Marine value with the model run it came from, so a
--    forecast can be replayed as it was issued. `readings` keeps the latest run only.
alter table sightings add column submitted_at integer;
create index sightings_submitted on sightings(submitted_at);

pragma writable_schema = on;

update sqlite_schema
set sql = replace(sql, '''dhw'', ''baa''))', '''dhw'', ''baa'', ''wave_period_s'', ''current_ms'', ''current_dir_deg''))')
where type = 'table' and name = 'readings';

pragma writable_schema = reset;

create table marine_forecasts (
  station_id integer not null references stations(id),
  param text not null check (param in ('wave_m', 'wave_period_s', 'current_ms', 'current_dir_deg')),
  -- Model run initialisation time (Open-Meteo `meta.json` `last_run_initialisation_time`), unix ms.
  issued_at integer not null,
  valid_at integer not null,
  value real,
  -- Unit of `value` as stored, and the unit the provider sent (a conversion is visible).
  unit text not null,
  source_unit text not null,
  model text not null,
  raw_object_id integer references raw_objects(id),
  primary key (station_id, param, issued_at, valid_at)
) without rowid;
create index marine_forecasts_valid on marine_forecasts(valid_at);
