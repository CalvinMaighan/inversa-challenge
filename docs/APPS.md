# Three apps, one engine (spec, 2026-10-01; status updated for D1)

Status at D1 (2026-10-01): all three apps are built on the shared engine and pass their app-specific gates (carp: `gates/leaf-C3.md`, `leaf-C4.md`, `leaf-C5.md`, `leaf-UC.md`, `leaf-AG1.md`; lionfish: `gates/leaf-L3.md`, `leaf-L4.md`, `leaf-L5.md`, `leaf-UL.md`, `leaf-AG2.md`; python: the T-series gates and `gates/leaf-K1.md`). Open items per app are the PARTIAL and ABANDON rows of `docs/brief-compliance.md`. The sections below are the original spec, kept as written, with later results appended.

One codebase, one UI shell, one species/program config unit per app (contract P1 in `PLAN.md`), chosen at runtime by the app selector below. Each app is vertically integrated: its own question, feeds, score, agent persona, helper questions, eval set and copy. Evaluate every app against `docs/TASK_BRIEF.md`.

| App | Role | Question | Status |
|---|---|---|---|
| **Carp** (Louisiana) | Main app, the default selection | How have river and weather conditions changed around candidate carp-removal locations, and which need operational review today? | Built (C1 to C5, UC, AG1) |
| **Lionfish Watch** | Second app | Where should we prioritize lionfish surveys, given recent sightings, reef heat stress and ocean conditions? | Built (`docs/LIONFISH_WATCH.md`; L1 to L5, UL, AG2) |
| **Python** (Everglades) | Third app | Where are Burmese pythons active and where should removal crews go next? | Built (T1 to T44, then this config; K1 narrowed it to the Burmese python) |

Build order as planned: finish L1 and the lionfish pivot, extract the app config seam so python keeps working, then carp. Done in that order.

## Carp app: Louisiana Field Conditions Explorer (working name)

