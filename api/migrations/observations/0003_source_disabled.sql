-- Why a registered source is not running (missing secrets, INVERSA_SOURCES=off); null while it runs.
-- The scheduler sets it at boot; feed state reports such a source as down with this as the note.
alter table sources add column disabled_reason text;
