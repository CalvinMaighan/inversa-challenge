/**
 * External links open in a new tab (gates/leaf-T42.md G7, rubric `evidence-source/external-links`), per app, on the
 * real stack (e2e/stack.ts) with the real agent. The Next server gets its model key from Doppler unless
 * `OPENROUTER_API_KEY` is set; the key is never printed.
 *
 *   bun run e2e:links -- --app <id>    build, run, print EXTERNAL-LINKS last
 *   E2E_SKIP_BUILD=1 …                  reuse the last e2e build
 *
 * In the app (`/?app=<id>`), visit every surface that carries external links:
 * 1. an agent answer (python: a table of the last 30 days' sightings whose rows link out to iNaturalist, page clock
 *    2026-09-30T21:00Z as in e2e/evidence.ts (the cold-snap scene holds no python sightings since K1, so a
 *    cold-snap table has no rows); carp: the Krotz Springs gauge and forecast, wall clock; lionfish: Coral Reef
 *    Watch and NDBC in the Florida Keys, page clock 2026-10-01T09:00Z as in e2e/lionfish.ts), each asked to end
 *    with a markdown link;
 * 2. the evidence drawer on a cited record with a publisher page: its "Open at <publisher>" link (python: a table
 *    row's iNaturalist sighting; carp, lionfish: the first citation chip whose record the API gives a page);
 * 3. the app's own surfaces (carp: the site drawer; lionfish: a priority card and the ocean-data help sources);
 * 4. the About/status popover with its sections open, and the help sheet it opens;
 * 5. Cesium's "Data attribution" lightbox.
 * After each, every `a[href^=http]` not on the app origin must have `target=_blank` and a `rel` with `noopener` and
 * `noreferrer`. Line: `EXTERNAL-LINKS app=<id> total=<n> new_tab=<n> unsafe=<n>`; exit 0 only when every surface
 * was reached, total >= 1 and every link is safe.
 */
import { chromium, type Page } from "playwright";

import type { AppId } from "../shared/apps";
import { ask, tapAgentStreams } from "./agent-ui";
import { appArg } from "./args";
import { buildApi, buildWeb, startStack, type Stack } from "./stack";

const APP: AppId = appArg();
const QUESTIONS: Record<AppId, string> = {
  python:
    "Show me the Burmese python sightings in the Everglades from the last 30 days as a table. " +
    "End your answer with a markdown link to https://www.inaturalist.org/ where readers can find more records.",
  carp:
    "For Krotz Springs, what is the latest USGS gauge reading and the current river forecast? Cite each record. " +
    "End your answer with a markdown link to https://water.noaa.gov/gauges/KRZL1 where readers can see the gauge.",
  lionfish:
    "What are the Coral Reef Watch heat stress and the NDBC buoy water temperature in the Florida Keys now? Cite the records. " +
    "End your answer with a markdown link to https://www.ndbc.noaa.gov/ where readers can see the buoys.",
};
/** Page clocks: just after the fixtures were recorded (as e2e/evidence.ts; lionfish as e2e/lionfish.ts); carp runs on the wall clock. */
const CLOCK: Record<AppId, number | null> = { python: Date.parse("2026-09-30T21:00:00Z"), carp: null, lionfish: Date.parse("2026-10-01T09:00:00Z") };
const TURN_TIMEOUT_MS = 240_000;
const LOAD_TIMEOUT_MS = 120_000;
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];
/** Answers' citations: inline chips and each answer's numbered Evidence list. */
const CITATIONS = '[data-chat-column] .agent-cite[data-evidence-id], [data-chat-column] [aria-label="Evidence"] [data-evidence-id]';

const log = (...a: unknown[]) => console.error(`[e2e:links ${APP}]`, ...a);

function fail(message: string): never {
  throw new Error(message);
}

type Link = { href: string; target: string | null; rel: string | null; where: string };

/** Every external anchor in the page right now, keyed by href + where so repeated scans count each once. */
async function scan(page: Page, seen: Map<string, Link & { ok: boolean }>, stage: string): Promise<number> {
  const links = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href^='http']")]
      .filter((a) => new URL(a.href).origin !== location.origin)
      .map((a) => {
        const scope = a.closest("[data-testid], [data-chat-column], [data-globe], [role=dialog]");
        const where = scope ? (scope.getAttribute("data-testid") ?? (scope.hasAttribute("data-chat-column") ? "chat" : scope.hasAttribute("data-globe") ? "globe" : "dialog")) : "page";
        return { href: a.href, target: a.getAttribute("target"), rel: a.getAttribute("rel"), where };
      }),
  );
  let added = 0;
  for (const l of links) {
    const rel = new Set((l.rel ?? "").split(/\s+/));
    const ok = l.target === "_blank" && rel.has("noopener") && rel.has("noreferrer");
    const key = `${l.where} ${l.href}`;
    if (!seen.has(key)) added++;
    seen.set(key, { ...l, ok });
    if (!ok) log(`UNSAFE after ${stage}: ${l.where} ${l.href} target=${l.target} rel=${l.rel}`);
  }
  log(`${stage}: ${links.length} external links on the page (${added} new)`);
  return links.length;
}

