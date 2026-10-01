/**
 * Local media cache (docs/GODS_EYE.md GE3, gate G5) on the real stack (e2e/stack.ts: Axum over the python fixtures,
 * the production e2e build, the Caddy-like proxy): a sighting with a photo opened twice, with a page reload in
 * between, in one browser profile.
 *
 *   bun run e2e:media                 build, run, print the MEDIA line
 *   E2E_SKIP_BUILD=1 bun run e2e:media  reuse the last e2e build
 *
 *   first     where the drawer photo's bytes came from the first time (`data-media-source`: network)
 *   second    the same after a reload (cache: read from the Cache API, no request to /v1/<app>/media)
 *   img_ok    the second image decoded (naturalWidth > 0)
 *
 * Line: `MEDIA first=network second=cache img_ok=1 second_requests=0 photo=<sighting id>`; exit 0 only then. The
 * photo itself comes through Axum's media proxy from its upstream (iNaturalist open data), so this needs the network.
 */
import { chromium, type Page } from "playwright";

import { getApp } from "../shared/apps";
import { buildApi, buildWeb, startStack } from "./stack";

const APP = "python" as const;
const log = (...a: unknown[]) => console.error("[e2e:media]", ...a);

async function openPhoto(page: Page, id: string): Promise<{ source: string; width: number }> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#e=${encodeURIComponent(id)}`);
  await page.waitForFunction((w) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent === w, id, { timeout: 60_000 });
  const img = page.locator("[data-testid=evidence-photo]");
  await img.waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=evidence-photo]")?.getAttribute("data-media-source") !== "loading", undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (document.querySelector("[data-testid=evidence-photo]") as HTMLImageElement | null)?.complete === true, undefined, { timeout: 30_000 });
  return img.evaluate((el: HTMLImageElement) => ({ source: el.dataset.mediaSource ?? "", width: el.naturalWidth }));
}

async function main(): Promise<number> {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "media", app: APP });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    // The API caps a window at 31 days: walk back 30 days at a time over the last two years.
    const sightings: { id: string; photoUrl: string | null }[] = [];
    const MONTH = 30 * 86_400_000;
    for (let to = Date.now(), i = 0; i < 24 && !sightings.some((s) => s.photoUrl); i++, to -= MONTH) {
      const page = await stack.graphql<{ sightings: { id: string; photoUrl: string | null }[] }>(
        "query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id photoUrl } }",
        { b: getApp(APP).regions[0]!.bbox, f: new Date(to - MONTH).toISOString(), t: new Date(to).toISOString() },
      );
      sightings.push(...page.sightings);
    }
    const withPhoto = sightings.filter((s) => s.photoUrl);
    log(`${sightings.length} fixture sightings, ${withPhoto.length} with a photo`);
    if (withPhoto.length === 0) throw new Error("no fixture sighting has a photo");

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const mediaRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(`/v1/${APP}/media/`)) mediaRequests.push(r.url());
    });
    await page.goto(`${stack.origin}/?app=${APP}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=hud-topbar]").waitFor({ timeout: 120_000 });

    // The first photo the media proxy can actually serve (an upstream may have dropped one).
    let picked: string | null = null;
    let first = { source: "", width: 0 };
    for (const s of withPhoto.slice(0, 5)) {
      first = await openPhoto(page, `sighting:${s.id}`);
      if (first.source === "network" && first.width > 0) {
        picked = s.id;
        break;
      }
      log(`sighting:${s.id}: source=${first.source} width=${first.width}, trying the next`);
    }
    if (!picked) throw new Error(`no photo loaded from the network (last: ${JSON.stringify(first)})`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=hud-topbar]").waitFor({ timeout: 120_000 });
    const before = mediaRequests.length;
    const second = await openPhoto(page, `sighting:${picked}`);
    const secondRequests = mediaRequests.length - before;
    const imgOk = second.width > 0 ? 1 : 0;
    console.log(`MEDIA first=${first.source} second=${second.source} img_ok=${imgOk} second_requests=${secondRequests} photo=sighting:${picked}`);
    return first.source === "network" && second.source === "cache" && imgOk === 1 && secondRequests === 0 ? 0 : 1;
  } catch (err) {
    console.error(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
}

process.exit(await main());
