/**
 * Place search and nearby boat access (gates/leaf-GE6.md G4, G6) on the real stack (e2e/stack.ts: Axum over the
 * python fixtures, the production e2e build, the Caddy-like proxy) against a LOCAL STUB of the Google Places API
 * (New) and Photon. No request leaves the machine: the browser context aborts every request to a host other than
 * 127.0.0.1, and the page is pointed at the stub through localStorage `inversa:places-base`, which only dev and e2e
 * builds read (client/places/browser.ts). The "key" is a placeholder string that only the stub sees; no real key
 * is used or needed.
 *
 *   bun run e2e:places                  build, run, print the PLACES lines
 *   E2E_SKIP_BUILD=1 bun run e2e:places  reuse the last e2e build
 *
 * The stub answers the documented shapes from tests/fixtures/places: Text Search returns the recorded Flamingo
 * results (or, for the "boat ramp" query, the recorded ramps), Nearby Search the recorded marinas, both moved so
 * they sit around the requested centre the way the recording sat around Flamingo; Photon returns its recording.
 * It answers CORS preflights like places.googleapis.com does (docs/places.md) and refuses a Google call without
 * `X-Goog-Api-Key` or `X-Goog-FieldMask`.
 *
 * Lines:
 *   PLACES search_results=<n> flew=1 nearby=<n> links_new_tab=<n> no_key_message=1
 *   PLACES-DETAIL …          what was checked (distance after the flight, stub requests, map layers)
 *   PLACES-AXE serious=<n> critical=<n>   axe-core with the search popover open (and with the nearby list)
 *   PLACES-KEYBOARD-OK       Enter opens with focus in the box, arrows move the active option, Enter flies and
 *                            hands focus back to the button, Esc closes and hands focus back
 * Screenshots: docs/evidence/places-search.png (search open with results), docs/evidence/places-nearby.png.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { getApp } from "../shared/apps";
import { browserKeyStorageKey } from "../shared/keys";
import { haversineKm } from "../shared/places";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const APP = "python" as const;
const APP_DIR = path.resolve(import.meta.dir, "..");
const FIXTURES = path.join(APP_DIR, "tests/fixtures/places");
const EVIDENCE = path.join(REPO_DIR, "docs/evidence");
const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
/** Where the recorded nearby fixtures sit; the stub moves them to the requested centre. */
const RECORDED_CENTRE = { lat: 25.1417, lon: -80.9245 };
const PLACEHOLDER_KEY = "e2e-stub-placeholder";
const LOAD_TIMEOUT_MS = 120_000;

const log = (...a: unknown[]) => console.error("[e2e:places]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

// ---- the stub -----------------------------------------------------------------------------------------------

type StubCall = { path: string; method: string; key: boolean; mask: string | null; body: Record<string, unknown> | null };

type Json = { places?: { location?: { latitude: number; longitude: number } }[] };

async function fixture(name: string): Promise<Json> {
  return (await Bun.file(path.join(FIXTURES, name)).json()) as Json;
}

/** The recorded response moved by (dLat, dLon), so its places keep their distances from the new centre. */
function shifted(json: Json, centre: { lat: number; lon: number }): Json {
  const dLat = centre.lat - RECORDED_CENTRE.lat;
  const dLon = centre.lon - RECORDED_CENTRE.lon;
  return { ...json, places: (json.places ?? []).map((p) => (p.location ? { ...p, location: { latitude: p.location.latitude + dLat, longitude: p.location.longitude + dLon } } : p)) };
}

function startStub() {
  const calls: StubCall[] = [];
  const cors = (origin: string | null) => ({
    "Access-Control-Allow-Origin": origin ?? "*",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-goog-api-key,x-goog-fieldmask",
    "Access-Control-Max-Age": "3600",
    // The page is cross-origin isolated (COEP require-corp); a CORS response is allowed as is.
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "content-type": "application/json" } });
      const body = req.method === "POST" ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null;
      const call: StubCall = { path: url.pathname, method: req.method, key: Boolean(req.headers.get("x-goog-api-key")), mask: req.headers.get("x-goog-fieldmask"), body };
      calls.push(call);
      if (url.pathname === "/api/" || url.pathname === "/api") return json(await fixture("photon.json"));
      if (url.pathname.startsWith("/v1/places:")) {
        if (!call.key || !call.mask) return json({ error: { code: 403, status: "PERMISSION_DENIED", message: "stub: key and field mask required" } }, 403);
        if (url.pathname === "/v1/places:searchNearby") {
          const c = (body?.locationRestriction as { circle?: { center?: { latitude: number; longitude: number } } } | undefined)?.circle?.center;
          if (!c) return json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400);
          return json(shifted(await fixture("nearby-marinas.json"), { lat: c.latitude, lon: c.longitude }));
        }
        if (url.pathname === "/v1/places:searchText") {
          if (body?.textQuery === "boat ramp") {
            const r = (body.locationRestriction as { rectangle?: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } } } | undefined)?.rectangle;
            if (!r) return json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400);
            return json(shifted(await fixture("ramp-search.json"), { lat: (r.low.latitude + r.high.latitude) / 2, lon: (r.low.longitude + r.high.longitude) / 2 }));
          }
          return json(await fixture("text-search.json"));
        }
      }
      return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

