/**
 * External links open in a new tab (gates/leaf-T42.md G7), on the real stack (e2e/stack.ts) with the real agent.
 * The Next server gets its model key from Doppler unless `OPENROUTER_API_KEY` is set; the key is never printed.
 *
 *   bun run e2e:links           build, run, print EXTERNAL-LINKS last
 *   E2E_SKIP_BUILD=1 …          reuse the last e2e build
 *
 * On the ops page `/`: ask a question whose answer is a sightings table (rows with a ↗ to iNaturalist) and a
 * markdown link, open the evidence drawer on an iNaturalist sighting (its "Open at iNaturalist" link), the help
 * sheet, the status popover when the build has one, and Cesium's "Data attribution" lightbox. After each, every
 * `a[href^=http]` not on the app origin must have `target=_blank` and a `rel` with `noopener` and `noreferrer`.
 */
import { chromium, type Page } from "playwright";

import { buildApi, buildWeb, startStack } from "./stack";

const QUESTION =
  "Show me the green iguana sightings around Miami between 30 January and 3 February 2026, during the cold snap, as a table. " +
  "End your answer with a markdown link to https://www.inaturalist.org/ where readers can find more records.";
const TURN_TIMEOUT_MS = 240_000;
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];
/** Status popover trigger (top bar), when the build has one. */
const POPOVER_BUTTON = "[data-testid=status-button], [data-testid=status-popover-button]";

const log = (...a: unknown[]) => console.error("[e2e:links]", ...a);

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

type Tapped = { status: number; done: boolean };

function tapAgentStreams(): void {
  const w = window as unknown as { __agentStreams: Tapped[] };
  w.__agentStreams = [];
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/agent/stream") || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const entry: Tapped = { status: res.status, done: false };
    w.__agentStreams.push(entry);
    void (async () => {
      const reader = mine.getReader();
      while (!(await reader.read()).done);
      entry.done = true;
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

async function ask(page: Page, text: string): Promise<void> {
  const column = page.locator("[data-chat-column]");
  const before = await page.evaluate(() => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams.length);
  const input = column.getByRole("textbox", { name: "Question" });
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]?.done === true, before, { timeout: TURN_TIMEOUT_MS });
  const status = await page.evaluate((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]!.status, before);
  if (status !== 200) fail(`agent stream answered ${status}`);
  await page.waitForFunction(
    () => !document.querySelector('[data-chat-column] [data-source="text"][data-status="streaming"], [data-chat-column] [data-source="text"][data-status="pending"]'),
    undefined,
    { timeout: 30_000 },
  );
}

async function main() {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: "links", scene: true, nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const seen = new Map<string, Link & { ok: boolean }>();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(TURN_TIMEOUT_MS);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(tapAgentStreams);
    await page.goto(`${stack.origin}/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__inversa?.globe() !== null && window.__inversa?.globe() !== undefined, undefined, { timeout: 120_000 });
    await page.locator("[data-chat-column]").waitFor();
    await scan(page, seen, "load");

    // 1. Agent answer: a sightings table whose rows link out, and a markdown link.
    await ask(page, QUESTION);
    const rowLinks = page.locator("[data-chat-column] a[data-source-page]");
    if ((await rowLinks.count()) === 0) {
      await ask(page, "Please call the sightings tool for green iguanas in Miami-Dade from 2026-01-30 to 2026-02-03 and show the table.");
    }
    const rows = await rowLinks.count();
    if (rows === 0) fail("no sightings table row carries a source page link");
    const inatRow = page.locator("[data-chat-column] a[data-source-page][href^='https://www.inaturalist.org/observations/']").first();
    const markdown = await page.locator("[data-chat-column] [data-source='text'] a[href^='http']:not([data-source-page])").count();
    log(`answer: ${rows} table row links, ${markdown} markdown links`);
    await scan(page, seen, "answer");

    // 2. The drawer on an iNaturalist sighting: the header "Open at iNaturalist" link.
    const tr = inatRow.locator("xpath=ancestor::tr[1]");
    const evidenceId = (await tr.getAttribute("data-evidence-id")) ?? fail("row without an evidence id");
    await tr.locator("td:not([data-kind=link])").first().click();
    await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent?.trim() === want, evidenceId, { timeout: 30_000 });
    const pageLink = page.locator("[data-testid=hud-drawer] [data-testid=source-page-link]");
    await pageLink.waitFor({ timeout: 30_000 });
    log(`drawer ${evidenceId}: "${(await pageLink.textContent())?.trim()}" → ${await pageLink.getAttribute("href")}`);
    if (process.env.LINKS_SHOT) await page.screenshot({ path: process.env.LINKS_SHOT });
    await scan(page, seen, "drawer");

    // 3. Help sheet.
    const help = page.locator("[data-testid=help-button]");
    if (await help.isVisible()) {
      await help.click();
      await page.locator("[data-testid=help-sheet]").waitFor();
      await scan(page, seen, "help sheet");
      await page.keyboard.press("Escape");
    } else log("help sheet: no visible [data-testid=help-button] in this build");

    // 4. Status popover (feeds, theme, focus, help) when the build has one.
    const popover = page.locator(POPOVER_BUTTON).first();
    if ((await popover.count()) > 0 && (await popover.isVisible())) {
      await popover.click();
      await page.waitForTimeout(500);
      await scan(page, seen, "status popover");
      await page.keyboard.press("Escape");
    } else log("status popover: not in this build");

    // 5. Cesium credits and the "Data attribution" lightbox.
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
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
  const all = [...seen.values()];
  const byWhere = new Map<string, number>();
  for (const l of all) byWhere.set(l.where, (byWhere.get(l.where) ?? 0) + 1);
  log(`by place: ${[...byWhere].map(([w, n]) => `${w}=${n}`).join(" ")}`);
  const newTab = all.filter((l) => l.ok).length;
  console.log(`EXTERNAL-LINKS total=${all.length} new_tab=${newTab} unsafe=${all.length - newTab}`);
  if (all.length === 0 || newTab !== all.length) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[e2e:links] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
