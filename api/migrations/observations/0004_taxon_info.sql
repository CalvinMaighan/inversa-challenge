-- Taxon enrichment (T44): every species is a first-class sighting. The iNat adapter writes
-- `inat_taxon_id` and `iconic_group` at ingest; `taxon_info` fills the rest from GET /v1/taxa/<ids>
-- (batches of 30, about 1 request per second) and stamps `fetched_at`.
--
-- iconic_group: Reptilia, Amphibia, Aves, Mammalia, Actinopterygii, Mollusca, Insecta, Arachnida,
-- Plantae, Fungi or other; null until the taxon has been seen in an iNat payload or enriched.
alter table taxa add column inat_taxon_id integer;
alter table taxa add column iconic_group text;
-- Wikipedia summary as plain text, at most two sentences, HTML stripped.
alter table taxa add column summary_plain text;
-- iNat default photo (medium size), proxied as /v1/media/taxon/<id>.
alter table taxa add column photo_url text;
alter table taxa add column wikipedia_url text;
alter table taxa add column fetched_at integer;
create index taxa_inat on taxa(inat_taxon_id);
create index taxa_group on taxa(iconic_group);

update taxa set inat_taxon_id = 238252, iconic_group = 'Reptilia' where id = 1;
update taxa set inat_taxon_id = 47284, iconic_group = 'Actinopterygii' where id = 4;
