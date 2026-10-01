-- Bitemporal river forecast and alert store for the carp (kind=conditions) app (PLAN.md C-A1,
-- docs/APPS.md "replay what was known at the time", gates/leaf-C3.md). Written only by the
-- forecast store (api/src/forecast/store.rs); the NWPS/IEM/NWS adapters (C4) call it.
--
-- Every row keeps its times apart, all unix milliseconds UTC:
--   issued_at    when the forecast was published (NWPS `issuedTime`, HML product time)
--   valid_at     when a forecast point applies (valid_from/valid_to on the snapshot)
--   observed_at  when a measurement was taken
--   ingested_at  when this process stored the row
-- Provenance: source is 'nwps-live' (captured by our poller), 'iem-archive' (backfilled from
-- the Iowa Environmental Mesonet HML archive) or 'nws-gridpoint'; payload_hash is the sha256
-- of the payload the row came from.
--
-- Idempotency: the same (site, product, issued_at, payload_hash) is stored once. A different
-- payload with the same issued_at is a revision (revision = 1, 2, ...), kept next to the first.
-- Site ids are NWPS lids (`locations[].nwps` in spec/apps/carp.json).

create table forecast_snapshots (
  id integer primary key,
  site text not null,
  product text not null,
  issued_at integer not null,
  ingested_at integer not null,
  source text not null check (source in ('nwps-live', 'iem-archive', 'nws-gridpoint')),
  payload_hash text not null,
  revision integer not null default 0,
  valid_from integer,
  valid_to integer,
  horizon_end integer,
  unique (site, product, issued_at, payload_hash)
);
-- as-of: greatest issued_at <= t for a site, then ingested_at filter; both columns in the index.
create index forecast_snapshots_asof on forecast_snapshots(site, issued_at, ingested_at);

create table forecast_points (
  snapshot_id integer not null references forecast_snapshots(id) on delete cascade,
  valid_at integer not null,
  stage_ft real,
  flow_kcfs real,
  -- Flood category of stage_ft against the NWPS thresholds known when the row was stored:
  -- none, action, minor, moderate, major; null when stage or thresholds were missing.
  category text check (category is null or category in ('none', 'action', 'minor', 'moderate', 'major')),
  primary key (snapshot_id, valid_at)
) without rowid;

-- NWPS observed stage/flow (the datum the flood categories are defined on; USGS stage can sit on
-- a different datum, see docs/evidence/carp-data-proof.md). First ingest of an observed_at wins.
create table forecast_observations (
  site text not null,
  observed_at integer not null,
  stage_ft real,
  flow_kcfs real,
  source text not null check (source in ('nwps-live', 'iem-archive', 'nws-gridpoint')),
  ingested_at integer not null,
  primary key (site, observed_at)
) without rowid;

-- NWPS flood categories per site, in NWPS stage feet; null = not defined (-9999 in the feed).
-- One row per change, so an as-of view uses the thresholds known at the time.
create table forecast_thresholds (
  site text not null,
  ingested_at integer not null,
  action_ft real,
  minor_ft real,
  moderate_ft real,
  major_ft real,
  primary key (site, ingested_at)
) without rowid;

-- NWS alerts as seen at each site over time. A row is one (site, alert, payload) version:
-- first_seen when it first appeared in a poll, last_seen the newest poll that still listed it,
-- ended_at the poll time it was first missing (null while active).
create table alert_snapshots (
  id integer primary key,
  site text not null,
  ext_id text not null,
  event text not null,
  severity text not null,
  headline text,
  onset integer,
  expires integer,
  source text not null check (source in ('nwps-live', 'iem-archive', 'nws-gridpoint')),
  payload_hash text not null,
  first_seen integer not null,
  last_seen integer not null,
  ended_at integer,
  unique (site, ext_id, payload_hash)
);
create index alert_snapshots_site_window on alert_snapshots(site, first_seen, ended_at);
