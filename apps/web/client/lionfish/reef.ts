/**
 * Reef heat maps: NOAA Coral Reef Watch's 5 km daily products as finished pictures from the PacIOOS ERDDAP
 * (`dhw_5km` `transparentPng`), one per area, drawn on the globe overlay. The server colours them (palette and range
 * are ours), draws only the area asked for and takes the product day, so there are no readings to page through
 * and nothing to store. CORS is open (`Access-Control-Allow-Origin: *`), so the pictures load under the page's COEP.
 */
import type { Area } from "./model";

const ERDDAP_PNG = "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.transparentPng";
const DAY_MS = 86_400_000;
/** The newest product day is about two days behind the wall clock; asking for a later one fails. */
const PRODUCT_LAG_MS = 2 * DAY_MS;
/** Pixels per 5 km cell: crisp blocks, the whole of an area in one small picture. */
const PX_PER_CELL = 6;
const CELL_DEG = 0.05;
const MAX_PX = 1400;

export type ReefMode = "dhw" | "baa" | "hotspot" | "sst";
export const REEF_MODES: readonly ReefMode[] = ["dhw", "baa", "hotspot", "sst"];
export const DEFAULT_REEF_MODE: ReefMode = "dhw";

/** ERDDAP's Rainbow palette, low to high, as the legend draws it. */
export const RAINBOW = ["#7f00ff", "#0000ff", "#00bfff", "#00ff00", "#ffff00", "#ff8000", "#e50000"] as const;

export type ReefSpec = {
  id: ReefMode;
  /** Chip label. */
  label: string;
  /** The ERDDAP variable. */
  variable: string;
  /** Colour range the server maps to the palette. */
  min: number;
  max: number;
  /** Five discrete sections instead of a ramp (BAA is a category, 0 to 4). */
  discrete: boolean;
  unit: string;
  /** What the picture shows, in plain words. */
  blurb: string;
  /** Ramp ends for the legend. */
  low: string;
  high: string;
};

export const REEF_SPECS: Record<ReefMode, ReefSpec> = {
  dhw: {
    id: "dhw",
    label: "Heat stress",
    variable: "CRW_DHW",
    min: 0,
    max: 16,
    discrete: false,
    unit: "°C-weeks",
    blurb: "Heat piling up over the last 12 weeks. Around 4 and above, corals start to bleach; around 8, many die.",
    low: "0",
    high: "16+",
  },
  baa: {
    id: "baa",
    label: "Alert level",
    variable: "CRW_BAA_7D_MAX",
    min: 0,
    max: 4,
    discrete: true,
    unit: "",
    blurb: "The highest bleaching alert reached at each spot in the last 7 days.",
    low: "none",
    high: "alert 2",
  },
  hotspot: {
    id: "hotspot",
    label: "Hotspot",
    variable: "CRW_HOTSPOT",
    min: 0,
    max: 3,
    discrete: false,
    unit: "°C above normal summer max",
    blurb: "How far today's sea is above the warmest it normally gets. 1 °C or more starts the stress count.",
    low: "0",
    high: "3 °C+",
  },
  sst: {
    id: "sst",
    label: "Sea temp",
    variable: "CRW_SST",
    min: 24,
    max: 32,
    discrete: false,
    unit: "°C",
    blurb: "How warm the sea surface is today (satellite, 5 km).",
    low: "24 °C",
    high: "32 °C",
  },
};

/** The five BAA classes as the discrete Rainbow draws them. */
export const BAA_CLASSES: readonly { label: string; color: string }[] = [
  { label: "No stress", color: "#0066ff" },
  { label: "Watch", color: "#00ff00" },
  { label: "Warning", color: "#ffc100" },
  { label: "Alert 1", color: "#e50000" },
  { label: "Alert 2", color: "#e500e5" },
];

/** The picture of one area for a mode, at the product day for `atMs` (the newest day when it is past the lag). */
export function reefUrl(area: Pick<Area, "bbox">, mode: ReefMode, atMs: number, nowMs = Date.now()): string {
  const s = REEF_SPECS[mode];
  const { west, south, east, north } = area.bbox;
  const productMs = Math.floor(atMs / DAY_MS) * DAY_MS + DAY_MS / 2;
  const time = productMs > nowMs - PRODUCT_LAG_MS ? "last" : new Date(productMs).toISOString().replace(".000Z", "Z");
  const cols = Math.min(MAX_PX, Math.max(32, Math.round(((east - west) / CELL_DEG) * PX_PER_CELL)));
  const rows = Math.min(MAX_PX, Math.max(32, Math.round(((north - south) / CELL_DEG) * PX_PER_CELL)));
  // Latitude runs north to south on the grid, longitude west to east.
  const box = `%5B(${time})%5D%5B(${north}):(${south})%5D%5B(${west}):(${east})%5D`;
  const bar = `Rainbow%7C${s.discrete ? "D" : "C"}%7CLinear%7C${s.min}%7C${s.max}%7C${s.discrete ? 5 : ""}`;
  return `${ERDDAP_PNG}?${s.variable}${box}&.draw=surface&.colorBar=${bar}&.land=off&.size=${cols}%7C${rows}`;
}

type Entry = { img: HTMLImageElement; ready: boolean; failed: boolean };
const cache = new Map<string, Entry>();

/** The picture for `url`, when it has loaded; the first call starts the load and `onLoad` asks for a redraw. */
export function reefImage(url: string, onLoad: () => void): HTMLImageElement | null {
  const hit = cache.get(url);
  if (hit) return hit.ready ? hit.img : null;
  if (typeof Image === "undefined") return null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  const entry: Entry = { img, ready: false, failed: false };
  cache.set(url, entry);
  img.onload = () => {
    entry.ready = true;
    onLoad();
  };
  img.onerror = () => {
    entry.failed = true;
  };
  img.src = url;
  return null;
}