// ---- page helpers -------------------------------------------------------------------------------------------

/** No request may leave the machine: anything not on 127.0.0.1 or localhost is aborted (and counted). */
async function offline(context: BrowserContext, blocked: string[]): Promise<void> {
  await context.route(
    (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
    (route) => {
      blocked.push(new URL(route.request().url()).host);
      return route.abort();
    },
  );
}

async function openApp(browser: Browser, stack: Stack, stub: string, key: boolean, blocked: string[]): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await offline(context, blocked);
  await context.addInitScript(
    ({ base, keyName, key }) => {
      localStorage.setItem("inversa:places-base", base);
      if (key) localStorage.setItem(keyName, key);
      else localStorage.removeItem(keyName);
    },
    { base: stub, keyName: browserKeyStorageKey("google-maps"), key: key ? PLACEHOLDER_KEY : null },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${stack.origin}/?app=${APP}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-testid=hud-topbar]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => window.__inversa?.globe() != null, undefined, { timeout: LOAD_TIMEOUT_MS });
  return { page, context, errors };
}

const isFocused = (page: Page, selector: string) => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);

async function axe(page: Page, label: string, findings: Map<string, string>): Promise<void> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const violations = (await page.evaluate(async () => {
    const a = (window as unknown as { axe: { run: (d: Document, o: object) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[] }> } }).axe;
    const res = await a.run(document, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(" ")) }));
  })) as { id: string; impact: string | null; targets: string[] }[];
  for (const v of violations) {
    for (const t of v.targets) findings.set(`${v.id} @ ${t}`, v.impact ?? "unknown");
    const loud = v.impact === "serious" || v.impact === "critical";
    log(`${loud ? "!!" : "  "} axe ${label}: ${v.impact} ${v.id} ×${v.targets.length}${loud ? ` ${v.targets.slice(0, 4).join(" | ")}` : ""}`);
  }
}

/** A python fixture sighting with a position (the API caps a window at 31 days: walk back a month at a time). */
async function aSighting(stack: Stack): Promise<string> {
  const MONTH = 30 * 86_400_000;
  for (let to = Date.now(), i = 0; i < 24; i++, to -= MONTH) {
    const res = await stack.graphql<{ sightings: { id: string }[] }>("query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id } }", {
      b: getApp(APP).regions[0]!.bbox,
      f: new Date(to - MONTH).toISOString(),
      t: new Date(to).toISOString(),
    });
    if (res.sightings[0]) return res.sightings[0].id;
  }
  return fail("no fixture sighting");
}

