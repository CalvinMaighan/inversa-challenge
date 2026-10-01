import { afterEach, describe, expect, test } from "bun:test";
import { set } from "@calvinjs/active-state";

import { registerGlobe, type CameraTarget, type GlobeApi } from "client/globe/api";
import { aimPoint, boxOf, fitBBox, fitInPane, freeRect, keepInView, paneFrame, visibleRect, type Circle, type Rect } from "client/globe/fit";
import { VIEW } from "client/state/view";
import { selectPython } from "@/tests/client/python-app";

selectPython();

const pane = { left: 0, top: 0, right: 375, bottom: 740 };

describe("free rect of the globe pane", () => {
  test("bars cut the top and bottom, a tall panel its side", () => {
    const f = freeRect({ left: 0, top: 0, right: 1000, bottom: 900 }, [
      { left: 0, top: 0, right: 1000, bottom: 50 },
      { left: 10, top: 700, right: 990, bottom: 890 },
      { left: 10, top: 60, right: 350, bottom: 690 },
    ]);
    expect(f).toEqual({ left: 350, top: 50, right: 1000, bottom: 700 });
  });

  test("a small tab above the timeline cuts the bottom, not the side (most area kept)", () => {
    const f = freeRect(pane, [
      { left: 8, top: 600, right: 367, bottom: 732 },
      { left: 12, top: 554, right: 93, bottom: 584 },
    ]);
    expect(f).toEqual({ left: 0, top: 0, right: 375, bottom: 554 });
  });

  test("obstacles outside the pane are ignored", () => {
    expect(freeRect(pane, [{ left: 400, top: 0, right: 500, bottom: 100 }])).toEqual({ left: 0, top: 0, right: 375, bottom: 740 });
  });
});

describe("fitting a box in the free rect", () => {
  const box = { west: -92.5, south: 29.5, east: -91, north: 32.5 };

  test("free rect centred on the pane: the camera sits over the box's centre", () => {
    const p = fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 740 });
    expect(p.lat).toBeCloseTo(31, 6);
    expect(p.lon).toBeCloseTo(-91.75, 6);
    expect(p.pitch).toBe(-90);
  });

  test("free rect in the upper part: the camera moves south so the box lands higher on screen", () => {
    const top = fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 400 });
    expect(top.lat).toBeLessThan(31);
    // A smaller rect needs a higher camera.
    expect(top.altitudeM).toBeGreaterThan(fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 740 }).altitudeM);
  });

  test("free rect on the right: the camera moves west", () => {
    expect(fitBBox(box, 1000, 900, { left: 350, top: 0, right: 1000, bottom: 900 }).lon).toBeLessThan(-91.75);
  });

  test("boxOf spans the points", () => {
    expect(boxOf([{ lat: 30, lon: -91 }, { lat: 32, lon: -92 }])).toEqual({ west: -92, south: 30, east: -91, north: 32 });
  });
});

const M = 111_320;
const mppAt = (altitudeM: number, w: number, h: number) => (altitudeM * 2 * Math.tan(Math.PI / 6)) / Math.max(w, h);
/** Where a place lands on screen under a straight-down pose (the linear model `fitBBox` inverts). */
function screenOf(pose: { lat: number; lon: number; altitudeM: number }, at: { lat: number; lon: number }, w: number, h: number) {
  const mpp = mppAt(pose.altitudeM, w, h);
  const cos = Math.cos((pose.lat * Math.PI) / 180);
  return { x: w / 2 + ((at.lon - pose.lon) * M * cos) / mpp, y: h / 2 - ((at.lat - pose.lat) * M) / mpp };
}
const corners = (b: { west: number; south: number; east: number; north: number }) => [
  { lat: b.south, lon: b.west },
  { lat: b.south, lon: b.east },
  { lat: b.north, lon: b.west },
  { lat: b.north, lon: b.east },
];
const inCircle = (p: { x: number; y: number }, c: Circle, slack = 1) => Math.hypot(p.x - c.cx, p.y - c.cy) <= c.r + slack;
const inside = (p: { x: number; y: number }, r: Rect, slack = 1) => p.x >= r.left - slack && p.x <= r.right + slack && p.y >= r.top - slack && p.y <= r.bottom + slack;
const rectCorners = (r: Rect) => [
  { x: r.left, y: r.top },
  { x: r.right, y: r.top },
  { x: r.left, y: r.bottom },
  { x: r.right, y: r.bottom },
];