Source: ChatGPT research, 2026-10-01, unverified when this spec was written. Since verified by C1 with URLs (read 2026-10-01): L'CARP launched in May 2026 and is run by Inversa ([LDWF program page](https://www.wlf.louisiana.gov/page/louisiana-carp-removal-program)); the April 2026 commission agenda has an Inversa presentation as item 10 ([LDWF notice](https://www.wlf.louisiana.gov/news/louisiana-wildlife-and-fisheries-commission-to-meet-thursday-april-9-at-1000-am)); Origin's page shows Detect, Deploy, Deliver ([inversa.com/origin](https://inversa.com/origin)). Details and quotes: `docs/evidence/carp-data-proof.md` G6. Inversa's internal roadmap is unknown (unverified).

User: an operations manager planning fieldwork. Locations: a handful of river sites in Louisiana, labelled "demonstration locations" until Inversa supplies real operating areas.

### Feeds (three jobs)

| Feed | Contributes | Existing |
|---|---|---|
| USGS Water Data | Observed stage and discharge, history | `usgs.rs` exists: re-point to Louisiana sites |
| NOAA NWPS | River stage/flow forecasts, flood categories | **New adapter** |
| NWS | Forecasts and active alerts | `nws.rs` exists: re-point |

Optional additions only after those work: iNaturalist carp sightings (Hypophthalmichthys, Cyprinus), Open-Meteo, GOES-19. Gauge coverage and NWPS forecast availability per site must be checked first (L1-style data proof).

### Hero feature: replay what was known at the time

Bitemporal model. Four times kept apart on every record:

| Time | Meaning |
|---|---|
| Observation time | When a measurement was taken |
| Forecast issuance time | When a prediction was published |
| Forecast valid time | When it applies |
| Ingestion time | When we received it |

"Show me what we knew yesterday afternoon" uses yesterday's forecast version, and later observations appear separately to score that forecast. NWPS has no general forecast archive, so we snapshot forecasts and alerts from day one and state where replay coverage begins. USGS history can be backfilled. This reuses our existing `ingestedAt`, revisions and `as_of` machinery.

### Output and boundaries

- Output is "Needs review" with specific reasons and sources, per location.
- The feeds cannot establish carp abundance, expected catch, legal access or trip safety. UI and agent say so.
- UI: map with locations, alerts and freshness; timeline of observed vs forecast; chat that updates map and timeline; evidence drawer (readings, units, timestamps, issuance times, links); location briefing (changed, expected, missing).
- Example questions for the eval set: largest 24 h stage rise; compare two locations for tomorrow morning; why did this location start needing review; what did we know yesterday afternoon; which locations have stale forecasts.

### Future path (talking point only)

With Inversa's own data: operating locations and access constraints, crew and equipment, capture effort (CPUE vs conditions), mission history. Stated as a plausible integration path, not a claimed need.

## Shared engine implications

- App config selects feeds, areas, score, persona, eval and copy; the UI shell, agent runtime, timeline, evidence drawer, team features (WebRTC, WebSockets, GraphQL, active-state, workers, SQLite) are shared.
- One deployment at `inversa.bigvalue.lol` serves all three apps. Data is partitioned by app id (separate SQLite file per app under `INVERSA_DATA_DIR/<app>`), same schema, so apps cannot leak into each other. Pollers, frames and the agent are keyed by app id.
- **App selector:** a species icon button in the HUD opens a popover listing the apps (carp, lionfish, python) with icon, name, one-line question, feed-health dot. Selecting one swaps config, map preset, layers, helper questions, agent persona and timeline. Selection lives in the URL (`?app=carp`), so share links, replays and agent view-state carry it; default is carp; remembered per viewer in localStorage. Keyboard accessible, Escape returns focus, links in new tab like the rest of the chrome. Team (WebRTC) rooms are per app.
- Scope guard (P4) applies per app: out-of-scope species, areas or locations get a refusal naming what the app covers.
- PostGIS from the suggestion is still not adopted (SQLite stays). The "new technology" claim stays as already documented.

## C1 results (2026-10-01, verified: `gate-check --status gates/leaf-C1.md` 7 met; evidence `docs/evidence/carp-data-proof.md`)

- **Claims verified with URLs:** L'CARP launched May 2026 and is run by Inversa (LDWF program page); April 2026 commission agenda item 10 is an Inversa presentation; Origin page shows Detect, Deploy, Deliver. The "unverified" marks above are lifted, with the source URLs in the evidence doc.
- **Narrower than first thought:** L'CARP is active only in the **Atchafalaya Basin** and targets silver, grass, bighead and black carp (not common carp). Carp copy and scope guard say so. Camera presets: all sites (31.1, -91.1, zoom 7.5) and Atchafalaya (30.35, -91.55, zoom 8.5).
- **Eight sites, all with USGS + NWPS + NWS and forecasts:** SMML1, KRZL1, BLRL1, MCGL1 (Atchafalaya), BTRL1 (Mississippi, Baton Rouge), AEXL1 (Red, Alexandria), MLUL1 (Ouachita, Monroe), BXAL1 (Pearl, Bogalusa). Discharge missing at KRZL1, BLRL1, AEXL1.
- **Replay can be backfilled.** NWPS keeps no history (ignores `issuedTime`/`asOf`), but the Iowa Environmental Mesonet archives NWS river forecasts (7 issuances per site in 7 days). Replay coverage therefore starts well before our first snapshot; each snapshot records which source it came from (`nwps-live` or `iem-archive`).
- **Conflicts to show, not hide:** USGS and NWPS stage can differ by datum (KRZL1: 1.47 ft vs 3.92 ft); flow at Monroe disagrees 5.7x to 7x between sources. Flood categories use NWPS stage only; flow is always labelled with its source.
- **Forecast cadence:** one issuance per day (13:17Z–15:56Z); horizons 5 to 15 days.
- **Ingest modes:** none of USGS, NWPS, NWS offers push (WaterAlert is email/SMS; NWWS-OI needs an emailed application, 10+ days). Poll: USGS 15 min (one batched OGC request; anonymous rate limit), NWPS 30–60 min (store only when `issuedTime` changes), NWS alerts 1–2 min. Pollers run as scheduled jobs that deliver through the signed ingest hook.
- Only MCGL1 is at a flood category (action) today; no active NWS alerts in Louisiana. The demo needs a replay scene for an eventful day.
