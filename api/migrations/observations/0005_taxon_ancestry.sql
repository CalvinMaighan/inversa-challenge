-- Taxon ancestry (T44 categories): the iNat `ancestor_ids` of each taxon as a JSON array of integers,
-- from the observation's taxon at ingest or from GET /v1/taxa. The web app derives the category
-- (snakes, lizards, turtles, ...) from it (apps/web/shared/species-categories.ts); null until known.
alter table taxa add column ancestor_ids text;

-- The focus seeds: Python bivittatus, Pterois (iNat, 2026-10-01).
update taxa set ancestor_ids = '[48460,1,2,355675,26036,26172,85553,67532,32149]' where id = 1;
update taxa set ancestor_ids = '[48460,1,2,355675,47178,1632273,47233,1303568,47285,788499]' where id = 4;
