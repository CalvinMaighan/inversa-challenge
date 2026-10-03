import { afterEach, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { init, set } from "@calvinjs/active-state";

import type { LayerStats } from "client/globe/layers/types";
import WaterWeather from "client/hud/legend/WaterWeather";
import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { LAYERS, layersFor, type LayersState } from "client/state/layers";
import { emotionTheme } from "client/themes/theme";
import { getApp } from "shared/apps";
import { CYCLONES, OVERLAY_IDS, overlaySpec, RADAR, SST_MAP } from "shared/overlays";

init(state);
selectPython();
afterEach(() => selectPython());

/** Clouds are switched off in every app (they did not look good), so the rows are the other four. */
const SHOWN_OVERLAYS = OVERLAY_IDS.filter((id) => id !== "clouds");
const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
const textOf = (markup: string) =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("water and weather", () => {
  test("water and weather: the Layers legend carries the group, every overlay off by default, one plain line each, SST units in C and F, an opacity slider", async () => {
    applyApp("lionfish");
    const markup = html(<WaterWeather app={getApp("lionfish")} stats={null} />);
    const group = markup.slice(markup.indexOf('data-testid="water-weather"'));
    expect(group.length).toBeGreaterThan(0);
    expect(textOf(group)).not.toContain("Water and weather");
    expect(textOf(group)).not.toContain("Live pictures from NOAA and NASA");
    expect(textOf(group)).not.toContain("Clouds");
    for (const id of SHOWN_OVERLAYS) {
      expect(group).toContain(`data-overlay-row="${id}"`);
      // Off by default (GC6): the switch is unchecked and the row is dimmed.
      expect(group).toMatch(new RegExp(`<input[^>]*data-testid="legend-toggle-${id}"[^>]*>`));
      expect(group).not.toMatch(new RegExp(`<input[^>]*data-testid="legend-toggle-${id}"[^>]*checked`));
      expect(group).toContain(`data-overlay-row="${id}" data-off=""`);
    }
    const text = textOf(group);
    expect(text).toContain("Where it is raining now.");
    expect(text).toContain("How warm the sea was, satellite picture, one per day.");
    expect(text).toContain("0 °C / 32 °F");
    expect(text).toContain("32 °C / 90 °F");
    expect(text).toContain("dBZ");
    expect(group).toMatch(/<input[^>]*type="range"[^>]*data-testid="overlay-opacity"/);
    expect(text).toContain("40%");
    // Nothing on: no attribution yet, and no "Showing" line.
    expect(group).not.toContain('data-testid="overlay-attribution"');
    expect(text).not.toContain("Showing");
    // The Layers popover (GE7, client/hud/layers) mounts the group after its own rows (LayersBar reads
    // LAYERS through a hook without a server snapshot, so its composition is checked in the source).
    const panel = await Bun.file(path.join(import.meta.dir, "../../../../client/hud/layers/LayersBar.tsx")).text();
    expect(panel.indexOf("<LegendRowView key={row.layer}")).toBeLessThan(panel.indexOf("<WaterWeather app={app} active={active} />"));
    // One place for it: the expert legend no longer repeats the group.
    const legend = await Bun.file(path.join(import.meta.dir, "../../../../client/hud/legend/LegendPanel.tsx")).text();
    expect(legend).not.toContain("<WaterWeather");
  });

  test("water and weather: python lists the weather layers but no SST map; the group reads the app config's labels", () => {
    applyApp("python");
    const markup = html(<WaterWeather app={getApp("python")} stats={null} />);
    expect(markup).toContain('data-overlay-row="radar"');
    expect(markup).not.toContain('data-overlay-row="sst-map"');
    expect(textOf(markup)).toContain("Hurricanes and tropical storms");
    for (const app of ["carp", "lionfish", "python"] as const) {
      const visible = layersFor(getApp(app)).visible;
      for (const id of SHOWN_OVERLAYS) expect(visible[id]).toBe(false);
    }
  });

  test("water and weather: with radar and storms on, the rows show the instant drawn, the storm count or 'No active storms', and the attribution lines open in a new tab", () => {
    applyApp("carp");
    const app = getApp("carp");
    const layers: LayersState = layersFor(app);
    layers.visible[RADAR] = true;
    layers.visible[CYCLONES] = true;
    set(LAYERS, layers);
    const stats: LayerStats[] = [
      { id: RADAR, enabled: true, count: 1, frame: 2, updatedAt: 1, error: null, overlay: { shownMs: Date.parse("2026-10-01T19:36:00Z"), clamped: null, opacity: 0.75 } },
      { id: CYCLONES, enabled: true, count: 0, frame: 2, updatedAt: 1, error: null, breakdown: { storms: 0, loaded: 1 } },
    ];
    const markup = html(<WaterWeather app={app} stats={stats} />);
    const text = textOf(markup);
    expect(markup).toMatch(/<input[^>]*data-testid="legend-toggle-radar"[^>]*checked/);
    expect(text).toContain("Showing 19:36 UTC, 2026-10-01");
    expect(text).toContain("No active storms");
    const credits = markup.slice(markup.indexOf('data-testid="overlay-attribution"'));
    expect(textOf(credits)).toContain(overlaySpec(RADAR).attribution);
    expect(textOf(credits)).toContain(overlaySpec(CYCLONES).attribution);
    expect(textOf(credits)).not.toContain(overlaySpec(SST_MAP).attribution);
    for (const a of credits.matchAll(/<a [^>]*>/g)) {
      expect(a[0]).toContain('target="_blank"');
      expect(a[0]).toMatch(/rel="[^"]*noopener[^"]*noreferrer/);
    }
    expect([...credits.matchAll(/<a [^>]*>/g)].length).toBe(2);
    const withStorms = html(<WaterWeather app={app} stats={[{ ...stats[1]!, count: 2, breakdown: { storms: 2, loaded: 1 } }]} />);
    expect(textOf(withStorms)).toContain("2 active storms");
    set(LAYERS, layersFor(app));
  });
});
