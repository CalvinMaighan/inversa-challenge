import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { init } from "@calvinjs/active-state";

import type { FeedState } from "shared/feed-state";

import { ExpertDetails, Summary } from "client/hud/drawer/EvidenceDrawer";
import type { Evidence } from "client/hud/drawer/evidence";
import { placeWords, plainSummary, qualityWords } from "client/hud/drawer/summary";
import { freshnessLines } from "client/hud/topbar/freshness";
import { AboutContent, ThemeChoices, TopBarView } from "client/hud/topbar/TopBar";
import { state } from "client/state";
import { emotionTheme } from "client/themes/theme";
import { nearestPlace } from "client/voice/gazetteer";

init(state);

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
/** Visible text of rendered markup: tags, inline style blocks and SVG stripped. */
const textOf = (markup: string) =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};

const NOW = Date.parse("2026-09-30T21:00:00Z");
const feed = (source: string, state: FeedState["state"], extra: Partial<FeedState> = {}): FeedState => ({
  source,
  mode: "poll",
  state,
  newestObservedAt: null,
  lastFetchAt: null,
  lastFetchRunId: null,
  lagSeconds: 120,
  note: null,
  ...extra,
});

describe("status popover", () => {
  test("status popover: the chrome is two icon buttons with popovers and no visible text", () => {
    const markup = html(<TopBarView focus={false} onFocus={noop} helpOpen={false} onHelp={noop} feeds={[feed("inat", "down")]} mode="dark" onTheme={noop} />);
    const triggers = [...markup.matchAll(/<button[^>]*aria-haspopup="dialog"[^>]*>/g)];
    expect(triggers).toHaveLength(2);
    expect([...markup.matchAll(/<button\b/g)]).toHaveLength(2);
    expect(markup).toContain('data-testid="status-button"');
    expect(markup).toContain('data-testid="theme-button"');
    expect(textOf(markup)).toBe("");
    // Feeds, theme, focus and help are not on the bar: they live in the popovers.
    for (const gone of ["data-feed", 'role="radiogroup"', "data-help-button", "aria-pressed", "Everglades Ops", "LIVE", "CURSOR"]) expect(markup).not.toContain(gone);
  });

  test("status popover: About holds plain freshness, Focus, Help, the data sources (worst first) and the expert layers", () => {
    const list = [
      feed("usgs", "nominal"),
      feed("inat", "lagging", { lastFetchAt: "2026-09-30T20:54:00Z", newestObservedAt: "2026-09-30T19:00:00Z", note: "upstream slow" }),
      feed("nws", "down", { note: "HTTP 503" }),
    ];
    const markup = html(<AboutContent list={list} nowMs={NOW} focus={false} onFocus={noop} helpOpen={false} onHelp={noop} />);
    const text = textOf(markup);
    expect(text).toContain("Sightings checked 6 min ago.");
    expect(text).toContain("Newest sighting reported 2 h ago.");
    expect(text).toContain("iNaturalist is running late");
    expect(markup).toContain('data-help-button=""');
    expect(markup).toContain('aria-pressed="false"');
    expect(text).toContain("Focus");
    // Technical health is collapsed under "Data sources", worst feed first.
    const sources = markup.slice(markup.indexOf('data-testid="data-sources"'));
    expect(sources.startsWith('data-testid="data-sources">')).toBe(true);
    expect([...sources.matchAll(/data-feed="(\w+)"/g)].map((m) => m[1])).toEqual(["nws", "inat", "usgs"]);
    expect(markup).toContain("More data (for experts)");
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    const themes = html(<ThemeChoices mode="dark" onPick={noop} />);
    expect([...themes.matchAll(/role="radio"/g)]).toHaveLength(3);
    expect(themes).toMatch(/aria-checked="true"[^>]*>Dark</);
  });

  test("status popover: freshness reads in plain words, never feed jargon", () => {
    expect(freshnessLines([], NOW)).toEqual(["Waiting for the first data status."]);
    const lines = freshnessLines([feed("inat", "nominal", { lastFetchAt: "2026-09-30T20:59:30Z" }), feed("coops", "stale")], NOW);
    expect(lines).toEqual(["Sightings checked just now.", "Weather and water data: 1 of 1 sources delayed or offline."]);
    for (const line of lines) expect(line).not.toMatch(/LAGGING|STALE|nominal|poll|push/);
  });
});

