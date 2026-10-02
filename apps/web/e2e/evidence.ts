/**
 * Following evidence to its source, per app (rubric `evidence-source/evidence-e2e`), on the real stack (e2e/stack.ts:
 * Axum over the app's fixture backfill, the production e2e build, the signal Worker, the Caddy-like proxy) with
 * the real agent (GPT-6 Luna on OpenRouter; `bun run e2e:evidence` wraps `doppler run --project inversa --config
 * dev`, which hands the Next server its model key; the key is never printed).
 *
 *   bun run e2e:evidence -- --app <id>    build, run, print the EVIDENCE line
 *   E2E_SKIP_BUILD=1 …                     reuse the last e2e build
 *
 * In the chat column, ask the app's question; its answer carries citation chips. Each chip's record is looked up
 * through the API (`evidence(id)`, which names the feed it came from), and for one chip per distinct feed:
 *
 *   citation     the chip is in the answer and a click selects its record;
 *   drawer       the evidence drawer opens on that id (`hud-drawer-id`), loaded, without an error;
 *   raw          under "Details for experts", the "Raw payload" section opens and shows the payload the API holds
 *                for the record (non-null, rendered as a tree with at least one of its keys);
 *   source_link  the drawer's "Open at <publisher>" link is the API's `sourcePageUrl`, https on an allowlisted host (a
 *                record the publisher has no page for, e.g. an Open-Meteo model point, must show no link and never
 *                counts towards `sources`);
 *   new_tab      the link has target=_blank and rel noopener (and noreferrer), and a click opens a new page at that
 *                URL whose `window.opener` is null (publisher hosts are answered locally, so no request leaves);
 *   sources      distinct feeds whose record passed all of the above.
 *
 * When the first answer cites fewer than three feeds, one follow-up asks for its records from three feeds.
 * Line: `EVIDENCE app=<id> citation=ok drawer=ok raw=ok source_link=ok new_tab=ok sources=<n>`; exit 0 only when
 * every field is ok and sources >= 3.
 */
import { chromium, type BrowserContext, type Page } from "playwright";

import type { AppId } from "../shared/apps";
import { PUBLISHERS, publisherOf } from "../shared/source-pages";
import { appArg } from "./args";
import { ask, tapAgentStreams } from "./agent-ui";
import { buildApi, buildWeb, startStack, type Stack } from "./stack";

const APP: AppId = appArg();
const TURN_TIMEOUT_MS = 240_000;
const LOAD_TIMEOUT_MS = 120_000;
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];
/** Page clocks: just after the fixtures were recorded (lionfish pinned as in e2e/lionfish.ts; carp runs on the wall clock). */
const CLOCK: Record<AppId, number | null> = { python: Date.parse("2026-09-30T21:00:00Z"), lionfish: Date.parse("2026-10-01T09:00:00Z"), carp: null };
/** The turns asked, in order: questions a user of the app asks whose answers rest on records from several feeds. */
const QUESTIONS: Record<AppId, string[]> = {
  python: [
    "Show me the Burmese python sightings in the Everglades from the last 30 days and the latest water level at the USGS gauges nearest to them. Cite each sighting and each gauge reading you use.",
  ],
  carp: [
    "For Krotz Springs: what is the latest USGS gauge reading, what does the current river forecast say and how does it differ from the forecast issued on September 28, and how much rain does the NWS weather forecast give there? Cite each record you use.",
  ],
  lionfish: [
    "Show lionfish reports in the Mexican Caribbean from the last 30 days. Cite each report.",
    "What are the Coral Reef Watch heat stress and the NDBC buoy water temperature in the Florida Keys now? Cite the records.",
  ],
};
const FOLLOW_UP =
  "Please cite the individual records behind that answer (the sightings, gauge readings, forecasts, alerts or heat stress cells themselves, not fetch runs), from at least three different data feeds.";
/** Evidence kinds that are a publisher's record (a fetch run, review, hotspot, backtest, survey cell or note is ours). */
const RECORD_KINDS = new Set(["sighting", "reading", "alert", "forecast"]);

const log = (...a: unknown[]) => console.error(`[e2e:evidence ${APP}]`, ...a);
const ok = (b: boolean) => (b ? "ok" : "fail");

type ApiEvidence = { id: string; kind: string; raw: unknown; sourcePageUrl: string | null; feed: { source: string } | null };