// ---- main ---------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  buildApi(log);
  buildWeb(log);
  const stub = startStub();
  const stack = await startStack({ name: "places", app: APP });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const findings = new Map<string, string>();
  const blocked: string[] = [];
  mkdirSync(EVIDENCE, { recursive: true });
  try {
    // ---- 1. with a (placeholder) key: Google Places through the stub ----
    const { page, context, errors } = await openApp(browser, stack, stub.origin, true, blocked);
    const layersBefore = await page.evaluate(() => window.__inversa!.globe()!.layers.map((l) => `${l.id}:${l.enabled ? 1 : 0}`).join(","));
    if (await page.locator("[data-testid=search-popover]").count()) fail("the search popover is open at load");

    // Keyboard: focus the bar's Search button, Enter opens the box with focus in it.
    await page.locator("[data-testid=search-button]").focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=search-popover]").waitFor({ timeout: 10_000 });
    let keyboard = await isFocused(page, "[data-testid=search-input]");
    if (!keyboard) log("Enter on Search did not put focus in the box");
    // Esc closes and hands focus back to the button.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=search-popover]"), undefined, { timeout: 5_000 });
    if (!(await isFocused(page, "[data-testid=search-button]"))) {
      keyboard = false;
      log("Esc did not return focus to Search");
    }
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=search-input]").waitFor();
    await page.keyboard.type("Flamingo", { delay: 40 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=search-results] [role=option][data-source="google"]').length > 0, undefined, { timeout: 15_000 });
    const options = await page.locator("[data-testid=search-results] [role=option]").evaluateAll((els) => els.map((e) => ({ id: e.id, source: e.getAttribute("data-source"), text: e.querySelector(".name")?.textContent ?? "" })));
    const searchResults = options.length;
    const googleCredit = await page.locator('[data-testid=places-credit][data-provider="google"]').count();
    log(`search: ${searchResults} options (${options.map((o) => `${o.source}:${o.text}`).join(", ")}); Google credit ${googleCredit}`);
    await axe(page, "search open (google)", findings);
    await page.screenshot({ path: path.join(EVIDENCE, "places-search.png") });

    // Arrows move the active option; pick the last Google one (Flamingo Gardens, far from the start view).
    const pick = options.length - 1;
    for (let i = 0; i <= pick; i++) await page.keyboard.press("ArrowDown");
    const activeId = await page.locator("[data-testid=search-input]").getAttribute("aria-activedescendant");
    if (activeId !== options[pick]!.id) {
      keyboard = false;
      log(`aria-activedescendant ${activeId} after ${pick + 1} ArrowDown, expected ${options[pick]!.id}`);
    }
    const target = (await Bun.file(path.join(FIXTURES, "text-search.json")).json()) as { places: { displayName: { text: string }; location?: { latitude: number; longitude: number } }[] };
    const chosen = target.places.find((p) => p.displayName.text === options[pick]!.text)?.location ?? fail(`chosen option ${options[pick]!.text} is not a fixture place`);
    const place = { lat: chosen.latitude, lon: chosen.longitude };
    const before = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { lat: number; lon: number };
    await page.keyboard.press("Enter");
    await page.evaluate(() => ((window as unknown as { __placesV0: unknown }).__placesV0 = window.__inversa!.state("VIEW")));
    await page.waitForFunction(() => !document.querySelector("[data-testid=search-popover]"), undefined, { timeout: 5_000 });
    if (!(await isFocused(page, "[data-testid=search-button]"))) {
      keyboard = false;
      log("Enter on an option did not hand focus back to Search");
    }
    // The camera arrived: the globe wrote VIEW back from its pose, and the place projects to the pane's middle.
    await page.waitForFunction(
      ({ lat, lon }) => {
        const d = window.__inversa!;
        if (d.state("VIEW") === (window as unknown as { __placesV0: unknown }).__placesV0) return false;
        const pane = document.querySelector('[data-slot="globe-pane"]')!.getBoundingClientRect();
        const p = d.project(lon, lat);
        return p !== null && Math.hypot(p.x - pane.width / 2, p.y - pane.height / 2) < 40;
      },
      place,
      { timeout: 30_000 },
    );
    const after = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { lat: number; lon: number; altitudeM: number };
    const fromKm = haversineKm(before, place);
    const toKm = haversineKm(after, place);
    const flew = fromKm > 5 && toKm < 5 ? 1 : 0;
    const layersAfter = await page.evaluate(() => window.__inversa!.globe()!.layers.map((l) => `${l.id}:${l.enabled ? 1 : 0}`).join(","));

    // ---- nearby: a sighting's card, nothing until asked ----
    const sighting = await aSighting(stack);
    await page.evaluate((h) => (window.location.hash = h), `#e=${encodeURIComponent(`sighting:${sighting}`)}`);
    await page.waitForFunction((w) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent === w, `sighting:${sighting}`, { timeout: 60_000 });
    const button = page.locator("[data-testid=hud-drawer] [data-testid=access-button]");
    await button.waitFor({ timeout: 30_000 });
    const listBeforeAsk = await page.locator("[data-testid=access-list]").count();
    const isAccess = (c: StubCall) => c.path === "/v1/places:searchNearby" || c.body?.textQuery === "boat ramp";
    const accessCallsBefore = stub.calls.filter(isAccess).length;
    await button.focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=hud-drawer] [data-testid=access-list] li").first().waitFor({ timeout: 15_000 });
    const nearby = await page.locator("[data-testid=hud-drawer] [data-testid=access-list] li").count();
    const links = await page.locator("[data-testid=hud-drawer] [data-testid=access-maps-link]").evaluateAll((els) =>
      els.map((a) => ({ href: a.getAttribute("href") ?? "", target: a.getAttribute("target"), rel: a.getAttribute("rel") })),
    );
    const linksNewTab = links.filter((l) => l.href.startsWith("https://www.google.com/maps/search/?api=1&") && l.href.includes("query_place_id=") && l.target === "_blank" && l.rel === "noopener noreferrer").length;
    const drawer = await page.locator("[data-testid=hud-drawer]").boundingBox();
    const rightCard = drawer !== null && drawer.x > 1440 / 2 ? 1 : 0;
    const distances = await page.locator("[data-testid=hud-drawer] [data-testid=access-list] .km").allTextContents();
    await axe(page, "nearby list", findings);
    await page.screenshot({ path: path.join(EVIDENCE, "places-nearby.png") });
    const accessCalls = stub.calls.filter(isAccess);
    const masksOk = stub.calls.filter((c) => c.path.startsWith("/v1/")).every((c) => c.key && c.mask && !c.mask.includes("rating") && !c.mask.includes("*"));
    if (errors.length) log(`page errors (key run): ${errors.join(" | ")}`);
    await context.close();

    // ---- 2. no key: gazetteer + Photon, and the box says search is limited ----
    const googleBefore = stub.calls.filter((c) => c.path.startsWith("/v1/")).length;
    const noKey = await openApp(browser, stack, stub.origin, false, blocked);
    await noKey.page.locator("[data-testid=search-button]").click();
    await noKey.page.locator("[data-testid=search-input]").waitFor();
    const noticeAtOpen = await noKey.page.locator("[data-testid=search-notice]").textContent();
    await noKey.page.keyboard.type("Florida Bay", { delay: 40 });
    await noKey.page.waitForFunction(() => document.querySelectorAll('[data-testid=search-results] [role=option][data-source="photon"]').length > 0, undefined, { timeout: 15_000 });
    const notice = await noKey.page.locator("[data-testid=search-notice]").textContent();
    const osmCredit = await noKey.page.locator('[data-testid=places-credit][data-provider="photon"]').count();
    const googleDuringNoKey = stub.calls.filter((c) => c.path.startsWith("/v1/")).length - googleBefore;
    const noKeyMessage = notice === "Search is limited without a Google key" && noticeAtOpen === notice && googleDuringNoKey === 0 ? 1 : 0;
    await axe(noKey.page, "search open (no key)", findings);
    if (noKey.errors.length) log(`page errors (no-key run): ${noKey.errors.join(" | ")}`);
    await noKey.context.close();

    const serious = [...findings.values()].filter((v) => v === "serious").length;
    const critical = [...findings.values()].filter((v) => v === "critical").length;
    const photonCalls = stub.calls.filter((c) => c.path.startsWith("/api")).length;
    console.log(
      `PLACES-DETAIL start_km=${fromKm.toFixed(1)} after_km=${toKm.toFixed(3)} altitude_m=${after.altitudeM} chosen="${options[pick]!.text}" google_credit=${googleCredit} ` +
        `list_before_ask=${listBeforeAsk} access_requests=${accessCalls.length} (before ${accessCallsBefore}) masks_ok=${masksOk ? 1 : 0} right_card=${rightCard} distances=${distances.join("|")} ` +
        `map_layers_unchanged=${layersBefore === layersAfter ? 1 : 0} photon_requests=${photonCalls} osm_credit=${osmCredit} google_requests_without_key=${googleDuringNoKey} offsite_blocked=${blocked.length}`,
    );
    console.log(`PLACES-AXE serious=${serious} critical=${critical}`);
    console.log(keyboard ? "PLACES-KEYBOARD-OK" : "PLACES-KEYBOARD-FAIL");
    console.log(`PLACES search_results=${searchResults} flew=${flew} nearby=${nearby} links_new_tab=${linksNewTab} no_key_message=${noKeyMessage}`);
    const ok =
      searchResults > 0 && flew === 1 && nearby > 0 && linksNewTab === nearby && noKeyMessage === 1 && keyboard && serious === 0 && critical === 0 && listBeforeAsk === 0 && rightCard === 1 && masksOk && googleCredit > 0 && layersBefore === layersAfter;
    return ok ? 0 : 1;
  } catch (err) {
    console.error(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
    stub.stop();
  }
}

process.exit(await main());