/** The 1440×900 stage (GE1 geometry): circle 656 px across, opaque to 89 % (feather 11), chat card on the left. */
const W = 1440;
const H = 900;
const CIRCLE: Circle = { cx: 720, cy: 450, r: 328 * 0.89 };
const FREE: Rect = { left: 452, top: 60, right: 1440, bottom: 780 };

describe("stage framing", () => {
  test("stage framing: the visible rect lies inside the circle's opaque disc and the free rect", () => {
    for (const aspect of [0.3, 1, 2.5]) {
      const r = visibleRect(FREE, CIRCLE, aspect);
      for (const p of rectCorners(r)) {
        expect(inCircle(p, CIRCLE)).toBe(true);
        expect(inside(p, FREE)).toBe(true);
      }
      // Not a sliver: a square box gets at least 60 % of the inscribed square's side.
      if (aspect === 1) expect(Math.min(r.right - r.left, r.bottom - r.top)).toBeGreaterThan(0.6 * CIRCLE.r * Math.SQRT2);
    }
  });

  test("stage framing: a card over part of the circle (1024 px, sighting card open) narrows the rect to the free side", () => {
    const circle: Circle = { cx: 512, cy: 384, r: 276 * 0.89 };
    const free: Rect = { left: 452, top: 60, right: 576, bottom: 670 };
    const r = visibleRect(free, circle, 1);
    expect(r.left).toBeGreaterThanOrEqual(452);
    expect(r.right).toBeLessThanOrEqual(576);
    for (const p of rectCorners(r)) expect(inCircle(p, circle)).toBe(true);
  });

  test("stage framing: no circle (phone docks, scope off) keeps the free rect", () => {
    expect(visibleRect(FREE, null, 1)).toEqual(FREE);
  });

  test("stage framing: a wide box fitted to the visible rect lands every corner inside the circle, never in the black margin", () => {
    // Louisiana's coast: much wider than tall, the shape that spilled into the margins on the whole free rect.
    const box = { west: -94, south: 28.9, east: -88.8, north: 30.4 };
    const cos = Math.cos((29.65 * Math.PI) / 180);
    const rect = visibleRect(FREE, CIRCLE, ((box.east - box.west) * cos) / (box.north - box.south));
    const pose = fitBBox(box, W, H, rect, 1.05);
    for (const c of corners(box)) {
      const p = screenOf(pose, c, W, H);
      expect(inCircle(p, CIRCLE)).toBe(true);
      expect(inside(p, FREE)).toBe(true);
    }
    const old = fitBBox(box, W, H, FREE, 1.05);
    expect(corners(box).some((c) => !inCircle(screenOf(old, c, W, H), CIRCLE))).toBe(true);
  });

  test("stage framing: aimPoint puts a place on the visible rect's centre at the same height", () => {
    const rect = { left: 452, top: 120, right: 576, bottom: 640 };
    const at = { lat: 25.4, lon: -80.6 };
    const pose = aimPoint(at, 20_000, 1024, 768, rect);
    const p = screenOf(pose, at, 1024, 768);
    expect(p.x).toBeCloseTo(514, 0);
    expect(p.y).toBeCloseTo(380, 0);
    expect(pose.altitudeM).toBe(20_000);
    expect(pose.pitch).toBe(-90);
  });
});

