import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { init } from "@calvinjs/active-state";

import { exampleQuestions, helpEntries, welcome } from "client/hud/help/content";
import type { CellExplain } from "client/lionfish/data";
import { HELP } from "client/lionfish/help";
import { areaHeat, countReports, groupHeat, lagStats } from "client/lionfish/model";
import OceanHelp from "client/lionfish/OceanHelp";
import { PriorityCardView } from "client/lionfish/PriorityCard";
import SurveyPanel from "client/lionfish/SurveyPanel";
import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { emotionTheme } from "client/themes/theme";

import { AREAS, cell, crw, LIONFISH_APP, NOW, report } from "./fixtures";

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
/** Words of the other apps (python, carp) that must never show in Lionfish Watch. */
const FORBIDDEN = /\b(python|pythons|burmese|everglades|river|rivers|flood|flooding|nwps|carp|levee|gauge height)\b/i;
/** A single risk number in any form. */
const RISK_PERCENT = /(risk|probability|chance)[^.\n]{0,40}%|%[^.\n]{0,40}(risk|probability|chance)/i;
const noop = () => {};

const reports = [report({ observed: "2026-09-20T15:00:00Z" }), report({ observed: "2026-07-01T15:00:00Z", submitted: "2026-09-25T00:00:00Z" }), report({ observed: "2026-09-20T15:00:00Z", source: "gbif", submitted: null, duplicateOf: "1" })];
const heat = groupHeat([...crw("222", 24.525, -81.375, "2026-09-29", { sst: 30.04, anomaly: 1.52, dhw: 13.65, baa: 1 })], AREAS);

