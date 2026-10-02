-- Vessels from AISStream.io (gates/leaf-GE4.md, docs/GODS_EYE.md GC4), carp and lionfish.
--
-- `vessels`: one row per MMSI, the latest static data (ShipStaticData / StaticDataReport) and
-- the name the position reports carry. `type` is the AIS ship-and-cargo type code (0-99); the
-- API maps it to a category (cargo, tanker, ...). `last_raw_object_id` is the archived payload
-- that last touched the row, for evidence.
--
-- `vessel_positions`: time series, thinned to at most one fix per vessel per minute (`minute`
-- = observed_at / 60000; the first fix of a minute wins), kept 30 days. `observed_at` is the
-- AISStream receive time (`MetaData.time_utc`), unix ms. sog in knots, cog and heading in
-- degrees true; null when the report says "not available".
create table vessels (
  mmsi integer primary key,
  name text,
  type integer,
  call_sign text,
  imo integer,
  destination text,
  length_m real,
  first_seen integer not null,
  last_seen integer not null,
  last_raw_object_id integer references raw_objects(id)
);

create table vessel_positions (
  mmsi integer not null,
  minute integer not null,
  observed_at integer not null,
  lat real not null,
  lon real not null,
  sog real,
  cog real,
  heading real,
  primary key (mmsi, minute)
) without rowid;

create index vessel_positions_observed_at on vessel_positions (observed_at);