const sighting: Evidence = {
  id: "sighting:48213",
  kind: "sighting",
  record: {
    id: "48213",
    source: "inat",
    extId: "335508189",
    taxon: { id: "3", scientificName: "Iguana iguana", commonName: "Green iguana" },
    lat: 25.7231,
    lon: -80.2695,
    observedAt: "2026-09-30T19:00:00.000Z",
    quality: "research",
    photoUrl: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg",
    mediaUrl: "/v1/media/48213",
  },
  raw: { id: 335508189, quality_grade: "research" },
  rawKey: "raw/inat/2026/09/30/0412.json.gz",
  sourceUrl: "https://api.inaturalist.org/v1/observations?id=335508189",
  sourcePageUrl: "https://www.inaturalist.org/observations/335508189",
  fetchedAt: "2026-09-30T19:09:00.000Z",
  ingestLagSeconds: 540,
  feed: null,
  links: [],
};

describe("plain evidence summary", () => {
  test("plain evidence summary: what, where in place words, when, how sure, and the photo", () => {
    const s = plainSummary("sighting", sighting.record, NOW)!;
    expect(s.line).toBe("Green iguana spotted near Coral Gables · 2 h ago · confirmed by the iNaturalist community");
    expect(s.photo).toBe("/v1/media/48213");
    expect(s.line).not.toMatch(/\d+\.\d{3}/); // never raw coordinates
    expect(plainSummary("sighting", { ...sighting.record, mediaUrl: null, quality: "needs_id", source: "gbif" }, NOW)!.line).toBe(
      "Green iguana spotted near Coral Gables · 2 h ago · needs ID (not yet confirmed)",
    );
    expect(plainSummary("fetch", { id: "9004", source: "inat", fetchedAt: "2026-09-30T20:50:00Z", rowsIn: 12, error: null }, NOW)!.line).toBe("Data check of iNaturalist · 10 min ago · 12 records received");
    expect(plainSummary("backtest", { species: "python" }, NOW)).toBeNull();
  });

  test("plain evidence summary: quality words, place words and the nearest-place lookup", () => {
    expect(qualityWords("research", "inat")).toBe("confirmed by the iNaturalist community");
    expect(qualityWords("research", "gbif")).toBe("community-confirmed");
    expect(qualityWords("curated", "nas")).toBe("official record");
    expect(qualityWords("casual", "inat")).toBe("casual record (unconfirmed)");
    expect(placeWords(25.47, -80.48)).toBe("near Homestead");
    expect(placeWords(26.3, -81.0)).toBe("in South Florida");
    expect(placeWords("25.7", -80.2)).toBe("in South Florida");
    expect(nearestPlace(25.7215, -80.2684)?.name).toBe("Coral Gables");
    // The national park is an area, never "near".
    expect(nearestPlace(25.3, -80.85)?.name).not.toBe("Everglades National Park");
  });

  test("plain evidence summary: the card leads with it; the raw record and payload sit in a collapsed Details for experts", () => {
    const lead = html(<Summary kind="sighting" evidence={sighting} atMs={NOW} />);
    expect(lead).toContain("<h3>Green iguana spotted near Coral Gables</h3>");
    expect(lead).toContain('src="/v1/media/48213"');
    expect(lead).not.toContain("48213<"); // no id in the lead
    const expert = html(<ExpertDetails id={sighting.id} evidence={sighting} />).replace(/<style[\s\S]*?<\/style>/g, "");
    expect(expert).toMatch(/^<details[^>]*data-testid="drawer-expert"/);
    expect(expert).not.toMatch(/^<details[^>]*\sopen/);
    expect(expert).toContain("<summary>Details for experts</summary>");
    expect(expert).toMatch(/data-testid="hud-drawer-id"[^>]*>sighting:48213</);
    expect(expert).toContain('aria-label="Normalized record"');
    expect(expert).toContain('aria-label="Raw payload"');
    expect(expert).toContain("raw/inat/2026/09/30/0412.json.gz");
  });
});
