/**
 * NOAA Coral Reef Watch heat-map pictures, fetched from the PacIOOS ERDDAP once and served to every visitor: the browser asks
 * this route (same origin, `.png` so a CDN in front caches it too) instead of the public API. A picture of a past product day
 * never changes; the "last" one is kept for three hours.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ERDDAP_PNG = "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.transparentPng";
const VARIABLES = new Set(["CRW_DHW", "CRW_BAA_7D_MAX", "CRW_HOTSPOT", "CRW_SST"]);
const LAST_TTL_MS = 3 * 3_600_000;
const DAY_TTL_MS = 7 * 86_400_000;
const MAX_ENTRIES = 200;

type Entry = { at: number; ttl: number; bytes: ArrayBuffer };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<ArrayBuffer>>();

const num = (v: string | null, lo: number, hi: number): number | null => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** The ERDDAP URL for the query, or null when any part is not one we draw. */
function upstream(p: URLSearchParams): { url: string; ttl: number } | null {
  const variable = p.get("v") ?? "";
  const time = p.get("time") ?? "";
  const discrete = p.get("d") === "1";
  const west = num(p.get("west"), -180, 180);
  const east = num(p.get("east"), -180, 180);
  const south = num(p.get("south"), -90, 90);
  const north = num(p.get("north"), -90, 90);
  const min = num(p.get("min"), -100, 100);
  const max = num(p.get("max"), -100, 100);
  const cols = num(p.get("cols"), 16, 1400);
  const rows = num(p.get("rows"), 16, 1400);
  const dated = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(time);
  if (!VARIABLES.has(variable) || (time !== "last" && !dated)) return null;
  if ([west, east, south, north, min, max, cols, rows].some((v) => v === null)) return null;
  const box = `%5B(${time})%5D%5B(${north}):(${south})%5D%5B(${west}):(${east})%5D`;
  const bar = `Rainbow%7C${discrete ? "D" : "C"}%7CLinear%7C${min}%7C${max}%7C${discrete ? 5 : ""}`;
  return { url: `${ERDDAP_PNG}?${variable}${box}&.draw=surface&.colorBar=${bar}&.land=off&.size=${cols}%7C${rows}`, ttl: time === "last" ? LAST_TTL_MS : DAY_TTL_MS };
}

/** ERDDAP is slow and sometimes answers 5xx once: one more try before giving up. */
async function fetchPicture(url: string): Promise<ArrayBuffer> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (res.ok) return await res.arrayBuffer();
      last = new Error(`ERDDAP HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export async function GET(req: Request) {
  const target = upstream(new URL(req.url).searchParams);
  if (!target) return new NextResponse("bad query", { status: 400 });
  const hit = cache.get(target.url);
  let bytes = hit && Date.now() - hit.at < hit.ttl ? hit.bytes : null;
  if (!bytes) {
    try {
      let pending = inflight.get(target.url);
      if (!pending) {
        pending = fetchPicture(target.url).finally(() => inflight.delete(target.url));
        inflight.set(target.url, pending);
      }
      bytes = await pending;
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(target.url, { at: Date.now(), ttl: target.ttl, bytes });
    } catch {
      // An old picture beats none.
      if (!hit) return new NextResponse("reef picture unavailable", { status: 502 });
      bytes = hit.bytes;
    }
  }
  return new NextResponse(bytes, {
    headers: { "content-type": "image/png", "cache-control": `public, max-age=${Math.floor(target.ttl / 1000)}` },
  });
}
