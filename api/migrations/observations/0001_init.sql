-- Observations store. Written only by the ingest module (PLAN.md C1).
-- Times are unix milliseconds (INTEGER) for cheap range scans.

create table sources (
  id text primary key,                      -- e.g. 'inat', 'goes19', 'nws'
  name text not null,
  homepage text not null,
  mode text not null check (mode in ('push', 'poll')),
  cadence_s integer not null,
  max_latency_s integer not null
);

create table raw_objects (
  id integer primary key,
  r2_key text not null unique,
  source_id text not null references sources(id),
  source_url text not null,
  fetched_at integer not null,
  bytes integer not null,
  sha256 text not null
);

create table fetch_runs (
  id integer primary key,
  source_id text not null references sources(id),
  fetched_at integer not null,
  received_at integer not null,
  status text not null check (status in ('ok', 'empty', 'error', 'partial')),
  http_status integer,
  rows_in integer not null default 0,
  raw_object_id integer references raw_objects(id),
  error text
);
create index fetch_runs_source_time on fetch_runs(source_id, fetched_at);

create table taxa (
  id integer primary key,                   -- 1 python, 4 lionfish (the apps' species)
  scientific_name text not null unique,
  common_name text not null,
  focus integer not null default 0
);
insert into taxa (id, scientific_name, common_name, focus) values
  (1, 'Python bivittatus', 'Burmese python', 1),
  (4, 'Pterois volitans/miles', 'Lionfish', 1);

create table sightings (
  id integer primary key,
  source_id text not null references sources(id),
  ext_id text not null,
  taxon_id integer not null references taxa(id),
  lat real not null,
  lon real not null,
  accuracy_m real,
  observed_at integer not null,
  quality text not null check (quality in ('research', 'needs_id', 'casual', 'curated')),
  photo_url text,
  raw_object_id integer references raw_objects(id),
  canonical_id integer references sightings(id),
  conflict integer not null default 0,
  ingested_at integer not null,
  unique (source_id, ext_id)
);
create index sightings_time on sightings(observed_at);
create index sightings_geo on sightings(lat, lon);
create index sightings_taxon_time on sightings(taxon_id, observed_at);

create table sighting_revisions (
  sighting_id integer not null references sightings(id),
  changed_at integer not null,
  field text not null,
  old text,
  new text
);
create index sighting_revisions_sighting on sighting_revisions(sighting_id);

create table stations (
  id integer primary key,
  source_id text not null references sources(id),
  ext_id text not null,
  name text not null,
  lat real not null,
  lon real not null,
  kind text not null check (kind in ('buoy', 'gage', 'tide', 'grid', 'goes_cell')),
  unique (source_id, ext_id)
);
create index stations_geo on stations(lat, lon);

create table readings (
  station_id integer not null references stations(id),
  param text not null check (param in ('lst_c', 'air_c', 'water_c', 'sst_c', 'rain_mm', 'stage_m', 'wave_m', 'wind_ms', 'fire_frp')),
  value real,
  flag text not null default 'ok' check (flag in ('ok', 'cloud', 'bad_dqf', 'missing')),
  observed_at integer not null,
  origin text not null check (origin in ('measured', 'satellite', 'modeled')),
  raw_object_id integer references raw_objects(id),
  conflict integer not null default 0,
  primary key (station_id, param, observed_at, origin)
) without rowid;
create index readings_time on readings(observed_at);

create table alerts (
  id integer primary key,
  source_id text not null references sources(id),
  ext_id text not null unique,
  event text not null,
  severity text not null,
  headline text,
  area_geojson text,
  onset integer,
  expires integer,
  raw_object_id integer references raw_objects(id)
);
create index alerts_window on alerts(onset, expires);

create table frames (
  frame_at integer primary key,
  payload blob not null,
  built_at integer not null
);

create table cursors (
  source_id text primary key references sources(id),
  cursor text not null,
  updated_at integer not null
);
