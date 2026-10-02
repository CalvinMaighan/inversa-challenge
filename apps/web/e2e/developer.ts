/**
 * The Developer panel, "Power up the globe" (docs/GODS_EYE.md "Developer panel spec", gate G3), on the real dev
 * supervisor: `bun scripts/dev.ts` (Axum, `next dev`, the signal Worker) on free ports, a temp INVERSA_DATA_DIR,
 * INVERSA_SOURCES=off and INVERSA_DOPPLER=off, so a developer's own `bun run dev` keeps running and none of their
 * secrets enter this stack. The child env drops every registry variable and sets one dummy server key
 * (`XAI_API_KEY`), which must show CONFIGURED EXTERNALLY. Every key typed here is a dummy.
 *
 *   bun run e2e:developer
 *
 *   rows            one row per KEY_REGISTRY entry, each with a status dot, a purpose line and a MANAGE or GET KEY
 *                   link opening in a new tab (target=_blank, rel noopener); badges BROWSER-SIDE and CONFIGURED
 *                   EXTERNALLY where they apply; password fields only on unset rows
 *   browser_inputs  paste fields of browser-side rows; server_inputs those of server-side rows
 *   persists        a dummy Google key saved through the panel is in localStorage after a reload and its row is set,
 *                   and a dummy AISStream key lands in <data>/local-keys.env (mode 0600), the supervisor restarts the
 *                   API and web, and the row turns set
 *   esc             Escape closes the modal and focus returns to the Developer button
 *   a11y            axe-core with the panel open: serious and critical violations
 *
 * Line: `DEVPANEL rows=<n> browser_inputs=<n> server_inputs=<n> persists=1 esc=ok a11y_serious=0 a11y_critical=0
 * restarted=1`; exit 0 only when every part holds.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { KEY_REGISTRY, type ServerKeyStatus } from "../shared/keys";
import { APP_DIR, freePort, portBusy, REPO_DIR, sleep } from "./dev-stack";

const log = (...a: unknown[]) => console.error("[e2e:developer]", ...a);
const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const READY_TIMEOUT_MS = 20 * 60_000;
const DUMMY_GOOGLE = "e2e-dummy-google-key-not-real";
const DUMMY_AIS = "e2e-dummy-aisstream-key-not-real";
const DUMMY_EXTERNAL = "e2e-dummy-external-xai";

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  return ok;
};

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number, dead?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead?.()) throw new Error(`${what}: the supervisor exited`);
    if (await probe()) return;
    await sleep(500);
  }
  throw new Error(`${what}: not ready after ${Math.round(timeoutMs / 1000)} s`);
}

async function openPanel(page: Page) {
  await page.locator("[data-testid=developer-button]").click();
  await page.locator("[data-testid=developer-panel][open]").waitFor({ timeout: 10_000 });
  // Server rows fill in once GET /api/dev/keys answers.
  await page.waitForFunction(() => document.querySelectorAll("[data-key-row][data-scope=server] input, [data-key-row][data-scope=server][data-set='1'], [data-key-row][data-scope=server] [data-key-command]").length >= 5, undefined, { timeout: 30_000 });
}

type RowInfo = { id: string; scope: string; set: string; dot: boolean; purpose: string; badges: string[]; link: { label: string; target: string | null; rel: string; href: string } | null; inputs: { name: string; type: string; placeholder: string }[] };

function readRows(page: Page): Promise<RowInfo[]> {
  return page.$$eval("[data-key-row]", (els) =>
    els.map((el) => {
      const a = el.querySelector("a[data-key-link]");
      return {
        id: el.getAttribute("data-key-row") ?? "",
        scope: el.getAttribute("data-scope") ?? "",
        set: el.getAttribute("data-set") ?? "",
        dot: el.querySelector("[data-status]") !== null,
        purpose: el.querySelector("p")?.textContent ?? "",
        badges: [...el.querySelectorAll("span")].map((s) => s.textContent ?? "").filter((t) => /^[A-Z -]+$/.test(t) && t.length > 6),
        link: a ? { label: a.textContent ?? "", target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "", href: a.getAttribute("href") ?? "" } : null,
        inputs: [...el.querySelectorAll("input[data-key-input]")].map((i) => ({ name: i.getAttribute("name") ?? "", type: i.getAttribute("type") ?? "", placeholder: i.getAttribute("placeholder") ?? "" })),
      };
    }),
  );
}

async function axe(page: Page): Promise<{ serious: number; critical: number }> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: unknown; failureSummary?: string }[] }[] }> } }).axe.run;
    return (await run(document, { resultTypes: ["violations"] })).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      n: v.nodes.length,
      nodes: v.nodes.slice(0, 8).map((n) => `${JSON.stringify(n.target)} ${(n.failureSummary ?? "").split("\n").slice(1, 2).join(" ").trim()}`),
    }));
  });
  for (const v of violations) log(`axe: ${v.impact} ${v.id} ×${v.n}\n  ${v.nodes.join("\n  ")}`);
  return { serious: violations.filter((v) => v.impact === "serious").length, critical: violations.filter((v) => v.impact === "critical").length };
}

async function main(): Promise<number> {
  const scratch = mkdtempSync(path.join(tmpdir(), "developer-e2e-"));
  // Screenshots outlive the run (git-ignored): the panel as the spec describes it, before and after saving.
  const shots = path.join(APP_DIR, ".cache/e2e-developer");
  mkdirSync(shots, { recursive: true });
  const dataDir = path.join(scratch, "data");
  mkdirSync(dataDir);
  const webPort = freePort();
  const apiPort = freePort(webPort);
  const signalPort = freePort(apiPort);
  for (const p of [webPort, apiPort, signalPort]) if (await portBusy(p)) throw new Error(`port ${p} busy`);
  const origin = `http://127.0.0.1:${webPort}`;
  const keysFile = path.join(dataDir, "local-keys.env");
  const logPath = path.join(scratch, "dev.log");

  // The supervisor's env: no registry variable from this shell (determinism, and none of your keys), one dummy external key.
  const registryVars = new Set<string>(KEY_REGISTRY.flatMap((k) => [...k.vars]));
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !registryVars.has(k)) env[k] = v;
  Object.assign(env, {
    INVERSA_WEB_PORT: String(webPort),
    INVERSA_WEB_HOST: "127.0.0.1",
    INVERSA_API_PORT: String(apiPort),
    INVERSA_SIGNAL_PORT: String(signalPort),
    INVERSA_DATA_DIR: dataDir,
    INVERSA_SOURCES: "off",
    INVERSA_DOPPLER: "off",
    NEXT_PUBLIC_SIGNAL_URL: `http://127.0.0.1:${signalPort}`,
    NEXT_TELEMETRY_DISABLED: "1",
    WRANGLER_SEND_METRICS: "false",
    BROWSER: "none",
    XAI_API_KEY: DUMMY_EXTERNAL,
  });
  const out = openSync(logPath, "a");
  const supervisor = spawn("bun", ["scripts/dev.ts"], { cwd: REPO_DIR, env, detached: true, stdio: ["ignore", out, out] });
  let exited = false;
  const exitedP = new Promise<void>((r) => supervisor.once("exit", () => ((exited = true), r())));
  const devLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const stop = async () => {
    if (!exited && supervisor.pid) {
      try {
        process.kill(supervisor.pid, "SIGTERM");
      } catch {}
      const t = setTimeout(() => {
        try {
          process.kill(-supervisor.pid!, "SIGKILL");
        } catch {}
      }, 15_000);
      await exitedP;
      clearTimeout(t);
    }
    await sleep(1_500);
    const left = [];
    for (const p of [webPort, apiPort]) if (await portBusy(p)) left.push(p);
    if (left.length) log(`warning: ports ${left.join(", ")} still answer after the supervisor stopped`);
  };

  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let page: Page | null = null;
  try {
    log(`supervisor: web ${origin}, api :${apiPort}, data ${dataDir}`);
    const shellUp = async () => {
      try {
        const res = await fetch(`${origin}/?app=carp`, { signal: AbortSignal.timeout(60_000) });
        return res.ok && (await res.text()).includes("data-shell");
      } catch {
        return false;
      }
    };
    await waitFor("web", shellUp, READY_TIMEOUT_MS, () => exited);
    log("web is up");

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // A dummy key must never reach Google: answer the Map Tiles API locally (the camera starts too high to ask anyway).
    let googleRequests = 0;
    await context.route("https://tile.googleapis.com/**", (route) => {
      googleRequests += 1;
      return route.fulfill({ status: 403, body: "blocked in e2e" });
    });
    page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f === page?.mainFrame()) navigations += 1;
    });
    await page.goto(`${origin}/?app=carp`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=developer-button]").waitFor({ timeout: 120_000 });

    // ---- the modal per the spec
    await openPanel(page);
    const head = (await page.locator("[data-testid=developer-panel] header").textContent()) ?? "";
    check(/Provider settings/.test(head) && /Power up the globe/.test(head) && /Esc to close/.test(head), `header: ${head}`);
    check(((await page.locator("[data-testid=developer-panel]").textContent()) ?? "").includes("The globe works without any keys"), "intro line");
    check((await page.locator("[data-testid=developer-save]").textContent())?.trim() === "SAVE KEYS", "one SAVE KEYS button");
    const rows = await readRows(page);
    check(rows.length === KEY_REGISTRY.length, `rows ${rows.length} != ${KEY_REGISTRY.length}`);
    for (const r of rows) {
      const entry = KEY_REGISTRY.find((k) => k.id === r.id);
      check(Boolean(entry), `unknown row ${r.id}`);
      check(r.dot, `${r.id}: status dot`);
      check(r.purpose === entry?.purpose, `${r.id}: purpose "${r.purpose}"`);
      check(r.link !== null && r.link.target === "_blank" && /noopener/.test(r.link.rel), `${r.id}: link opens in a new tab`);
      check(r.link?.label === (r.set === "1" ? "MANAGE" : "GET KEY"), `${r.id}: ${r.link?.label} with set=${r.set}`);
      check((r.scope === "browser") === r.badges.includes("BROWSER-SIDE"), `${r.id}: BROWSER-SIDE badge`);
      check(r.set === "1" ? r.inputs.length === 0 : r.inputs.length > 0, `${r.id}: paste fields only when unset (set=${r.set}, inputs=${r.inputs.length})`);
      for (const i of r.inputs) check(i.type === "password" && i.placeholder === i.name, `${r.id}: ${i.name} is a password field named by its variable`);
    }
    const xai = rows.find((r) => r.id === "xai");
    check(xai?.set === "1" && xai.badges.includes("CONFIGURED EXTERNALLY") && xai.inputs.length === 0, `xai external: ${JSON.stringify(xai)}`);
    const browserInputs = rows.filter((r) => r.scope === "browser").reduce((n, r) => n + r.inputs.length, 0);
    const serverInputs = rows.filter((r) => r.scope === "server").reduce((n, r) => n + r.inputs.length, 0);
    const a11y = await axe(page);
    check(a11y.serious === 0 && a11y.critical === 0, `axe serious=${a11y.serious} critical=${a11y.critical}`);
    await page.screenshot({ path: path.join(shots, "panel.png") });

    // ---- Esc closes and hands focus back
    await page.keyboard.press("Escape");
    await page.locator("[data-testid=developer-panel]").waitFor({ state: "detached", timeout: 5_000 });
    const esc = (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "developer-button" ? "ok" : "fail";
    check(esc === "ok", "Esc: focus back on the Developer button");

    // ---- a dummy browser key persists across a reload
    await openPanel(page);
    await page.fill("input[name=NEXT_PUBLIC_GOOGLE_MAPS_API_KEY]", DUMMY_GOOGLE);
    await page.fill("input[name=AISSTREAM_API_KEY]", DUMMY_AIS);
    const navigationsAtSave = navigations;
    await page.click("[data-testid=developer-save]");
    await page.waitForFunction(() => /saved/i.test(document.querySelector("[data-testid=developer-message]")?.textContent ?? ""), undefined, { timeout: 15_000 });
    const message = (await page.locator("[data-testid=developer-message]").textContent()) ?? "";
    check(!message.includes(DUMMY_GOOGLE) && !message.includes(DUMMY_AIS), "the message never shows a value");
    check(/restarting/.test(message), `server save says the supervisor restarts: ${message}`);

    // ---- the server key: file, mode, supervisor restart, row set
    await waitFor("local-keys.env", async () => existsSync(keysFile), 15_000);
    const mode = statSync(keysFile).mode & 0o777;
    const fileOk = check(mode === 0o600 && readFileSync(keysFile, "utf8").includes(`AISSTREAM_API_KEY=${DUMMY_AIS}\n`), `local-keys.env mode ${mode.toString(8)} with the key`);
    const status = async (): Promise<ServerKeyStatus | null> => {
      try {
        const res = await fetch(`${origin}/api/dev/keys`, { signal: AbortSignal.timeout(10_000) });
        const body = await res.text();
        check(!body.includes(DUMMY_AIS) && !body.includes(DUMMY_EXTERNAL), "GET /api/dev/keys never returns a value");
        return (JSON.parse(body) as ServerKeyStatus[]).find((s) => s.id === "aisstream") ?? null;
      } catch {
        return null;
      }
    };
    await waitFor("supervisor restart", async () => /local-keys\.env changed \(AISSTREAM_API_KEY\): restarting api and web/.test(devLog()), 30_000, () => exited);
    await waitFor("restarted web with the key", async () => (await status())?.source === "local", 10 * 60_000, () => exited);
    await waitFor("restart finished", async () => /restarted api and web with the new keys/.test(devLog()), 10 * 60_000, () => exited);
    const restarted = /restarted api and web with the new keys/.test(devLog()) ? 1 : 0;
    // The open panel polls through the restart and turns the row set by itself (unless Next reloaded the page).
    const live =
      navigations > navigationsAtSave
        ? "page-reloaded"
        : await Promise.race([
            page.waitForSelector("[data-key-row=aisstream][data-set='1']", { timeout: 60_000 }).then(() => "row-set"),
            page.waitForEvent("framenavigated", { timeout: 60_000 }).then(() => "page-reloaded"),
          ]).catch(() => "stuck");
    check(live !== "stuck", "the open panel never showed the restarted key as set");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=developer-button]").waitFor({ timeout: 120_000 });
    const stored = await page.evaluate(() => localStorage.getItem("inversa:keys:google-maps"));
    // The globe read the panel's key: route google-direct, base imagery still keyless Esri (no ion token here).
    const route = await page
      .waitForFunction(() => {
        const el = document.querySelector<HTMLElement>("[data-imagery-route]");
        return el && el.dataset.imagery !== "none" ? `${el.dataset.imageryRoute}/${el.dataset.imagery}` : null;
      }, undefined, { timeout: 60_000 })
      .then((h) => h.jsonValue())
      .catch(() => "none");
    check(route === "google-direct/esri", `globe imagery after the key: ${route}`);
    await openPanel(page);
    const after = await readRows(page);
    const google = after.find((r) => r.id === "google-maps");
    const ais = after.find((r) => r.id === "aisstream");
    const browserPersists = check(stored === DUMMY_GOOGLE && google?.set === "1" && google.inputs.length === 0 && google.link?.label === "MANAGE", `google row after reload: ${JSON.stringify(google)}`);
    const serverPersists = check(fileOk && ais?.set === "1" && ais.inputs.length === 0 && !ais.badges.includes("CONFIGURED EXTERNALLY"), `aisstream row after restart: ${JSON.stringify(ais)}`);
    const persists = browserPersists && serverPersists ? 1 : 0;
    // Again with keys set (MANAGE links, a REMOVE button): the panel's second state.
    const a11yAfter = await axe(page);
    check(a11yAfter.serious === 0 && a11yAfter.critical === 0, `axe after saving: serious=${a11yAfter.serious} critical=${a11yAfter.critical}`);
    a11y.serious += a11yAfter.serious;
    a11y.critical += a11yAfter.critical;
    check(!devLog().includes(DUMMY_AIS) && !devLog().includes(DUMMY_GOOGLE) && !devLog().includes(DUMMY_EXTERNAL), "no value in the supervisor's output");
    check(googleRequests === 0, `${googleRequests} requests to tile.googleapis.com`);
    check(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    await page.screenshot({ path: path.join(shots, "panel-after.png") });

    console.log(
      `DEVPANEL rows=${rows.length} browser_inputs=${browserInputs} server_inputs=${serverInputs} persists=${persists} esc=${esc} a11y_serious=${a11y.serious} a11y_critical=${a11y.critical} restarted=${restarted} live=${live} imagery=${route} google_requests=${googleRequests}`,
    );
    for (const f of failures) log(`FAIL ${f}`);
    return failures.length === 0 ? 0 : 1;
  } catch (err) {
    await page?.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
    console.error(devLog().split("\n").slice(-60).join("\n"));
    throw err;
  } finally {
    await browser.close();
    await stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(await main());
