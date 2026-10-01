# Gates: T40 chat-left layout, layers legend, globe tooltips, help (opus)

Scope (user: "what are the blue dots, and what are all of the options? Let's keep the chat open on the left side fully with globe on the right side"):
- Two panes. The left column is about 420 px wide, resizable from 360 to 560 px, with the width kept in localStorage. It is full height and always open, with Agent | Missions tabs and an unread dot on the inactive tab. It holds the chat thread (data panels, citations, tool rows) and a composer with mic and send buttons. The globe fills the right pane, and the top bar, timeline and drawer sit inside that pane. The orb and morph card are deleted. Expand pops out next to the column, over the left part of the globe pane and clear of its centre. Under 768 px the column becomes a bottom sheet with three snap points: collapsed, half and full.
- `client/hud/legend/**`: a Layers button and collapsible panel at the top right of the globe pane. It has one row per layer with toggles, swatches, ramps and live counts from `GlobeApi.stats()`, plus a data-gaps row.
- Globe hover tooltips. Picks are throttled to one per animation frame, and each marker shows a label and a key value.
- A "?" help sheet whose content comes from one data file. The first visit also shows a hint line with example-question chips.
- The e2e harnesses and the T14/T38 gates are moved to the new layout, the four screenshots are retaken, and README and the demo script are updated.
- No mock anything: the agent uses real OpenRouter `openai/gpt-6-luna` through Doppler `inversa`/`dev`.

- [x] G1: unit tests for the legend, layout, unread, tooltip and help logic pass (≥20 tests)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/hud/legend tests/client/hud/tooltip tests/client/hud/help tests/client/agent/layout 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([2-9][0-9]|[1-9][0-9]{2,}) pass\s+0 fail/
  EVIDENCE: 40 pass | 0 fail

- [x] G2: the whole web unit suite passes (0 fail)
  CHECK: cd apps/web && bun run test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 620 pass | 0 fail

- [x] G3: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [x] G4: `next build` succeeds
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && echo BUILD-OK
  EXPECT: BUILD-OK
  EVIDENCE: BUILD-OK

- [x] G5: the orb and morph code is gone. No file or selector still names it, and the page mounts the chat column.
  CHECK: cd apps/web && test ! -e client/agent/morph && test ! -e client/agent/orb.styled.ts && test ! -e client/agent/orb-phase.ts && ! grep -rqE "data-agent-orb|RectMorphPortal|useRectMorph|data-agent-card|open agent chat" client app e2e && grep -q "AgentColumn" app/page.tsx && echo NO-ORB
  EXPECT: NO-ORB
  EVIDENCE: NO-ORB

- [x] G6: e2e:layout on the real stack (Axum fixtures, next start, Chromium). It checks:
  - the chat column is visible at load, with the globe to its right (bounding boxes);
  - the legend toggles change `LAYERS` and the globe layer stats;
  - a hover over a known station shows the tooltip;
  - the Missions tab switches;
  - the mobile sheet works at 375 px.
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep "^LAYOUT"
  EXPECT: /^LAYOUT chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok$/m
  EVIDENCE: LAYOUT chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok

- [x] G7: e2e:agent live (GPT-6 Luna) on the chat column prints FLOW-OK
  CHECK: cd apps/web && bun run e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK

- [x] G8: e2e:panels live on the new layout: tables, series, brackets, and the drawer from a row click
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run e2e:panels 2>&1 | grep -E "^PANELS "
  EXPECT: /^PANELS table=[1-9]\d* series=[1-9]\d* brackets=[1-9]\d* drawer=1$/m
  EVIDENCE: PANELS table=1 series=8 brackets=10 drawer=1

- [x] G9: e2e:convo live on the chat column
  CHECK: cd apps/web && bun run e2e:convo 2>&1 | tail -1
  EXPECT: CONVO-OK
  EVIDENCE: CONVO-OK

- [x] G10: e2e:team with missions in the Missions tab
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep -E "^TEAM |COUNTERS-OK OFFLINE-OK"
  EXPECT: /TEAM rtc_p50=[0-9.]+ ws_p50=[0-9.]+ converged=1[\s\S]*COUNTERS-OK OFFLINE-OK/
  EVIDENCE: TEAM rtc_p50=19 ws_p50=90 converged=1 | COUNTERS-OK OFFLINE-OK

- [x] G11: e2e:client on the new layout (isolation, frames, cold snap)
  CHECK: cd apps/web && bun run e2e:client 2>&1 | grep -E "^(CLIENT|COLDSNAP)"
  EXPECT: /CLIENT isolated=true frames>0 errors=0[\s\S]*COLDSNAP .*badge=REPLAY date=2026-02-01 errors=0/
  EVIDENCE: CLIENT isolated=true frames>0 errors=0 | COLDSNAP at=2026-02-01T17:00:00.000Z window=2026-01-17T17:00:00.000Z..2026-02-16T17:00:00.000Z iguana=1.58 max=2.00 sightings=6 globe_sightings=40 globe_hotspo

