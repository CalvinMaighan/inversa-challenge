-- Asian carp sightings for the carp map (silver, bighead, grass and black carp in the Mississippi River Basin),
-- merged from iNaturalist, GBIF (without its copy of iNaturalist's own records) and USGS NAS by `carp_fish`.
-- One row per upstream record; `date` is the observed day (YYYY-MM-DD), null when the source gives none.
-- Only the carp app fills it; the map reads it through GET /v1/carp/sightings instead of calling the three
-- upstream APIs on every visit.
create table carp_sightings (
  id text primary key,
  source text not null,
  species text not null,
  scientific_name text not null,
  lat real not null,
  lon real not null,
  date text,
  url text not null,
  photo text,
  fetched_at integer not null
);

create index carp_sightings_date on carp_sightings (date);