/** A fake page at 1024×768: the shell, the pane, the stage circle, the chat card and maybe a sighting card. */
function stageDom(opts: { scopeOff?: boolean; feather?: string; card?: Rect }) {
  const rect = (r: Rect) => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top });
  const shell = { dataset: opts.scopeOff ? { scope: "off" } : {} };
  const stage = { getBoundingClientRect: () => rect({ left: 236, top: 108, right: 788, bottom: 660 }) };
  const obstacles = [{ left: 16, top: 16, right: 436, bottom: 752 }, ...(opts.card ? [opts.card] : [])].map((r) => ({ getBoundingClientRect: () => rect(r) }));
  const pane = { getBoundingClientRect: () => rect({ left: 0, top: 0, right: 1024, bottom: 768 }), querySelectorAll: () => obstacles };
  const g = globalThis as Record<string, unknown>;
  const saved = [g.document, g.getComputedStyle] as const;
  g.document = { querySelector: (sel: string) => (sel === "[data-shell]" ? shell : sel === "[data-stage]" ? stage : sel.includes("globe-pane") ? pane : null) };
  g.getComputedStyle = () => ({ getPropertyValue: (p: string) => (p === "--scope-feather" ? (opts.feather ?? "0.11") : "") });
  return () => {
    g.document = saved[0];
    g.getComputedStyle = saved[1];
  };
}

/** Longitude `px` pixels east of `lon` at 20 km over 1024 px. */
const eastBy = (lon: number, lat: number, px: number) => lon + (px * mppAt(20_000, 1024, 768)) / (M * Math.cos((lat * Math.PI) / 180));

describe("stage framing in the page", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    registerGlobe(null);
  });

  test("stage framing: paneFrame reads the circle's opaque disc (feather) and drops it when the scope is off", () => {
    restore = stageDom({ feather: "0.2" });
    const f = paneFrame()!;
    expect(f.circle).toEqual({ cx: 512, cy: 384, r: 276 * 0.8 });
    expect(f.free.left).toBe(436);
    restore();
    restore = stageDom({ scopeOff: true });
    expect(paneFrame()!.circle).toBeNull();
  });

  test("stage framing: fitInPane keeps a box clear of the chat card and inside the circle", () => {
    restore = stageDom({});
    const box = { west: -81.2, south: 25.1, east: -80.3, north: 25.9 };
    const pose = fitInPane(box, 24)!;
    const circle = paneFrame()!.circle!;
    for (const c of corners(box)) {
      const p = screenOf(pose, c, 1024, 768);
      expect(inCircle(p, circle)).toBe(true);
      expect(p.x).toBeGreaterThan(436);
    }
  });

  test("stage framing: keepInView glides a marker the sighting card covers back into the visible circle, and leaves a visible one alone", () => {
    restore = stageDom({ card: { left: 560, top: 60, right: 1008, bottom: 700 } });
    const camera = { lat: 25.5, lon: -80.5, altitudeM: 20_000 };
    set(VIEW, { ...VIEW.defaults, ...camera });
    const flights: CameraTarget[] = [];
    registerGlobe({
      flyTo: (t: CameraTarget) => void flights.push(t),
      project: (lon: number, lat: number) => screenOf(camera, { lat, lon }, 1024, 768),
      pick: () => null,
      onPostRender: () => () => {},
      requestRender: () => {},
    } as GlobeApi);
    // 200 px right of centre: under the card.
    const covered = { lat: 25.5, lon: eastBy(-80.5, 25.5, 200) };
    expect(screenOf(camera, covered, 1024, 768).x).toBeCloseTo(712, 0);
    expect(keepInView(covered)).toBe(true);
    const landed = screenOf(flights[0] as { lat: number; lon: number; altitudeM: number }, covered, 1024, 768);
    expect(landed.x).toBeGreaterThan(436);
    expect(landed.x).toBeLessThan(560);
    expect(inCircle(landed, paneFrame()!.circle!)).toBe(true);
    // 40 px left of centre: clear of both cards and inside the circle, so the camera stays.
    expect(keepInView({ lat: 25.5, lon: eastBy(-80.5, 25.5, -20) })).toBe(false);
    expect(flights.length).toBe(1);
  });
});
