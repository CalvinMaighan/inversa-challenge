/**
 * GE9 checks for e2e/stage.ts (gates/leaf-GE9.md G2, G3, G4, G9): the 12 px rhythm, the Look button in the top-right
 * cluster, and the data attribution in the chat card's header. Each runs on a page e2e/stage.ts opened.
 */
import path from "node:path";

import type { Browser, Page } from "playwright";

import { annotate, offPairs, spacingPairs, type Pair } from "./spacing";
import { REPO_DIR } from "./stack";

const log = (...a: unknown[]) => console.error("[e2e:stage]", ...a);

/** Every pair measured so far, by group: `python` (G2), the apps and widths of G3, and the phone docks. */
export const spacing = { python: [] as Pair[], apps: [] as Pair[], mobile: [] as Pair[] };

/** Measure the pairs on the page as it is now, log them, and file them under `group`. */
export async function measureSpacing(page: Page, label: string, group: keyof typeof spacing, annotatedShot?: string): Promise<Pair[]> {
  await page.waitForTimeout(300);
  const { pairs, notes } = await page.evaluate(spacingPairs);
  if (annotatedShot) {
    await page.evaluate(annotate, pairs);
    await page.screenshot({ path: annotatedShot });
    await page.evaluate(() => document.querySelector("[data-spacing-annotations]")?.remove());
  }
  const named = pairs.map((p) => ({ ...p, name: `${label} ${p.name}` }));
  const off = offPairs(named);
  log(`spacing ${label}: ${pairs.length} pairs, ${off.length} off${notes.length ? ` (${notes.join("; ")})` : ""}`);
  for (const p of named) log(`   ${Math.abs(p.px - 12) > 0.5 ? "OFF" : "ok "} ${p.px.toFixed(2).padStart(6)} px  ${p.name}`);
  spacing[group].push(...named);
  if (group === "python") spacing.apps.push(...named);
  return named;
}

export type LookButtonCheck = { topright: boolean; aligned: boolean; inside: boolean; bottomBarHasLook: boolean };

/**
 * The Look button: third of the four icon buttons (About, Theme, Look, Developer), icon only, named and a dialog
 * trigger; its popover opens below it with right edges aligned and stays inside the viewport. Esc closes it back onto
 * the button.
 */
export async function lookButton(page: Page, label: string, shot?: string): Promise<LookButtonCheck> {
  const info = await page.evaluate(() => {
    const ids = [...document.querySelectorAll<HTMLElement>('[data-testid="hud-topbar"] button[aria-haspopup="dialog"]')].map((b) => b.dataset.testid);
    const b = document.querySelector<HTMLElement>('[data-testid="look-button"]');
    const bar = document.querySelector('[data-testid="bottom-bar"]');
    return {
      ids,
      name: b?.getAttribute("aria-label") ?? "",
      text: b?.innerText.trim() ?? "?",
      haspopup: b?.getAttribute("aria-haspopup") ?? "",
      inTopbar: !!b?.closest('[data-testid="hud-topbar"]'),
      bottomBarHasLook: !!bar?.querySelector('[data-testid="look-button"], [data-testid="look-popover"]') || /\bLook\b/.test((bar as HTMLElement | null)?.innerText ?? ""),
    };
  });
  const topright = info.inTopbar && info.ids.join(",") === "status-button,theme-button,look-button,developer-button" && info.name === "Look: filters and map window" && info.text === "" && info.haspopup === "dialog";
  await page.locator('[data-testid="look-button"]').click();
  const pop = page.locator('[data-testid="look-popover"]');
  await pop.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(250);
  const geo = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="look-button"]')!.getBoundingClientRect();
    const p = document.querySelector('[data-testid="look-popover"]')!.getBoundingClientRect();
    return { b: { right: b.right, bottom: b.bottom }, p: { left: p.left, top: p.top, right: p.right, bottom: p.bottom }, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
  });
  const aligned = Math.abs(geo.p.right - geo.b.right) <= 1 && geo.p.top >= geo.b.bottom;
  const inside = geo.p.left >= 0 && geo.p.top >= 0 && geo.p.right <= geo.vw && geo.p.bottom <= geo.vh;
  if (shot) await page.screenshot({ path: shot });
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached", timeout: 5_000 });
  log(`look button ${label}: order ${info.ids.join(",")}, name "${info.name}", popover ${JSON.stringify(geo.p)} under the button ending at x=${geo.b.right.toFixed(1)}; aligned ${aligned}, inside ${inside}, in the bottom bar ${info.bottomBarHasLook}`);
  return { topright, aligned, inside, bottomBarHasLook: info.bottomBarHasLook };
}