/** Wait for the drawer to show `id` and its "Open at <publisher>" link. */
async function drawerLink(page: Page, id: string): Promise<string> {
  await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent?.trim() === want, id, { timeout: 30_000 });
  const link = page.locator("[data-testid=hud-drawer] [data-testid=source-page-link]");
  await link.waitFor({ timeout: 30_000 });
  const href = (await link.getAttribute("href")) ?? "";
  log(`drawer ${id}: "${(await link.textContent())?.trim()}" → ${href}`);
  return href;
}

/** Python: the answer is a sightings table; open the drawer from an iNaturalist row. */
async function pythonAnswer(page: Page): Promise<void> {
  const rowLinks = page.locator("[data-chat-column] a[data-source-page]");
  if ((await rowLinks.count()) === 0) {
    await ask(page, "Please call the sightings tool for Burmese pythons in the Everglades over the last 30 days and show the table.", TURN_TIMEOUT_MS);
  }
  const rows = await rowLinks.count();
  if (rows === 0) fail("no sightings table row carries a source page link");
  log(`answer: ${rows} table row links`);
  const inatRow = page.locator("[data-chat-column] a[data-source-page][href^='https://www.inaturalist.org/observations/']").first();
  const tr = inatRow.locator("xpath=ancestor::tr[1]");
  const evidenceId = (await tr.getAttribute("data-evidence-id")) ?? fail("row without an evidence id");
  await tr.locator("td:not([data-kind=link])").first().click();
  await drawerLink(page, evidenceId);
}

/** Carp, lionfish: open the drawer from the first citation chip whose record has a publisher page (API `sourcePageUrl`). */
async function citedRecord(page: Page, stack: Stack): Promise<void> {
  const ids = await page.locator(CITATIONS).evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("data-evidence-id") ?? ""))].filter(Boolean));
  log(`citations: ${ids.join(" ")}`);
  for (const id of ids) {
    if (!/^(sighting|reading|alert|forecast):/.test(id)) continue;
    const page_ = await stack
      .graphql<{ evidence: { sourcePageUrl: string | null } }>("query($id: ID!) { evidence(id: $id) { sourcePageUrl } }", { id })
      .then((r) => r.evidence.sourcePageUrl)
      .catch(() => null);
    if (!page_) continue;
    const chip = page.locator(CITATIONS).and(page.locator(`[data-evidence-id="${id}"]`)).first();
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    const href = await drawerLink(page, id);
    if (href !== page_) fail(`drawer link ${href} is not the API's sourcePageUrl ${page_}`);
    return;
  }
  fail(`no cited record with a publisher page among ${ids.length} citations`);
}

async function carpSurfaces(page: Page, seen: Map<string, Link & { ok: boolean }>): Promise<void> {
  await page.click('[data-carp-row="KRZL1"]');
  await page.locator('[data-testid="carp-drawer"][data-site="KRZL1"] [data-testid="carp-changed"]').waitFor({ timeout: 30_000 });
  const n = await page.locator('[data-testid="carp-drawer"] a[href^="http"]').count();
  if (n === 0) fail("the carp site drawer has no external link");
  log(`carp drawer KRZL1: ${n} links`);
  await scan(page, seen, "carp site drawer");
  await page.click('[data-testid="carp-drawer-panel"] button[aria-label="Close panel"]');
}

async function lionfishSurfaces(page: Page, seen: Map<string, Link & { ok: boolean }>): Promise<void> {
  await page.click('[data-area="fl-keys"]');
  const cell = (await page.getAttribute("[data-cell-row]", "data-cell-row")) ?? fail("no ranked place in the Florida Keys");
  await page.click(`[data-cell-row="${cell}"]`);
  await page.locator(`[data-testid="lionfish-card"][data-cell="${cell}"] [data-testid="lionfish-components"]`).waitFor({ timeout: 30_000 });
  const cardLinks = await page.locator('[data-testid="lionfish-card"] a[href^="http"]').count();
  if (cardLinks === 0) fail(`the priority card ${cell} has no external link`);
  log(`priority card ${cell}: ${cardLinks} links`);
  await scan(page, seen, "priority card");
  await page.click('[data-testid="lionfish-card-panel"] button[aria-label="Close panel"]');
  await page.click('[data-area="fl-keys"]');
  await page.click('[data-testid="lionfish-help-open"]');
  await page.locator('[data-testid="lionfish-help"]').waitFor();
  const sources = await page.locator('[data-testid="lionfish-help"] [data-help-source] a').count();
  if (sources === 0) fail("the ocean-data help has no source link");
  log(`ocean-data help: ${sources} source links`);
  await scan(page, seen, "ocean-data help");
  await page.keyboard.press("Escape");
}

