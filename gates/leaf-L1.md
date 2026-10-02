# Gates: L1 lionfish data proof

Scope: prove the data works before any rewrite. Write `scripts/probe-lionfish.ts` (bun, no API keys beyond what Doppler `inversa/dev` already gives) and `docs/evidence/data-proof.md`. Do not edit other files. Do not commit.

Candidate areas (tune the bboxes to where data actually is): Florida Keys/South Florida, Mexican Caribbean (Quintana Roo, Banco Chinchorro), Belize, Colombian Caribbean (San Andrés/Providencia, Cartagena coast). Species: *Pterois volitans/miles* (iNat taxon `Pterois`, introduced=true; GBIF and NAS equivalents).

- [x] G1: for each area, the probe prints counts of lionfish records over the last 7, 30 and 90 days from iNaturalist, and all-time from GBIF and USGS NAS, plus the newest observed date and newest created date; line format `AREA <id> inat7=<n> inat30=<n> inat90=<n> gbif=<n> nas=<n> newest_obs=<date> newest_created=<date>`
  CHECK: bun scripts/probe-lionfish.ts 2>&1 | grep -c "^AREA "
  EXPECT: /^4$/
  EVIDENCE: `4` (run 2026-10-01 ~04:50Z)
    AREA fl inat7=0 inat30=3 inat90=21 gbif=2510 nas=3691 newest_obs=2026-09-18 newest_created=2026-09-26
    AREA mx inat7=5 inat30=8 inat90=24 gbif=441 nas=319 newest_obs=2026-09-28 newest_created=2026-09-30
    AREA bz inat7=0 inat30=0 inat90=1 gbif=151 nas=33 newest_obs=2026-07-23 newest_created=2026-08-05
    AREA co inat7=2 inat30=2 inat90=4 gbif=310 nas=47 newest_obs=2026-09-29 newest_created=2026-09-29

- [x] G2: NOAA Coral Reef Watch is fetched for a point in each area (SST, SST anomaly, bleaching heat stress / DHW, 5 km daily); the probe prints `CRW <id> date=<d> sst=<v> anomaly=<v> dhw=<v> url=<u>` with real values and the exact endpoint and format used (ERDDAP or NetCDF/THREDDS)
  CHECK: bun scripts/probe-lionfish.ts 2>&1 | grep -c "^CRW .* dhw=-\?[0-9]"
  EXPECT: /^4$/
  EVIDENCE: `4`; format=ERDDAP-griddap-json, url=https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json?CRW_SST[(last)][(lat)][(lon)],... (coastwatch NOAA_DHW 302s here)
    CRW fl date=2026-09-29 sst=30.04 anomaly=1.52 dhw=13.65 baa=1
    CRW mx date=2026-09-29 sst=29.88 anomaly=1.24 dhw=7.8500000000000005 baa=3
    CRW bz date=2026-09-29 sst=29.85 anomaly=1.18 dhw=5.28 baa=3
    CRW co date=2026-09-29 sst=29.48 anomaly=1.12 dhw=0.93 baa=2

- [x] G3: Open-Meteo Marine returns wave height, wave period and ocean current velocity/direction for a point in each area; `MARINE <id> wave=<m> current=<v> hours=<n>`
  CHECK: bun scripts/probe-lionfish.ts 2>&1 | grep -c "^MARINE .* current=[0-9]"
  EXPECT: /^4$/
  EVIDENCE: `4` (current unit km/h; period_s and current_dir also printed)
    MARINE fl wave=0.86 current=0.4 hours=72
    MARINE mx wave=1.16 current=0.8 hours=72
    MARINE bz wave=1.02 current=1 hours=72
    MARINE co wave=1.02 current=1.9 hours=72

- [x] G4: coverage of the other existing sources per area is recorded (NAS outside Florida, NDBC/CO-OPS buoys with SST near each area, GOES-19 SST sector coverage); `COVER <id> nas=<yes|no> buoys=<n> goes_sst=<yes|no>`
  CHECK: bun scripts/probe-lionfish.ts 2>&1 | grep -c "^COVER "
  EXPECT: /^4$/
  EVIDENCE: `4`
    COVER fl nas=yes buoys=55 goes_sst=yes
    COVER mx nas=yes buoys=0 goes_sst=yes
    COVER bz nas=yes buoys=0 goes_sst=yes
    COVER co nas=yes buoys=1 goes_sst=yes

- [x] G5: `docs/evidence/data-proof.md` has: a table per area (counts above), the final recommended bbox per area (west,south,east,north) with a reason, a verdict per area (keep / thin / cut) with the density threshold used, the duplicate overlap measured between iNat and GBIF for one area (matching ids or coordinates+dates, a number), the observed-vs-created lag distribution from iNat (median and p90 in days), and any licence or rate-limit constraint found for CRW
  EVIDENCE: data-proof.md sections "Counts per area" (4 tables), "Recommended bboxes", "Verdict" (threshold iNat obs in 90 d: >=10 keep, 1-9 thin, 0 + no GBIF 90 d cut; fl keep, mx keep, bz thin, co thin), "Duplicates" (fl 14 of 18 RG iNat ids found in GBIF iNat dataset; mx 26 of 35; GBIF share from iNat bz 90.7%), "Observed vs submitted lag" (all n=74 median 5 d, p90 2099 d), "NOAA Coral Reef Watch" (licence: credit CRW + DOI, OSTIA 1985-2002 academic clause; no published rate limit, no rate headers)

- [x] G6: honest gaps are listed: which areas are sparse and the proposed fallback (reduce geography before adding feeds). If an area has fewer than 5 iNat records in 90 days, it is marked thin and justified, not hidden
  EVIDENCE: data-proof.md "Gaps and fallback": bz thin (inat90=1), co thin (inat90=4), fl inat7=0 caveat, no buoys outside FL; fallback keeps fl+mx primary, merges bz into mx as "Mesoamerican Reef" (26 iNat in 90 d), keeps co labelled thin or cuts it, no feed added
