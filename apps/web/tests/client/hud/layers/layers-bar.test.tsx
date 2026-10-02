import { afterEach, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { init } from "@calvinjs/active-state";

import { helpEntries } from "client/hud/help/content";
import { LayersChoices } from "client/hud/layers/LayersBar";
import { LAYER_BLURBS, layersBarIds, layersGroups, layersOn } from "client/hud/layers/model";
import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { layersFor } from "client/state/layers";
import { emotionTheme } from "client/themes/theme";
import { APP_IDS, getApp, hasLayer, LAYER_IDS } from "shared/apps";
import { OVERLAY_IDS } from "shared/overlays";

init(state);
selectPython();
afterEach(() => selectPython());

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
const [SIGHTINGS, , , , , , , , NOTES, VESSELS] = LAYER_IDS;
const textOf = (markup: string) =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("layers bar", () => {
  test("layers bar: no Ships group in any app (ships were removed), Water and weather for every app, sightings and notes where the app has them", () => {
    const ships: string[] = [];
    for (const id of APP_IDS) {
      const app = getApp(id);
      const groups = layersGroups(layersFor(app), null, app);
      if (groups.some((g) => g.id === "ships")) ships.push(id);
      const map = groups.find((g) => g.id === "map")?.rows.map((r) => r.layer) ?? [];
      expect(map).toEqual([SIGHTINGS, NOTES].filter((l) => hasLayer(app, l)));
      const ids = layersBarIds(layersFor(app), app);
      expect(ids.filter((l) => (OVERLAY_IDS as readonly string[]).includes(l)).length).toBeGreaterThan(0);
      // Nothing for experts here: no stations, alerts, hotspots, rasters, missions or cursors.
      for (const l of ids) expect<string[]>([SIGHTINGS, NOTES, VESSELS, ...OVERLAY_IDS]).toContain(l);
    }
    expect(ships).toEqual([]);
  });

  test("layers bar: the novice default is unchanged, only sightings and notes on at first load", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      expect(layersOn(layersFor(app), app)).toEqual([SIGHTINGS, NOTES].filter((l) => hasLayer(app, l)));
    }
  });

  test("layers bar: the popover's switches are the legend's own (one LAYERS key), grouped, one plain line each", () => {
    applyApp("carp");
    const app = getApp("carp");
    const markup = html(<LayersChoices app={app} layers={layersFor(app)} active={false} />);
    const text = textOf(markup);
    expect(text).not.toContain("Ships");
    expect(markup).not.toContain("legend-toggle-vessels");
    expect(text).toContain("Water and weather");
    // Switches with names, off by default, in the order a reader scans them.
    for (const o of OVERLAY_IDS.filter((l) => hasLayer(app, l))) expect(markup).toContain(`data-testid="legend-toggle-${o}"`);
    expect(markup).not.toContain('data-testid="legend-group-ships"');
  });

  test("layers bar: the help sheet explains Look, Layers and Developer everywhere, Ships only where the app has ships", () => {
    for (const id of APP_IDS) {
      const ids = helpEntries(getApp(id)).map((e) => e.id);
      for (const always of ["look", "layers-bar", "developer"]) expect(ids).toContain(always);
      expect(ids.includes("ships")).toBe(hasLayer(getApp(id), VESSELS));
    }
  });

  test("layers bar: python shows sightings with its species switch on, notes, and no Ships group", () => {
    const app = getApp("python");
    const markup = html(<LayersChoices app={app} layers={layersFor(app)} active={false} />);
    expect(markup).toMatch(/<input[^>]*data-testid="legend-toggle-sightings"[^>]*checked/);
    expect(markup).not.toContain('data-testid="legend-group-ships"');
    expect(textOf(markup)).toContain(LAYER_BLURBS[SIGHTINGS]!);
  });
});