async function main() {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: `links-${APP}`, app: APP, apps: [APP], nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const seen = new Map<string, Link & { ok: boolean }>();
  /** The last stage started; "done" once every surface was visited. */
  let stage = "load";
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(TURN_TIMEOUT_MS);
    const clock = CLOCK[APP];
    if (clock !== null) await page.clock.setFixedTime(clock);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(tapAgentStreams);
    await page.goto(`${stack.origin}/?app=${APP}`, { waitUntil: "load" });
    await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    if (await page.locator('[data-testid="lionfish-banner-dismiss"]').count()) await page.click('[data-testid="lionfish-banner-dismiss"]');
    await scan(page, seen, "load");

    // 1. The agent answer.
    stage = "answer";
    await ask(page, QUESTIONS[APP], TURN_TIMEOUT_MS);
    const answer = (await page.locator('[data-chat-column] [data-source="text"]').last().textContent()) ?? "";
    log(`answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
    const markdown = await page.locator("[data-chat-column] [data-source='text'] a[href^='http']:not([data-source-page])").count();
    log(`answer: ${markdown} markdown links`);
    await scan(page, seen, "answer");

    // 2. The evidence drawer's "Open at <publisher>" link on a cited record.
    stage = "drawer";
    if (APP === "python") await pythonAnswer(page);
    else await citedRecord(page, stack);
    if (process.env.LINKS_SHOT) await page.screenshot({ path: process.env.LINKS_SHOT });
    await scan(page, seen, "drawer");
    await page.keyboard.press("Escape");

    // 3. The app's own surfaces.
    stage = "app_surfaces";
    if (APP === "carp") await carpSurfaces(page, seen);
    if (APP === "lionfish") await lionfishSurfaces(page, seen);

    // 4. About/status popover (about, data sources, expert layers) with its sections open, then the help sheet it opens.
    stage = "status_popover";
    const popover = page.locator("[data-testid=status-button]");
    await popover.waitFor({ timeout: 10_000 });
    await popover.click();
    await page.locator("[data-testid=status-popover]").waitFor();
    for (const section of await page.locator("[data-testid=status-popover] details > summary").all()) await section.click();
    await page.waitForTimeout(500);
    await scan(page, seen, "status popover");
    await page.locator("[data-testid=status-popover] [data-testid=help-button]").click();
    await page.locator("[data-testid=help-sheet]").waitFor();
    await scan(page, seen, "help sheet");
    await page.keyboard.press("Escape");

    // 5. Cesium credits and the "Data attribution" lightbox.
    stage = "data_attribution";
    const expand = page.locator(".cesium-credit-expand-link").first();
    if ((await expand.count()) > 0 && (await expand.isVisible())) {
      // Report what sits on top of the link, then open the lightbox with a DOM click: this check is about the
      // lightbox's anchors, and a covered link is a layout finding, not a link one.
      const cover = await expand.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top && !el.contains(top) ? (top.closest("[data-testid]")?.getAttribute("data-testid") ?? top.tagName) : null;
      });
      if (cover) log(`data attribution: the expand link is covered by ${cover} (not clickable by a user)`);
      await expand.dispatchEvent("click");
      await page.locator(".cesium-credit-lightbox").first().waitFor({ state: "attached" });
      await page.waitForTimeout(300);
      await scan(page, seen, "data attribution");
    } else log("data attribution: no expand link (all credits inline)");
    await scan(page, seen, "final");

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    stage = "done";
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
  } finally {
    await browser.close();
    await stack.stop();
  }
  const all = [...seen.values()];
  const byWhere = new Map<string, number>();
  for (const l of all) byWhere.set(l.where, (byWhere.get(l.where) ?? 0) + 1);
  log(`by place: ${[...byWhere].map(([w, n]) => `${w}=${n}`).join(" ")}`);
  const newTab = all.filter((l) => l.ok).length;
  const counts = `app=${APP} total=${all.length} new_tab=${newTab} unsafe=${all.length - newTab}`;
  // A run that did not visit every surface measured only part of the app: no EXTERNAL-LINKS line for it.
  if (stage !== "done") {
    console.log(`EXTERNAL-LINKS-INCOMPLETE ${counts} failed_at=${stage}`);
    process.exit(1);
  }
  console.log(`EXTERNAL-LINKS ${counts}`);
  if (all.length === 0 || newTab !== all.length) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[e2e:links] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
