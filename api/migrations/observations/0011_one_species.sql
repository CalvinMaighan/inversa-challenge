-- R14 (K1): three apps, one species each. Taxa 2 and 3 were seeded for species no app tracks any
-- more; they go with their sightings (a no-op on a fresh database, whose seed is 1 and 4 only).
-- Taxon 4 (lionfish) is the lionfish app's own species, so it is not deleted here: every app drops
-- the rows of taxa outside its config at boot (`App::resolve_taxa`), which removes it from the
-- python database and the python row from the lionfish one.
delete from sighting_revisions where sighting_id in (select id from sightings where taxon_id in (2, 3));
update sightings set canonical_id = null where canonical_id in (select id from sightings where taxon_id in (2, 3));
delete from sightings where taxon_id in (2, 3);
delete from taxa where id in (2, 3);
-- Stored frames may hold the deleted records; they rebuild on demand.
delete from frames;

-- T44 enrichment of arbitrary taxa (summary, photo, Wikipedia link, iconic group, ancestry) is gone.
drop index if exists taxa_group;
alter table taxa drop column iconic_group;
alter table taxa drop column summary_plain;
alter table taxa drop column photo_url;
alter table taxa drop column wikipedia_url;
alter table taxa drop column fetched_at;
alter table taxa drop column ancestor_ids;