export type CreditCheck = { inheader: boolean; sameRow: boolean; rightAligned: boolean; wraps: boolean; lightbox: boolean; newtab: boolean; route: string };

/** The credit row's geometry in the chat card's header (desktop) or the dock's top (phone). */
async function creditGeometry(page: Page) {
  return page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>("[data-credit-slot]");
    const credits = slot?.querySelector<HTMLElement>("[data-globe-credits]");
    const header = document.querySelector<HTMLElement>("[data-chat-header]");
    const link = credits?.querySelector<HTMLElement>(".cesium-credit-expand-link");
    const r = (el: Element | null | undefined) => {
      const b = el?.getBoundingClientRect();
      return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
    };
    const parts = [...(credits?.querySelectorAll<HTMLElement>(".cesium-credit-logoContainer img, .cesium-credit-textContainer > *, .cesium-credit-expand-link") ?? [])].map(r).filter((b) => b && b.width > 0 && b.height > 0) as NonNullable<ReturnType<typeof r>>[];
    const tabs = [...document.querySelectorAll('[data-tabs] [role="tab"]')].map(r).filter(Boolean) as NonNullable<ReturnType<typeof r>>[];
    const hs = header ? getComputedStyle(header) : null;
    return {
      inHeader: !!credits && !!header && header.contains(credits),
      slot: r(slot),
      link: r(link),
      linkText: link?.textContent ?? "",
      parts,
      tabs,
      headerContentRight: header && hs ? header.getBoundingClientRect().right - Number.parseFloat(hs.paddingRight) - Number.parseFloat(hs.borderRightWidth) : null,
      overflow: slot ? slot.scrollWidth - slot.clientWidth : -1,
      card: r(document.querySelector("[data-chat-column]")),
      route: document.querySelector<HTMLElement>("[data-imagery-route]")?.dataset.imageryRoute ?? "none",
    };
  });
}

/**
 * The attribution in the chat card's header: one row on the tabs' line, right-aligned with the header's content edge,
 * not wrapped and not overflowing at the 420 px card; the "Data attribution" lightbox opens with Enter over the whole
 * page (focus inside), closes with Esc onto the link, and every link in the credits and the lightbox opens a new tab.
 */
export async function creditsInHeader(page: Page, shot?: string): Promise<CreditCheck> {
  const g = await creditGeometry(page);
  const tab = g.tabs[0];
  const centre = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
  const sameRow = !!tab && !!g.link && g.parts.length > 0 && g.parts.every((p) => centre(p) >= tab.top && centre(p) <= tab.bottom) && Math.max(...g.parts.map((p) => p.bottom)) - Math.min(...g.parts.map((p) => p.top)) <= 18;
  const rightAligned = !!g.link && g.headerContentRight !== null && Math.abs(g.link.right - g.headerContentRight) <= 1;
  const rowHeight = g.parts.length ? Math.max(...g.parts.map((p) => p.bottom)) - Math.min(...g.parts.map((p) => p.top)) : 0;
  const wraps = !g.slot || rowHeight > 18 || g.overflow > 0 || g.parts.some((p) => p.left < g.slot!.left - 0.5 || p.right > g.slot!.right + 0.5);
  log(`credits: in header ${g.inHeader}, card ${g.card?.width}px, slot ${JSON.stringify(g.slot)}, link "${g.linkText}" ${JSON.stringify(g.link)}, header content right ${g.headerContentRight}, parts ${g.parts.length}, overflow ${g.overflow}, tab ${JSON.stringify(tab)}`);
  if (shot && g.card) await page.screenshot({ path: shot, clip: { x: g.card.left, y: g.card.top, width: g.card.width, height: 80 } });

  // The lightbox, by keyboard.
  const link = page.locator("[data-credit-slot] .cesium-credit-expand-link");
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>(".cesium-credit-lightbox-overlay");
    const box = document.querySelector<HTMLElement>(".cesium-credit-lightbox");
    if (!overlay || !box || getComputedStyle(overlay).display === "none") return { shown: false, focusIn: false, onTop: false };
    const b = box.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(20, b.height / 2));
    return { shown: true, focusIn: box.contains(document.activeElement), onTop: !!top && box.contains(top) };
  });
  const links = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("[data-globe-credits] a[href], .cesium-credit-lightbox a[href]")].map((a) => ({ href: a.href, target: a.target, rel: a.rel })),
  );
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-lightbox.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>(".cesium-credit-lightbox-overlay");
    return { hidden: !overlay || getComputedStyle(overlay).display === "none", back: !!document.activeElement?.classList.contains("cesium-credit-expand-link") };
  });
  const external = links.filter((l) => /^https?:/.test(l.href));
  const newtab = external.length > 0 && external.every((l) => l.target === "_blank" && /noopener/.test(l.rel) && /noreferrer/.test(l.rel));
  const lightbox = opened.shown && opened.focusIn && opened.onTop && closed.hidden && closed.back;
  log(`lightbox: shown ${opened.shown}, focus inside ${opened.focusIn}, on top ${opened.onTop}; Esc closed ${closed.hidden}, focus back on the link ${closed.back}; ${external.length} external links, all new tab ${newtab}`);
  return { inheader: g.inHeader && !!g.link, sameRow, rightAligned, wraps, lightbox, newtab, route: g.route };
}