- [x] G12: e2e:live on the new layout
  CHECK: cd apps/web && bun run e2e:live 2>&1 | grep "^LIVE"
  EXPECT: /^LIVE sighting_ms=\d+ alert_ms=\d+ sparkline_ms=\d+ feed_ms=\d+ reload=0$/m
  EVIDENCE: LIVE sighting_ms=5088 alert_ms=6768 sparkline_ms=5088 feed_ms=7711 reload=0

- [x] G13: the docs describe the new UI. README's UI section names the chat column, the Layers legend and the help sheet, and the demo script no longer mentions the orb.
  CHECK: grep -q "chat column" README.md && grep -q "Layers" README.md && grep -q "help sheet" README.md && ! grep -qiw "orb" docs/demo-script.md && grep -q "Missions tab" docs/demo-script.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: DOCS-OK

- [x] G14: docs/evidence/layout-desktop.png at 1440×900 shows a real answer with its panels (manual; looked at)
  EVIDENCE: docs/evidence/layout-desktop.png, 1440×900 (sips), written by the G8 e2e:panels run with a real gpt-6-luna answer. Viewed:
  - The chat column is at x 0–420 with its AGENT and MISSIONS tabs. It holds the answer (Tamiami Canal readings, a data caveat about the down feeds, and citation chips 4–10).
  - "DATA · 3" shows the sightings table open (09-02 18:09Z Green iguana, research, inat, 25.554), plus collapsed water-level chart and readings panels. Source chips 1–10 follow, and the composer is at the bottom with the mic and send buttons.
  - The globe fills x 420–1440, framed on Homestead to Tamiami. It has 10 labelled brackets (SIGHTING Green iguana · research, READING Virginia Key 0.54 m, Tamiami ×2, and others). The top bar sits in 2 rows inside the pane, the Layers button is top right, and the timeline is at the bottom of the pane.

- [x] G15: docs/evidence/layout-legend.png shows the legend open (manual; looked at)
  EVIDENCE: docs/evidence/layout-legend.png, 1440×900, from e2e:layout (G6). Viewed: "LAYERS & LEGEND" is open at the top right of the globe pane. The rows:
  - Sightings, "0 drawn" (the fixtures are days old at the live edge), with the species rows Burmese python amber, Argentine tegu orange, Green iguana green, Red lionfish pink, and Other introduced species grey, each with a checkbox and a count.
  - Stations, "20 reporting": USGS gauge blue 14, NDBC buoy teal 4, NOAA tide gauge violet 2. The squares on the map match these colours.
  - Alerts, "5 in effect", with Extreme, Severe, Moderate and Minor swatches.
  - Hotspots, "341 cells", with a violet-to-yellow bar labelled low / heuristic score / high and a Species pin select.
  - Missions starts at the bottom edge. The body scrolls to Team cursors, LST and SST with their °C ramps, and Data gaps.

- [x] G16: docs/evidence/layout-tooltip.png shows a hover tooltip on a globe marker (manual; looked at)
  EVIDENCE: docs/evidence/layout-tooltip.png, 1440×900, from e2e:layout. Viewed: the camera is over USGS 11 near Lake Ingraham, with the blue square at about (930,450). The tooltip sits beside it and reads "USGS gauge · EAST SIDE CREEK NEAR LAKE INGRAHAM, FL · stage 0.24 m · 45 min ago", with the title in bold and the rest muted. e2e asserts that its evidence id is the station's reading id and that a click opens the drawer on that id.

- [x] G17: docs/evidence/layout-mobile.png at 375×812 shows the globe and the sheet (manual; looked at)
  EVIDENCE: docs/evidence/layout-mobile.png, 375×812, from e2e:layout. Viewed:
  - The globe is full width behind everything. The top bar has 3 rows: LIVE and "?" on the first, the clock, Focus and LIGHT/DARK/TAC on the second, and the feed chips on the third. The Layers button sits just below it.
  - The sheet is at half height (about y 406–812) with its grab handle and the AGENT | MISSIONS tabs, and the status reads "Agent ready".
  - The first-visit hint shows three example-question chips, and the composer with the mic and send buttons is at the bottom.
  - Nothing overflows the viewport at 375 px; the feed-chip row scrolls sideways, which is why the GOES chip is cut at the edge.

- [x] G18: the layout, legend, tooltip, sheet and help render in all three themes (light, dark, tactical) with no page errors. e2e:layout switches the themes and asserts that the text contrast of the column and legend is at least 4.5:1.
  CHECK: cd apps/web && E2E_SKIP_BUILD=1 bun run e2e:layout 2>&1 | grep "^THEMES"
  EXPECT: /^THEMES light=ok dark=ok tactical=ok$/m
  EVIDENCE: THEMES light=ok dark=ok tactical=ok
