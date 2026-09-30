-- Feed-state lookups scan per source (T4 contract request).
create index alerts_source_onset on alerts(source_id, onset);
create index stations_source on stations(source_id);
