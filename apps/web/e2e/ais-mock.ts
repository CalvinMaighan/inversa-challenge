/**
 * The local AISStream mock for the e2e scripts (e2e:vessels, e2e:agent --ge7): a Bun websocket that checks the
 * subscription Axum sends and answers with frames built from the recorded fixtures in api/tests/fixtures/ais/ (the
 * real FEDERAL OSHIMA PositionReport and the ShipStaticData template): six ships sailing east off the Louisiana
 * coast, one fix every 10 minutes for the last 26 hours, plus their static data. No network, no real key.
 */
import path from "node:path";

import { REPO_DIR, type Stack } from "./stack";

const FIXTURES = path.join(REPO_DIR, "api/tests/fixtures/ais");
export const MOCK_KEY = "e2e-mock-aisstream-key";
export const SHIPS = 6;
export const HOURS = 26;
export const STEP_MIN = 10;
const MIN = 60_000;
export const CARP_BOX = [[28.9, -94.0], [32.9, -88.8]];
const TYPES = [70, 80, 60, 30, 52, 37];
export const NAMES = ["GULF TRADER", "DELTA STAR", "BAYOU QUEEN", "PELICAN", "MISS LOUISE", "REEL DEAL"];

/** An AISStream envelope (the recorded fixtures). */
type Envelope = { MessageType: string; MetaData: Record<string, unknown>; Message: Record<string, Record<string, unknown>> };
export type Subscription = { APIKey?: unknown; BoundingBoxes?: unknown; FilterMessageTypes?: unknown };
export type Track = { mmsi: string; name: string | null; type: string; points: { at: string }[] };

/** AISStream's `MetaData.time_utc` format, e.g. `2024-12-09 02:27:43.237370229 +0000 UTC`. */
const aisTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ".$1000000 +0000 UTC");

/** Frames for the mock: static data, then every ship's fixes in time order. Built from the recorded templates. */
export async function buildFrames(nowMs: number): Promise<{ frames: string[]; fromMs: number; toMs: number }> {
  const position = (await Bun.file(path.join(FIXTURES, "position_report.json")).json()) as Envelope;
  const statics = (await Bun.file(path.join(FIXTURES, "ship_static_data.json")).json()) as Envelope;
  const frames: string[] = [];
  const toMs = Math.floor(nowMs / MIN) * MIN - 2 * MIN;
  const fromMs = toMs - HOURS * 3_600_000;
  for (let s = 0; s < SHIPS; s += 1) {
    const mmsi = 367_500_000 + s;
    const st = structuredClone(statics);
    st.MetaData = { ...st.MetaData, MMSI: mmsi, MMSI_String: mmsi, ShipName: NAMES[s], latitude: 29.0 + 0.08 * s, longitude: -93.8, time_utc: aisTime(fromMs) };
    st.Message.ShipStaticData = { ...st.Message.ShipStaticData, UserID: mmsi, Name: `${NAMES[s]}@@@@`, Type: TYPES[s], Destination: "NEW ORLEANS" };
    frames.push(JSON.stringify(st));
  }
  for (let t = fromMs; t <= toMs; t += STEP_MIN * MIN) {
    const hours = (t - fromMs) / 3_600_000;
    for (let s = 0; s < SHIPS; s += 1) {
      const mmsi = 367_500_000 + s;
      // 4 to 8 kn: 26 h east from 93.8 W stays inside the carp box (east edge 88.8 W).
      const knots = 4 + 0.8 * s;
      const lat = 29.0 + 0.08 * s;
      // East at `knots`: one knot is 1/60 degree of latitude per hour; longitude degrees shrink by cos(lat).
      const lon = -93.8 + (knots * hours) / 60 / Math.cos((lat * Math.PI) / 180);
      const p = structuredClone(position);
      p.MetaData = { ...p.MetaData, MMSI: mmsi, MMSI_String: mmsi, ShipName: NAMES[s], latitude: lat, longitude: lon, time_utc: aisTime(t) };
      p.Message.PositionReport = { ...p.Message.PositionReport, UserID: mmsi, Latitude: lat, Longitude: lon, Sog: knots, Cog: 90, TrueHeading: 90, NavigationalStatus: 0 };
      frames.push(JSON.stringify(p));
    }
  }
  return { frames, fromMs, toMs };
}

export type MockState = { subscriptions: Subscription[]; sent: number; errors: string[] };

/** The mock AISStream: one subscription per connection, checked, then every frame as a binary message. */
export function startMock(frames: string[]): { url: string; state: MockState; stop(): void } {
  const state: MockState = { subscriptions: [], sent: 0, errors: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/v0/stream" || !srv.upgrade(req)) return new Response("upgrade required", { status: 426 });
      return undefined;
    },
    websocket: {
      message(ws, message) {
        let sub: Subscription;
        try {
          sub = JSON.parse(String(message));
        } catch {
          state.errors.push("subscription is not JSON");
          ws.send(JSON.stringify({ error: "bad subscription" }));
          return;
        }
        state.subscriptions.push({ ...sub, APIKey: sub.APIKey === MOCK_KEY ? "<mock key>" : "<other>" });
        if (sub.APIKey !== MOCK_KEY) {
          ws.send(JSON.stringify({ error: "Api Key Is Not Valid" }));
          return;
        }
        for (const f of frames) {
          ws.send(new TextEncoder().encode(f));
          state.sent += 1;
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/v0/stream`, state, stop: () => server.stop(true) };
}

/** Wait until Axum stored every mock ship's whole track (through the real ingest pipeline). */
export async function waitForTracks(stack: Stack, fromMs: number, toMs: number): Promise<Track[]> {
  const deadline = Date.now() + 120_000;
  const q = `query($bbox: BBox!, $from: Time!, $to: Time!) { vessels(bbox: $bbox, from: $from, to: $to) { mmsi name type points { at } } }`;
  for (;;) {
    const d = await stack.graphql<{ vessels: Track[] }>(q, { bbox: { west: -94, south: 28.9, east: -88.8, north: 32.9 }, from: new Date(fromMs - MIN).toISOString(), to: new Date(Math.min(toMs + MIN, fromMs + 7 * 24 * 3_600_000)).toISOString() });
    const complete = d.vessels.length === SHIPS && d.vessels.every((v) => v.points.length >= HOURS * (60 / STEP_MIN));
    if (complete) return d.vessels;
    if (Date.now() > deadline) throw new Error(`vessels not ingested: ${d.vessels.length} tracks, points ${d.vessels.map((v) => v.points.length).join(",")}`);
    await Bun.sleep(1000);
  }
}
