# Three apps, one engine (draft, 2026-10-01)

One codebase, one UI shell, one species/program config unit per app (contract P1 in `PLAN.md`), chosen at runtime by the app selector below. Each app is vertically integrated: its own question, feeds, score, agent persona, helper questions, eval set and copy. Evaluate every app against `docs/TASK_BRIEF.md`.

| App | Role | Question | Status |
|---|---|---|---|
| **Carp** (Louisiana) | Main app, the default selection | How have river and weather conditions changed around candidate carp-removal locations, and which need operational review today? | Spec below, not started |
| **Lionfish Watch** | Second app | Where should we prioritize lionfish surveys, given recent sightings, reef heat stress and ocean conditions? | `docs/LIONFISH_WATCH.md`; L1 data proof running |
| **Python** (Everglades) | Third app | Where are Burmese pythons active and where should removal crews go next? | Existing build (T1–T44) becomes this config |

Build order: finish L1 and the lionfish pivot, extract the app config seam (L2) so python keeps working, then carp.

## Carp app: Louisiana Field Conditions Explorer (working name)

Source: ChatGPT research, 2026-10-01. **Unverified by us.** Before it goes in any doc, confirm: L'CARP launch (May 2026), the April 2026 wildlife commission agenda item, and Origin's Detect, Deploy, Deliver wording. Inversa's internal roadmap is unknown.

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
- One deployment at `inversa.calvinmaighan.dev` serves all three apps. Data is partitioned by app id (separate SQLite file per app under `INVERSA_DATA_DIR/<app>`), same schema, so apps cannot leak into each other. Pollers, frames and the agent are keyed by app id.
- **App selector:** a species icon button in the HUD opens a popover listing the apps (carp, lionfish, python) with icon, name, one-line question, feed-health dot. Selecting one swaps config, map preset, layers, helper questions, agent persona and timeline. Selection lives in the URL (`?app=carp`), so share links, replays and agent view-state carry it; default is carp; remembered per viewer in localStorage. Keyboard accessible, Escape returns focus, links in new tab like the rest of the chrome. Team (WebRTC) rooms are per app.
- Scope guard (P4) applies per app: out-of-scope species, areas or locations get a refusal naming what the app covers.
- PostGIS from the suggestion is still not adopted (SQLite stays). The "new technology" claim stays as already documented.
