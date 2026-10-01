# Gates: F1 feed audit and ingest-mode plan (opus)

Owns: `docs/ingest-modes.md`, `scripts/probe-push.ts` (optional). Docs only; do not edit code. Do not commit.

Policy to apply (user's words): use webhooks with real data feeds; poll only rich feeds that are useful and frequent and have no push API. Three apps only: carp (USGS Water, NWPS, NWS), lionfish (iNaturalist, NOAA CRW, Open-Meteo Marine, GBIF, USGS NAS, NDBC/CO-OPS buoys, GOES-19 SST), python (iNaturalist, GBIF, USGS NAS for Python bivittatus in the Everglades bbox, plus the existing physical feeds NWS, NWWS, GOES, NDBC, CO-OPS, USGS Water, Open-Meteo). Evidence already gathered: `docs/evidence/carp-data-proof.md` (no push for USGS/NWPS/NWS alerts; NWWS-OI needs an emailed application), `docs/evidence/data-proof.md`, `docs/research.md` section 7 (push-capable feeds).

- [ ] G1: `docs/ingest-modes.md` has one row per feed per app with: mechanism (`push`, `webhook`, `poll`), cadence, why, provider docs URL, latency to our DB, and licence or rate limit. Every `poll` row states why no push exists (what was searched, URL); every feed that does have push (GOES-19 SNS/SQS, NWWS-OI, anything else found, e.g. iNaturalist or GBIF webhooks/notification features, USGS/NWS CAP or Atom, NOAA CRW or Open-Meteo update notices) is used
  EVIDENCE: pending

- [ ] G2: the "emitter" design is specified for polled feeds: a scheduled job (Cloudflare Worker cron or the Rust scheduler) fetches, writes raw payload to the archive, and delivers through the signed `/v1/{app}/ingest/hook/{source}` webhook (HMAC) so every feed lands the same way; doc states which feeds use which emitter, retry and dedupe rules (idempotency key), and how freshness is reported to the UI. Websocket fan-out to clients is described per app (GraphQL subscriptions `feeds`, `framesUpdated`, `ops`)
  EVIDENCE: pending

- [ ] G3: dropped feeds are listed: every existing source that serves none of the three apps (check `api/src/ingest/**` and `docs/research.md`) is named with a removal note for task K1; every kept source is mapped to at least one app
  CHECK: grep -c "^| " docs/ingest-modes.md
  EXPECT: /^(2[0-9]|[3-9][0-9])$/
  EVIDENCE: pending

- [ ] G4: at least three claims about push availability are tested live and recorded (URL, request, response snippet under 15 words or status code), e.g. NWS alerts ATOM/CAP conditional GET, iNaturalist/GBIF webhook or subscription pages, CRW update cadence
  EVIDENCE: pending