const explain: CellExplain = {
  cell: "fl-keys:179:24",
  at: new Date(NOW).toISOString(),
  regionId: "fl-keys",
  rankScore: 0.39,
  thin: false,
  components: {
    recentReports: { id: "recentReports", value: 0.17, state: "OK", weight: 1, rationale: "kernel-weighted independent reports by observed date", inputs: ["sighting:33"], evidence: [{ id: "sighting:33", kind: "sighting", observedAt: "2026-09-18T20:14:04Z", submittedAt: "2026-09-20T01:00:00Z", ingestedAt: "2026-10-01T09:06:10Z", weight: 0.9, detail: "inat casual, accuracy 55 m", url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg" }] },
    idQuality: { id: "idQuality", value: 0, state: "OK", weight: 1, rationale: "share of research grade reports: 0 of 1", inputs: [], evidence: [] },
    heatStress: { id: "heatStress", value: 1, state: "OK", weight: 1, rationale: "NOAA CRW at the nearest 5 km pixel: DHW 14.71", inputs: ["reading:222:dhw:1790683200000:satellite"], evidence: [] },
    completeness: { id: "completeness", value: 0.94, state: "OK", weight: 0, rationale: "report freshness, CRW state, NAS and buoy coverage", inputs: [], evidence: [] },
  },
  heat: { dhw: 14.71, baa: 1, sst: 30.04, anomaly: 1.52, observedAt: "2026-09-29T12:00:00Z", ingestedAt: "2026-10-01T06:30:00Z", station: "222", credit: "NOAA Coral Reef Watch, CoralTemp v3.1" },
  fieldWindow: { state: "OK", issuedAt: "2026-10-01T00:00:00Z", waveMaxM: 1.1, waveMinM: 0.6, calmHours: 70, horizonHours: 72, currentMaxMs: 0.3, station: "218" },
  weights: { recentReports: 1, idQuality: 1, heatStress: 1 },
  basis: "SUBMITTED",
  caveats: ["Sightings are not abundance.", "Heat stress is context, not proof of damage."],
  credit: "NOAA Coral Reef Watch",
};

function renderAll(): string {
  const q = { basis: "observed" as const, atMs: NOW, days: 30 };
  const panel = html(
    <SurveyPanel
      app={LIONFISH_APP}
      open
      onOpen={noop}
      onClose={noop}
      areas={AREAS.map((a) => ({ id: a.id, name: a.name, thin: a.thin, count: countReports(reports, { ...q, areaId: a.id }), newestObservedMs: null, heat: areaHeat(heat, a.id, NOW) }))}
      area="belize"
      onArea={noop}
      layers={{ reports: true, heat: true, priority: true, field: false }}
      onLayer={noop}
      basis="observed"
      onBasis={noop}
      days={30}
      onDays={noop}
      lateOnly={false}
      onLateOnly={noop}
      total={countReports(reports, q)}
      lag={lagStats(reports)}
      submittedSource="evidence"
      cells={[{ cell: cell("179:24", "fl-keys", 24.545, -81.405, 0.39), rank: 1 }, { cell: cell("55:123", "belize", 17.2, -87.9, 0.6, { thin: true }), rank: 1 }]}
      priorityAtMs={NOW}
      replayReady
      selectedCell={null}
      onCell={noop}
      feeds={[{ source: "crw", mode: "POLL", state: "NOMINAL", newestObservedAt: null, lastFetchAt: null, lagSeconds: null, note: null }]}
      sstPair={{ buoy: { station: "39", name: "Sombrero Key, FL", valueC: 29.2, observedMs: NOW, lat: 24.6, lon: -81.1 }, satellite: { station: "222", valueC: 30.04, dayMs: NOW - 2 * 86_400_000, lat: 24.5, lon: -81.4 }, diffC: -0.84, distanceKm: 28, disagree: true }}
      onHelp={noop}
      loading={false}
      errors={[]}
    />,
  );
  const card = html(<PriorityCardView app={LIONFISH_APP} rank={1} areaName="Florida Keys / South Florida" cell="fl-keys:179:24" atMs={NOW} live explain={explain} loading={false} error={null} onClose={noop} onHelp={noop} />);
  const help = html(<OceanHelp topic="dhw" onClose={noop} />);
  return [panel, card, help].join("\n");
}

describe("lionfish copy", () => {
  beforeAll(() => applyApp("lionfish"));
  afterAll(() => applyApp("python"));

  test("lionfish copy: panel, card and guide name no other app's animals, places or river words", () => {
    const text = textOf(renderAll());
    expect(text.length).toBeGreaterThan(3000);
    expect(FORBIDDEN.exec(text)).toBeNull();
    expect(RISK_PERCENT.exec(text)).toBeNull();
  });

  test("lionfish copy: honesty lines, thin-area and lag notes come from the lionfish config", () => {
    const text = textOf(renderAll());
    for (const key of ["thinAreaNote", "heatNote", "priorityNote", "lagNote"]) expect(text).toContain(LIONFISH_APP.copy[key]!);
    expect(text).toContain("24 of 74");
    expect(text).toContain("median lag was 5 days");
    expect(text).toContain("GBIF copy of an iNaturalist record, never counted");
    expect(text).toContain("Weight 0: lowers confidence, never the rank.");
    expect(text).toContain("Field window · not part of priority");
    expect(text).toContain("DHW and BAA disagree");
    expect(text).toContain("Buoy and satellite disagree (Florida)");
  });

  test("lionfish copy: the ocean-data guide covers six topics with what, why, source and limits", () => {
    expect(HELP.map((h) => h.id)).toEqual(["temperature", "anomaly", "dhw", "baa", "waves", "currents"]);
    for (const h of HELP) {
      expect(h.links.length).toBeGreaterThan(0);
      expect(h.limits.length).toBeGreaterThan(40);
      expect(FORBIDDEN.exec(`${h.title} ${h.what} ${h.why} ${h.source} ${h.limits}`)).toBeNull();
    }
    expect(HELP.find((h) => h.id === "baa")!.why).toContain("can disagree");
  });

  test("lionfish copy: welcome, help and helper chips stay on lionfish", () => {
    const words = [welcome(LIONFISH_APP), ...exampleQuestions(LIONFISH_APP), ...helpEntries(LIONFISH_APP).map((e) => `${e.control} ${e.what}`), LIONFISH_APP.agent.persona, LIONFISH_APP.agent.refusal].join(" ");
    expect(FORBIDDEN.exec(words)).toBeNull();
    expect(RISK_PERCENT.exec(words)).toBeNull();
  });
});