/** At a narrower card the ion logo collapses to its mark and the link stays, still one row. */
export async function creditsNarrow(page: Page): Promise<boolean> {
  const g = await creditGeometry(page);
  const rowHeight = g.parts.length ? Math.max(...g.parts.map((p) => p.bottom)) - Math.min(...g.parts.map((p) => p.top)) : 99;
  const ok = g.inHeader && !!g.link && !!g.slot && rowHeight <= 18 && g.overflow <= 0 && g.link.width > 0 && g.link.right <= g.slot.right + 0.5;
  log(`credits at a ${g.card?.width}px card: slot ${JSON.stringify(g.slot)}, link ${JSON.stringify(g.link)}, overflow ${g.overflow}: ${ok ? "one row" : "NOT one row"}`);
  return ok;
}

/** Phone: the credit sits at the top of the chat dock, visible, link shown. */
export async function creditsInDock(page: Page): Promise<boolean> {
  const r = await page.evaluate(() => {
    const dock = document.querySelector("[data-chat-column]")?.getBoundingClientRect();
    const link = document.querySelector("[data-credit-slot] .cesium-credit-expand-link")?.getBoundingClientRect();
    if (!dock || !link) return { ok: false, why: "no dock or link" };
    const top = document.elementFromPoint(link.left + link.width / 2, link.top + link.height / 2);
    return { ok: link.width > 0 && link.top >= dock.top && link.bottom <= dock.top + 24 && link.right <= dock.right && !!top?.closest("[data-credit-slot]"), why: JSON.stringify({ dock: dock.top, link: [link.left, link.top, link.right, link.bottom] }) };
  });
  log(`credits in the phone dock: ${r.ok ? "visible" : "NOT visible"} ${r.why}`);
  return r.ok;
}

/** The Miami zone of Google 3D (client/globe/ladder.ts GOOGLE_3D_ZONE), low enough for the photorealistic tiles. */
const MIAMI = { lat: 25.774, lon: -80.193, altitudeM: 1_500 };
/** The page origin of `bun run dev` (scripts/dev.ts INVERSA_WEB_PORT), the one the user's browser keys allow. */
const DEV_ORIGIN = `http://localhost:${process.env.INVERSA_WEB_PORT ?? "3050"}`;

/**
 * Google 3D active (the build carries the user's browser key from Doppler; never read or printed here): fly low over
 * Miami, wait for the tileset, then Google's credit must show in the header row, inside the slot and not clipped.
 */
