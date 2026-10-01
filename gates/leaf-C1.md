# Gates: C1 carp data proof

Scope: prove the Louisiana carp data works before any build. Write `scripts/probe-carp.ts` (bun, no keys unless Doppler `inversa/dev` provides them) and `docs/evidence/carp-data-proof.md`. Do not edit other files. Do not commit. Use real live calls only.

Context: app question is "How have river and weather conditions changed around candidate carp-removal locations, and which need operational review today?". Feeds: USGS Water (stage 00065, discharge 00060, history), NOAA NWPS (api.water.noaa.gov/nwps/v1: gauge metadata, flood categories, stage/flow forecasts), NWS (api.weather.gov forecasts and alerts). Candidate region: Louisiana rivers (Mississippi, Atchafalaya, Red, Ouachita, Pearl, Vermilion/Bayou systems). Invasive carp (bighead, silver, grass, common) are a Louisiana concern; reported program L'CARP (May 2026) is UNVERIFIED.

- [ ] G1: choose 5 to 8 sites where all three feeds exist. For each, the probe prints `SITE <id> name=<n> lat=<lat> lon=<lon> usgs=<siteno|none> nwps=<lid|none> nws=<office/grid|none> stage_ok=<yes|no> disch_ok=<yes|no> fcst_ok=<yes|no> flood_cats=<yes|no>` with real identifiers; at least 5 lines have usgs, nwps, nws all set and fcst_ok=yes
  CHECK: bun scripts/probe-carp.ts 2>&1 | grep "^SITE " | grep -v "usgs=none" | grep -v "nwps=none" | grep -v "nws=none" | grep -c "fcst_ok=yes"
  EXPECT: /^[5-8]$/
  EVIDENCE: pending

- [ ] G2: for each chosen site the probe fetches the last 7 days of USGS observations and prints `OBS <id> n=<count> newest=<ts> stage_ft=<v> disch_cfs=<v> change24h_ft=<v>`; newest is within 6 hours of run time for at least 5 sites
  CHECK: bun scripts/probe-carp.ts 2>&1 | grep -c "^OBS "
  EXPECT: /^[5-8]$/
  EVIDENCE: pending

- [ ] G3: NWPS forecast per site printed as `FCST <id> issued=<ts> valid_from=<ts> valid_to=<ts> points=<n> peak_ft=<v> category=<none|action|minor|moderate|major>`; the doc records the forecast issuance cadence observed (two fetches at least 10 minutes apart or the documented cadence with URL) and states whether any historical forecast archive exists (cite the NWPS docs URL and what was tested)
  CHECK: bun scripts/probe-carp.ts 2>&1 | grep -c "^FCST "
  EXPECT: /^[5-8]$/
  EVIDENCE: pending

- [ ] G4: NWS: for each site the probe prints `NWS <id> forecast_updated=<ts> periods=<n> alerts=<n>` and the doc records whether NWS offers push for alerts (NWWS-OI, CAP feeds, any webhook) with URLs
  CHECK: bun scripts/probe-carp.ts 2>&1 | grep -c "^NWS "
  EXPECT: /^[5-8]$/
  EVIDENCE: pending

- [ ] G5: push options per feed are researched with real URLs and one test each where possible: USGS Water (any subscription/notification service, e.g. USGS Water Alert / WaterAlert, OGC API continuous), NWPS (any push), NWS (CAP, NWWS-OI, api.weather.gov alerts stream). Doc has a table feed, push available (yes/no), mechanism, URL, what you tested, verdict (use push / poll and why)
  EVIDENCE: pending

- [ ] G6: the claims from the ChatGPT research are checked with URLs and dates: L'CARP launch May 2026, Louisiana wildlife commission April 2026 agenda mention of Inversa, Origin "Detect, Deploy, Deliver". Each is marked VERIFIED (url, quote of fewer than 15 words), REFUTED, or UNVERIFIED
  EVIDENCE: pending

- [ ] G7: `docs/evidence/carp-data-proof.md` lists the final sites with coordinates and flood-category thresholds (action, minor, moderate, major stage in ft), the recommended default map camera, a list of honest gaps (missing forecasts, gauge outages, stale data) with the proposed UI treatment, and any licence or rate limit constraint
  EVIDENCE: pending