async function lookup(stack: Stack, id: string): Promise<ApiEvidence | null> {
  try {
    const { evidence } = await stack.graphql<{ evidence: ApiEvidence }>("query($id: ID!) { evidence(id: $id) { id kind raw sourcePageUrl feed { source } } }", { id });
    return evidence;
  } catch (err) {
    log(`evidence(${id}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The answers' citations: inline chips and each answer's numbered Evidence list. */
const CITATIONS = '[data-chat-column] .agent-cite[data-evidence-id], [data-chat-column] [aria-label="Evidence"] [data-evidence-id]';
const chipIds = (page: Page) => page.locator(CITATIONS).evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("data-evidence-id") ?? ""))].filter(Boolean));

type Check = { feed: string; id: string; citation: boolean; drawer: boolean; raw: boolean; sourceLink: boolean; newTab: boolean; noPage: boolean };

async function follow(page: Page, context: BrowserContext, id: string, api: ApiEvidence): Promise<Check> {
  const feed = api.feed?.source ?? api.kind;
  const c: Check = { feed, id, citation: false, drawer: false, raw: false, sourceLink: false, newTab: false, noPage: false };
  const chip = page.locator(CITATIONS).and(page.locator(`[data-evidence-id="${id}"]`)).first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  c.citation = await page
    .waitForFunction((want) => (window.__inversa?.state("SELECTION") as { evidenceId?: string } | undefined)?.evidenceId === want, id, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const drawer = page.locator('[data-testid="hud-drawer"]');
  c.drawer = await page
    .waitForFunction((want) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === want, id, { timeout: 30_000 })
    // The record sits under the collapsed "Details for experts": attached once loaded, visible after the click below.
    .then(() => drawer.locator('[aria-label="Normalized record"]').waitFor({ state: "attached", timeout: 30_000 }))
    .then(async () => (await drawer.isVisible()) && (await drawer.locator('[role="alert"]').count()) === 0)
    .catch((err: unknown) => (log(`${id}: drawer ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`), false));

  // Raw payload, under "Details for experts".
  if (c.drawer) {
    const expert = drawer.locator('[data-testid="drawer-expert"]');
    if (!(await expert.evaluate((el) => (el as HTMLDetailsElement).open))) await expert.locator(":scope > summary").click();
    const rawSection = drawer.locator('[aria-label="Raw payload"] > details');
    if (!(await rawSection.evaluate((el) => (el as HTMLDetailsElement).open))) await rawSection.locator(":scope > summary").click();
    const shown = ((await rawSection.textContent()) ?? "").replace(/^Raw payload[^)]*\)/, "");
    const keys = api.raw && typeof api.raw === "object" ? Object.keys(api.raw as object).slice(0, 20) : [];
    c.raw = api.raw !== null && api.raw !== undefined && !/No raw payload archived/.test(shown) && keys.some((k) => shown.includes(k));
    if (!c.raw) log(`${id}: raw ${api.raw === null ? "null in the API" : `not shown (keys ${keys.join(",")}; drawer "${shown.slice(0, 120)}")`}`);
  }

  // The publisher link in the drawer header, and the new tab it opens.
  const link = drawer.locator('[data-testid="source-page-link"]');
  if (c.drawer && (await link.count()) === 1) {
    const href = (await link.getAttribute("href")) ?? "";
    const rel = new Set(((await link.getAttribute("rel")) ?? "").split(/\s+/));
    const target = await link.getAttribute("target");
    c.sourceLink = href === api.sourcePageUrl && publisherOf(href) !== null;
    const [popup] = await Promise.all([context.waitForEvent("page", { timeout: 15_000 }), link.click()]);
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const opener = await popup.evaluate(() => window.opener === null).catch(() => false);
    c.newTab = target === "_blank" && rel.has("noopener") && rel.has("noreferrer") && popup.url() === href && opener;
    log(`${id} (${feed}): Open at ${publisherOf(href)} → ${href}; new page ${popup.url()} opener=${opener ? "null" : "set"} rel="${[...rel].join(" ")}"`);
    await popup.close();
  } else if (c.drawer && api.sourcePageUrl === null) {
    // No page at the publisher for this kind of record (api/src/source_pages.rs: Open-Meteo model points, GOES
    // cells): the drawer must not invent one. It counts as shown correctly, never towards `sources`.
    c.noPage = true;
    c.sourceLink = (await link.count()) === 0;
    c.newTab = c.sourceLink;
    log(`${id} (${feed}): no publisher page for this record (API sourcePageUrl null), drawer shows ${await link.count()} link(s)`);
  } else if (c.drawer) log(`${id} (${feed}): no publisher link in the drawer, API sourcePageUrl ${api.sourcePageUrl}`);
  await page.keyboard.press("Escape").catch(() => {});
  return c;
}

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  const stack = await startStack({ name: `evidence-${APP}`, app: APP, apps: [APP], nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  let line = `EVIDENCE app=${APP} citation=fail drawer=fail raw=fail source_link=fail new_tab=fail sources=0`;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // Publisher pages are answered here: the check is that the link opens a new tab at the URL, not the site.
    await context.route((url) => Object.hasOwn(PUBLISHERS, url.hostname), (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>publisher</title>" }));
    const page = await context.newPage();
    const clock = CLOCK[APP];
    if (clock !== null) await page.clock.setFixedTime(clock);
    page.setDefaultTimeout(TURN_TIMEOUT_MS);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(tapAgentStreams);
    await page.goto(`${stack.origin}/?app=${APP}`, { waitUntil: "load" });
    await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    if (await page.locator('[data-testid="lionfish-banner-dismiss"]').count()) await page.click('[data-testid="lionfish-banner-dismiss"]');

    for (const q of QUESTIONS[APP]) {
      await ask(page, q, TURN_TIMEOUT_MS);
      const text = (await page.locator('[data-chat-column] [data-source="text"]').last().textContent()) ?? "";
      log(`asked "${q.slice(0, 60)}…"; answer: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    const byFeed = new Map<string, { id: string; api: ApiEvidence }>();
    const classify = async () => {
      const ids = await chipIds(page);
      log(`citations: ${ids.join(" ")}`);
      for (const id of ids) {
        if (!RECORD_KINDS.has(id.slice(0, id.indexOf(":")))) continue;
        const api = await lookup(stack, id);
        if (!api) continue;
        const feed = api.feed?.source ?? api.kind;
        // One record per feed, one with a publisher page when the answer cites any.
        const had = byFeed.get(feed);
        if (!had || (!had.api.sourcePageUrl && api.sourcePageUrl)) byFeed.set(feed, { id, api });
      }
    };
    await classify();
    log(`answers: chips from ${byFeed.size} feeds: ${[...byFeed].map(([f, v]) => `${f}=${v.id}`).join(" ")}`);
    const linked = () => [...byFeed.values()].filter((v) => v.api.sourcePageUrl).length;
    if (linked() < 3) {
      await ask(page, FOLLOW_UP, TURN_TIMEOUT_MS);
      await classify();
      log(`after the follow-up: chips from ${byFeed.size} feeds: ${[...byFeed].map(([f, v]) => `${f}=${v.id}`).join(" ")}`);
    }
    if (byFeed.size === 0) throw new Error("the answer has no citation chip the API resolves");

    const checks: Check[] = [];
    for (const { id, api } of byFeed.values()) checks.push(await follow(page, context, id, api));
    for (const c of checks) log(`${c.feed}: ${c.id} citation=${ok(c.citation)} drawer=${ok(c.drawer)} raw=${ok(c.raw)} source_link=${ok(c.sourceLink)} new_tab=${ok(c.newTab)}`);
    const linkedChecks = checks.filter((c) => !c.noPage);
    // A link check passes only when at least one cited record had a publisher page to open.
    const all = (k: "citation" | "drawer" | "raw" | "sourceLink" | "newTab") => ok(checks.every((c) => c[k]) && (k === "sourceLink" || k === "newTab" ? linkedChecks.length > 0 : true));
    const sources = linkedChecks.filter((c) => c.citation && c.drawer && c.raw && c.sourceLink && c.newTab).length;
    line = `EVIDENCE app=${APP} citation=${all("citation")} drawer=${all("drawer")} raw=${all("raw")} source_link=${all("sourceLink")} new_tab=${all("newTab")} sources=${sources}`;
    if (errors.length) log(`page errors: ${errors.slice(0, 5).join(" | ")}`);
    await context.close();
  } catch (err) {
    log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    log(stack.logs());
    process.exitCode = 1;
  } finally {
    await browser.close();
    await stack.stop();
  }
  console.log(line);
  if (!/citation=ok drawer=ok raw=ok source_link=ok new_tab=ok sources=([3-9]|\d\d+)$/.test(line)) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

