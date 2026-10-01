import { describe, expect, test } from "bun:test";
import { PYTHON_FILTER_IDS, PYTHON_LAYERS, SPECIES_IDS, selectPython } from "@/tests/client/python-app";
import { get, set } from "@calvinjs/active-state";

import { LAYER_IDS } from "shared/voice/ui-tools";

import { registerGlobe, type CameraTarget, type GlobeApi } from "client/globe/api";
import { compactIso, decodeShareLink, defaultSpecies, encodeShareLink, SHARE_LINK_VERSION, type ShareState } from "client/hud/share-link";
import { applyShareState, readShareState } from "client/hud/share-link-store";
import type { HudSelection } from "client/hud/selection";
import { activeAppId } from "client/state/app";
import { applyApp } from "client/state/app-switch";
import { LAYERS, type LayersState } from "client/state/layers";
import { SELECTION } from "client/state/selection";
import { TIME, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";
import { getApp } from "shared/apps";
import { ANIMAL_CATEGORIES } from "shared/species-categories";

selectPython();

const [SIGHTINGS, HOTSPOTS, LST, , , ALERTS] = LAYER_IDS;
const [PYTHON, , IGUANA] = SPECIES_IDS;

const sample: ShareState = {
  app: "python",
  camera: { lat: 25.7617, lon: -80.1918, altitudeM: 45000, heading: 12.5, pitch: -62 },
  at: "2026-09-30T20:30:00.000Z",
  layers: [SIGHTINGS, HOTSPOTS, LST, ALERTS],
  species: [PYTHON, IGUANA, "snakes", "lizards", "plants"],
  taxa: [[24382, false], [116461, true]],
  hours: 48,
  evidenceId: "reading:ndbc_vakf1:water_c:1727700000000:measured",
};

describe("share link encode/decode", () => {
  test("share link round trip: decode(encode(s)) equals s at link precision", () => {
    const hash = encodeShareLink(sample);
    expect(decodeShareLink(hash)).toEqual(sample);
    expect(decodeShareLink(`#${hash}`)).toEqual(sample);
    // Stable: re-encoding the decoded state gives the same string.
    expect(encodeShareLink(decodeShareLink(hash))).toBe(hash);
  });

  test("share link round trip quantizes to about a metre and a minute", () => {
    const precise: ShareState = {
      camera: { lat: 25.761734912, lon: -80.191845121, altitudeM: 45000.4, heading: 372.26, pitch: -62.04 },
      at: "2026-09-30T20:30:17.321Z",
    };
    const back = decodeShareLink(encodeShareLink(precise));
    expect(back.camera!.lat).toBeCloseTo(25.76173, 5);
    expect(back.camera!.lon).toBeCloseTo(-80.19185, 5);
    expect(back.camera!.altitudeM).toBe(45000);
    expect(back.camera!.heading).toBeCloseTo(12.3, 5);
    expect(back.camera!.pitch).toBe(-62);
    expect(back.at).toBe("2026-09-30T20:30:00.000Z");
  });

  test("share link keeps an empty layer list (all hidden) distinct from no layer field", () => {
    expect(decodeShareLink(encodeShareLink({ layers: [] })).layers).toEqual([]);
    expect(decodeShareLink(encodeShareLink({})).layers).toBeUndefined();
  });

  test("share link omits the species filter at its default (focus species and animal categories on; insects, spiders, plants and other off), and the window at 7 days", () => {
    const hash = encodeShareLink({ app: "python", species: [...SPECIES_IDS, ...ANIMAL_CATEGORIES], hours: 168, taxa: [] });
    expect(new URLSearchParams(hash).has("sp")).toBe(false);
    expect(new URLSearchParams(hash).has("w")).toBe(false);
    expect(new URLSearchParams(hash).has("st")).toBe(false);
    // The four focus species without the animals is a filter: it travels. So is every key on.
    expect(decodeShareLink(encodeShareLink({ species: [...SPECIES_IDS] })).species).toEqual([...SPECIES_IDS]);
    expect(decodeShareLink(encodeShareLink({ species: [...PYTHON_FILTER_IDS] })).species).toEqual([...PYTHON_FILTER_IDS]);
    expect(decodeShareLink(hash).species).toBeUndefined();
    // Taxon overrides and the window read back; a bad window is dropped.
    expect(decodeShareLink("v=1&st=116461,-24382,-24382,x&w=720")).toEqual({ app: "python", taxa: [[24382, false], [116461, true]], hours: 720 });
    expect(decodeShareLink("v=1&w=100")).toEqual({ app: "python" });
  });

  test("share link decode drops invalid fields and keeps the valid ones", () => {
    const hash = "v=1&c=91,0,100,0,0&t=not-a-time&l=sightings,bogus,alerts&sp=python,dragon&e=nonsense:1";
    expect(decodeShareLink(hash)).toEqual({ app: "python", layers: [SIGHTINGS, ALERTS], species: [PYTHON] });
    expect(decodeShareLink("c=25,-80,99999999999,-30,-200").camera).toEqual({ lat: 25, lon: -80, altitudeM: 20_000_000, heading: 330, pitch: -90 });
    expect(decodeShareLink("c=25,-80,1000")).toEqual({ app: "python" });
    expect(decodeShareLink("v=9&c=25,-80,1000,0,-90")).toEqual({});
  });

  test("share link hash is readable: commas and colons stay unescaped", () => {
    const hash = encodeShareLink({ app: "python", camera: { lat: 25.5, lon: -80.5, altitudeM: 1000, heading: 0, pitch: -90 }, at: "2026-09-30T20:30:00Z", evidenceId: "hotspot:python:230:125:1727700000000" });
    expect(hash).toBe("v=2&app=python&c=25.5,-80.5,1000,0,-90&t=2026-09-30T20:30Z&e=hotspot:python:230:125:1727700000000");
  });

  test("share link decode ignores unknown params and takes the first of a repeated one", () => {
    const hash = "v=2&app=python&utm_source=chat&c=25.5,-80.5,1000,0,-90&c=0,0,1,0,0&zoom=3&app=carp";
    expect(decodeShareLink(hash)).toEqual({ app: "python", camera: { lat: 25.5, lon: -80.5, altitudeM: 1000, heading: 0, pitch: -90 } });
  });

  test("share link time is compact ISO to the minute", () => {
    expect(compactIso("2026-09-30T20:30:00.000Z")).toBe("2026-09-30T20:30Z");
    expect(compactIso("garbage")).toBeNull();
  });
});

describe("share link app (v=2)", () => {
  test("share link app: v=2 carries the app and round-trips it for each app", () => {
    expect(SHARE_LINK_VERSION).toBe(2);
    for (const [app, species] of [
      ["carp", ["snakes"]],
      ["lionfish", ["lionfish", "fish"]],
      ["python", ["tegu", "birds"]],
    ] as const) {
      const state: ShareState = { app, camera: { lat: 20, lon: -87, altitudeM: 9000, heading: 0, pitch: -90 }, layers: [ALERTS], species: [...species] };
      const hash = encodeShareLink(state);
      expect(new URLSearchParams(hash).get("v")).toBe("2");
      expect(new URLSearchParams(hash).get("app")).toBe(app);
      expect(decodeShareLink(hash)).toEqual(state);
      expect(encodeShareLink(decodeShareLink(hash))).toBe(hash);
    }
  });

  test("share link app: v=1 links (made before apps) still decode, as python", () => {
    const old = "v=1&c=25.7617,-80.1918,45000,12.5,-62&t=2026-09-30T20:30Z&l=sightings,hotspots&sp=python,iguana&e=sighting:123";
    expect(decodeShareLink(old)).toEqual({
      app: "python",
      camera: { lat: 25.7617, lon: -80.1918, altitudeM: 45000, heading: 12.5, pitch: -62 },
      at: "2026-09-30T20:30:00.000Z",
      layers: [SIGHTINGS, HOTSPOTS],
      species: [PYTHON, IGUANA],
      evidenceId: "sighting:123",
    });
  });

  test("share link app: species keys are checked against the link's app, defaults are that app's", () => {
    // `tegu` is python's, not lionfish's: dropped from a lionfish link.
    expect(decodeShareLink("v=2&app=lionfish&sp=lionfish,tegu,fish").species).toEqual(["lionfish", "fish"]);
    expect(decodeShareLink("v=2&app=carp&sp=lionfish,birds").species).toEqual(["birds"]);
    // Lionfish's default filter (its one species and the animals) is omitted; its default window is 30 days.
    const lionfishDefault = encodeShareLink({ app: "lionfish", species: defaultSpecies(getApp("lionfish")), hours: 720 });
    expect(lionfishDefault).toBe("v=2&app=lionfish");
    expect(defaultSpecies(getApp("carp"))).toEqual([...ANIMAL_CATEGORIES]);
    // An unknown app keeps the view fields but names no app.
    expect(decodeShareLink("v=2&app=everglades&c=25,-80,1000,0,-90").app).toBeUndefined();
  });

  test("share link app: the store reads the active app into the link", () => {
    applyApp("lionfish");
    try {
      expect(readShareState().app).toBe("lionfish");
      expect(new URLSearchParams(encodeShareLink(readShareState())).get("app")).toBe("lionfish");
    } finally {
      selectPython();
    }
    expect(activeAppId()).toBe("python");
  });

  test("share link app: applying a link turns on only layers the active app has", () => {
    applyApp("carp");
    try {
      applyShareState({ app: "carp", layers: [SIGHTINGS, HOTSPOTS, ALERTS] })();
      const layers = get<LayersState>(LAYERS)!;
      expect(LAYER_IDS.filter((id) => layers.visible[id])).toEqual([ALERTS]);
    } finally {
      selectPython();
    }
  });
});

describe("share link store", () => {
  test("opening a share link restores camera, time, layers and selection, and flies the globe", () => {
    const time = get<TimeState>(TIME)!;
    const at = new Date(Date.parse(time.to) - 2 * 3600_000).toISOString();
    const flights: CameraTarget[] = [];
    const globe: GlobeApi = {
      flyTo: (t) => flights.push(t),
      project: () => null,
      pick: () => null,
      onPostRender: () => () => {},
      requestRender: () => {},
    };
    registerGlobe(globe);

    const link = encodeShareLink({ ...sample, at });
    const cancel = applyShareState(decodeShareLink(link));
    cancel();

    const view = get<ViewState>(VIEW)!;
    expect([view.lat, view.lon, view.altitudeM, view.heading, view.pitch]).toEqual([25.7617, -80.1918, 45000, 12.5, -62]);
    expect(flights).toEqual([{ ...sample.camera!, durationS: 0 }]);
    expect(get<TimeState>(TIME)!.at).toBe(at);
    expect(get<TimeState>(TIME)!.playing).toBe(false);
    const layers = get<LayersState>(LAYERS)!;
    expect(LAYER_IDS.filter((id) => layers.visible[id])).toEqual(sample.layers!);
    expect(PYTHON_FILTER_IDS.filter((id) => layers.species[id])).toEqual(sample.species!);
    expect(layers.species.t24382).toBe(false);
    expect(layers.species.t116461).toBe(true);
    expect(layers.sightingHours).toBe(48);
    const selection = get<HudSelection>(SELECTION)!;
    expect(selection.evidenceId).toBe(sample.evidenceId!);
    expect(selection.drawerOpen).toBe(true);

    // And the store reads back into the same link.
    expect(encodeShareLink(readShareState())).toBe(link);
    registerGlobe(null);
  });

  test("share link waits for the globe, flies once when it registers, and brings an old time's window along", () => {
    registerGlobe(null);
    const flights: CameraTarget[] = [];
    const cancel = applyShareState({ camera: sample.camera, at: "1999-01-01T00:00:00.000Z" });
    expect(flights).toEqual([]);
    const globe: GlobeApi = {
      flyTo: (t) => flights.push(t),
      project: () => null,
      pick: () => null,
      onPostRender: () => () => {},
      requestRender: () => {},
    };
    registerGlobe(globe);
    registerGlobe(globe);
    expect(flights.length).toBe(1);
    // 1999 is before the live window: the window recentres on it instead of clamping the cursor.
    expect(get<TimeState>(TIME)).toMatchObject({ at: "1999-01-01T00:00:00.000Z", from: "1998-12-17T00:00:00.000Z", to: "1999-01-16T00:00:00.000Z" });
    cancel();
    registerGlobe(null);
    set(TIME, TIME.defaults);
    set(VIEW, VIEW.defaults);
    set(LAYERS, PYTHON_LAYERS);
    set(SELECTION, SELECTION.defaults);
  });
});
