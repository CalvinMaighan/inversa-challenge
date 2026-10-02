import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { init } from "@calvinjs/active-state";

import { BoardView } from "client/carp/Board";
import { briefing } from "client/carp/briefing";
import CarpTimeline from "client/carp/CarpTimeline";
import { usgsSeries } from "client/carp/model";
import { deriveReview } from "client/carp/review";
import { SiteDrawerView } from "client/carp/SiteDrawer";
import { exampleQuestions, helpEntries, welcome } from "client/hud/help/content";
import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { emotionTheme } from "client/themes/theme";

import { CARP_APP, NOW, site, SITES, snap, status, usgsReadings, ZONE } from "./fixtures";

init(state);

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
const textOf = (markup: string) =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const FORBIDDEN = /\b(python|lionfish|everglades)\b/i;
const noop = () => {};

const forecast = snap({ issuedAt: "2026-09-30T15:32:00Z", from: "2026-09-30T18:00:00Z", values: [3.6, 3.9, 4.0], peakStageFt: 4, peakAt: "2026-10-01T06:00:00Z", peakCategory: "ACTION" });

function renderAll(): string {
  const reviews = Object.fromEntries(
    SITES.map((s, i) => [s.lid, deriveReview({ site: s, asOfMs: NOW, live: true, zone: ZONE, status: i % 3 === 2 ? status({ observationFreshness: "STALE" }) : status(), forecast: i === 3 ? forecast : null, previous: null, usgs: usgsSeries([], s) })]),
  );
  const board = html(
    <BoardView app={CARP_APP} sites={SITES} reviews={reviews} selected="KRZL1" asOfMs={NOW - 86_400_000} reviewedAtMs={NOW} loading={false} error={null} presets={[{ id: "all-sites", name: "All sites" }, { id: "atchafalaya", name: "Atchafalaya Basin (L'CARP)" }]} activePreset={null} onPreset={noop} onSelect={noop} />,
  );
  const krz = site("KRZL1");
  const usgs = usgsSeries(usgsReadings(krz, [{ at: "2026-10-01T06:00:00Z", stageFt: 1.47 }]), krz);
  const review = reviews.KRZL1!;
  const drawer = html(
    <SiteDrawerView
      site={krz}
      asOfMs={NOW}
      live
      zone={ZONE}
      review={review}
      briefing={briefing({ site: krz, asOfMs: NOW, live: true, zone: ZONE, status: status(), forecast, previous: null, usgs, usgsWindow: usgs, alerts: [], alertsCheckedMs: NOW, weather: null, review })}
      status={status()}
      thresholds={status().thresholds}
      forecast={forecast}
      usgs={usgs}
      usgsWindow={usgs}
      alerts={[]}
      conflicts={[{ kind: "stage", usgsFt: 1.47, nwpsFt: 4.05, differenceFt: -2.58, atMs: NOW }]}
      weather={null}
      loading={false}
      error={null}
    />,
  );
  const timeline = html(
    <CarpTimeline
      chart={{ fromMs: NOW - 8 * 86_400_000, toMs: NOW + 7 * 86_400_000, nowMs: NOW, cursorMs: NOW - 86_400_000, live: false, zone: ZONE, usgsStage: [], nwpsObserved: [], forecast: [], spread: [], issuedMs: null, horizonMs: null, thresholds: [], alerts: [], coverageMs: null, message: null }}
      siteName={krz.name}
      forecast={forecast}
      conflicts={[{ kind: "flow", usgsCfs: 1430, nwpsCfs: 8180, ratio: 5.7, atMs: NOW }]}
      replaying={false}
      onScrub={noop}
      onLive={noop}
      onYesterday={noop}
      onPlay={noop}
    />,
  );
  return [board, drawer, timeline].join("\n");
}

describe("carp copy", () => {
  beforeAll(() => applyApp("carp"));
  afterAll(() => applyApp("python"));

  test("carp copy: board, briefing, drawer and timeline name no species app's animals or places", () => {
    const text = textOf(renderAll());
    expect(text.length).toBeGreaterThan(1500);
    expect(FORBIDDEN.exec(text)).toBeNull();
  });

  test("carp copy: welcome, help and helper chips come from the carp config and stay on topic", () => {
    const words = [welcome(CARP_APP), ...exampleQuestions(CARP_APP), ...helpEntries(CARP_APP).map((e) => `${e.control} ${e.what}`)].join(" ");
    expect(FORBIDDEN.exec(words)).toBeNull();
    expect(welcome(CARP_APP)).toContain(CARP_APP.copy.region);
    expect(exampleQuestions(CARP_APP)).toEqual(CARP_APP.helperQuestions.slice(0, 3));
    expect(helpEntries(CARP_APP).map((e) => e.id)).not.toContain("species");
    expect(helpEntries(CARP_APP).map((e) => e.id)).toContain("carp-asof");
  });

  test("carp copy: the locations list carries no boundary prose (the agent still states it)", () => {
    const text = textOf(renderAll());
    expect(text).not.toContain(CARP_APP.copy.boundaryNote!);
    expect(text).not.toContain("Conditions only.");
    expect(text).not.toContain("Demonstration locations");
  });

  test("carp copy: units, datums and sources are written out; nothing empty reads as fine", () => {
    const text = textOf(renderAll());
    expect(text).toContain("Not measured at this gauge (USGS 07381500).");
    expect(text).toContain("NWPS datum, used for flood categories");
    expect(text).toContain("USGS 07381500 datum; for change over time, not categories");
    expect(text).toContain("Sources disagree: stage");
    expect(text).toContain("Sources disagree: flow");
    expect(text).toContain("observed after the as-of time (what happened next)");
    expect(text).toContain("spread of last 3 issuances (not a confidence band)");
    expect(text).toContain("Statuses as known at Sep 30, 4:00 AM CDT");
    expect(text).toMatch(/Cannot assess/);
    expect(text).toContain("No active NWS alerts at the location, checked for Oct 1, 4:00 AM CDT.");
  });
});