export async function creditsWithGoogle3d(browser: Browser, origin: string, clock: string, errors: string[]): Promise<{ visible: boolean; state: string; shot: string | null }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.clock.install({ time: new Date(clock) });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`google3d pageerror: ${e.message}`));
  // The user's browser keys allow only the dev page's origin (`bun run dev`: http://localhost:3050, docs/HUMAN_STEPS.md)
  // and this stack serves on a free port. So the page opens at the dev origin and every request to it, HTTP and
  // websocket, is answered by this stack inside the browser: nothing reaches whatever listens on that port.
  const dev = new URL(DEV_ORIGIN);
  await context.route(
    (url) => url.origin === dev.origin,
    async (route) => route.fulfill({ response: await route.fetch({ url: route.request().url().replace(dev.origin, origin), maxRedirects: 0 }) }),
  );
  await context.routeWebSocket(
    (url) => url.host === dev.host,
    (ws) => {
      // Piped to this stack by hand (`connectToServer` would dial the real port).
      const server = new WebSocket(ws.url().replace(`ws://${dev.host}`, origin.replace(/^http/, "ws")), ws.protocols());
      server.binaryType = "arraybuffer";
      const toServer = (m: string | Buffer) => server.send(typeof m === "string" ? m : new Uint8Array(m));
      const queue: (string | Buffer)[] = [];
      server.addEventListener("open", () => queue.splice(0).forEach(toServer));
      server.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
      server.addEventListener("close", (e) => void ws.close({ code: e.code === 1005 ? 1000 : e.code, reason: e.reason }).catch(() => {}));
      ws.onMessage((m) => (server.readyState === WebSocket.OPEN ? toServer(m) : queue.push(m)));
      ws.onClose(() => server.close());
    },
  );
  // A refused provider request says why in its body (never the key itself; any key in a URL is blanked anyway).
  let refusals = 0;
  page.on("response", (res) => {
    if (res.status() < 400 || !/googleapis\.com|cesium\.com/.test(res.url()) || refusals++ >= 3) return;
    const host = new URL(res.url()).host;
    void res
      .text()
      .then((body) => log(`google 3d: ${host} answered ${res.status()}: ${body.replace(/(key|access_token|token)=[^&\s"']+/gi, "$1=REDACTED").replace(/\s+/g, " ").slice(0, 240)}`))
      .catch(() => {});
  });
  await page.goto(`${DEV_ORIGIN}/?app=python#v=2&app=python&c=${MIAMI.lat},${MIAMI.lon},${MIAMI.altitudeM},0,-60`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__inversa?.globe(), undefined, { timeout: 120_000 });
  let state = "off";
  for (let i = 0; i < 90; i++) {
    state = (await page.evaluate(() => window.__inversa?.globe()?.imagery.google3d ?? "none")) as string;
    if (state === "shown" || state === "failed") break;
    await page.waitForTimeout(1_000);
  }
  const route = await page.evaluate(() => window.__inversa?.globe()?.imagery.google3dRoute ?? null);
  // Why a load failed, with any key in a URL blanked out: a key is never printed.
  const why = (await page.evaluate(() => window.__inversa?.globe()?.imagery.errors ?? [])).map((e) => String(e).replace(/(key|access_token|token)=[^&\s"']+/gi, "$1=REDACTED").slice(0, 300));
  if (why.length) log(`google 3d errors: ${why.join(" | ")}`);
  await page.waitForTimeout(3_000);
  const g = await page.evaluate(() => {
    const slot = document.querySelector("[data-credit-slot]");
    const s = slot?.getBoundingClientRect();
    // The row itself (the slot keeps a few px of padding for focus rings).
    const row = slot?.querySelector("[data-globe-credits]")?.getBoundingClientRect();
    const google = [...(slot?.querySelectorAll<HTMLElement>(".cesium-credit-textContainer *, .cesium-credit-logoContainer *") ?? [])].filter((el) => /google/i.test(`${el.textContent ?? ""} ${(el as HTMLImageElement).src ?? ""} ${el.getAttribute("alt") ?? ""} ${el.getAttribute("title") ?? ""}`));
    const shown = google
      .map((el) => el.getBoundingClientRect())
      .filter((b) => s && b.width > 0 && b.height > 0 && b.left >= s.left - 0.5 && b.right <= s.right + 0.5 && b.top >= s.top - 0.5 && b.bottom <= s.bottom + 0.5);
    const imgs = [...(slot?.querySelectorAll("img") ?? [])].map((i) => `${new URL(i.src, location.href).host}${new URL(i.src, location.href).pathname.slice(-40)} ${i.naturalWidth}x${i.naturalHeight}`);
    return { found: google.length, shown: shown.length, text: (slot?.querySelector(".cesium-credit-textContainer") as HTMLElement | null)?.innerText.slice(0, 160) ?? "", height: row?.height ?? -1, imgs, html: slot?.querySelector(".cesium-credit-textContainer")?.innerHTML.replace(/src="[^"]*"/g, 'src="…"').slice(0, 500) ?? "" };
  });
  const shot = path.join(REPO_DIR, "docs/evidence/ge9-credit-google3d.png");
  await page.screenshot({ path: shot });
  log(`google 3d: ${state} via ${route}; Google credit elements in the header ${g.found}, fully shown ${g.shown}; credit row ${g.height}px tall; on-screen credit text "${g.text.replace(/\s+/g, " ")}"; images ${g.imgs.join(", ")}`);
  log(`google 3d: on-screen credit markup ${g.html}`);
  await context.close();
  return { visible: state === "shown" && g.shown > 0 && g.height > 0 && g.height <= 18, state, shot };
}
