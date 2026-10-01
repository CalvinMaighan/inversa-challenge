import { describe, expect, test } from "bun:test";

import { fetchAppHealth, healthLabel, parseAppHealth, type AppHealth } from "client/hud/appselect/health";
import { appIconCategory, appOptions, appTint, nextIndex } from "client/hud/appselect/model";
import { getApp, type AppId } from "shared/apps";
import { CATEGORY_COLORS } from "shared/species-categories";

describe("app selector model", () => {
  test("active app: one row per app in order, with name, question, icon and the current one marked", () => {
    const rows = appOptions("lionfish", { carp: "nominal", lionfish: "stale", python: "unknown" });
    expect(rows.map((r) => r.id)).toEqual(["carp", "lionfish", "python"]);
    expect(rows.map((r) => r.selected)).toEqual([false, true, false]);
    expect(rows[0]).toMatchObject({ name: "Carp Field Conditions", icon: "fish", tone: "ok", healthLabel: "feeds running normally" });
    expect(rows[1]).toMatchObject({ question: getApp("lionfish").question, tone: "stale", tint: getApp("lionfish").taxa[0]!.color });
    expect(rows[2]).toMatchObject({ icon: "snakes", tone: "muted", healthLabel: "feed health unknown" });
    expect(appOptions("carp", null).every((r) => r.health === "unknown")).toBe(true);
  });

  test("icons: a category id, a known app icon name, else other; carp (no taxa) is tinted by its category", () => {
    expect(appIconCategory("birds")).toBe("birds");
    expect(appIconCategory("python")).toBe("snakes");
    expect(appIconCategory("unicorn")).toBe("other");
    expect(appTint(getApp("carp"))).toBe(CATEGORY_COLORS.fish);
  });

  test("keyboard: arrows wrap, Home and End jump, other keys do nothing", () => {
    expect(nextIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextIndex("Home", 2, 3)).toBe(0);
    expect(nextIndex("End", 0, 3)).toBe(2);
    expect(nextIndex("Tab", 0, 3)).toBeNull();
  });
});

/** A feed-state envelope as `/health` writes it (api/src/feed_state.rs `FeedState`, times as Unix ms). */
const feed = (source: string, state: string) => ({
  source,
  mode: "poll",
  state,
  newestObservedAt: 1_759_300_000_000,
  lastFetchAt: 1_759_300_100_000,
  lastFetchRunId: "12",
  lagSeconds: 30,
  note: null,
});
/** The `/health` body of api/src/app/mod.rs `health`. */
const body = (status: string, feeds: Record<string, unknown>) => ({
  status,
  defaultApp: "carp",
  apps: [
    { id: "carp", name: "Carp Field Conditions", kind: "conditions", provisional: true, regions: ["louisiana"], taxa: [], feeds: feeds.carp },
    { id: "lionfish", name: "Lionfish Watch", kind: "species", provisional: false, regions: ["fl-keys"], taxa: ["lionfish"], feeds: feeds.lionfish },
    { id: "python", name: "Everglades Ops", kind: "species", provisional: false, regions: ["everglades"], taxa: ["python"], feeds: feeds.python },
  ],
});

describe("app health from /health", () => {
  test("reads the /health body: worst feed state per app; no feeds is unknown; a feed-state error is down", () => {
    const ok = body("ok", { carp: [feed("usgs", "nominal")], lionfish: [feed("inat", "nominal"), feed("crw", "stale"), feed("gbif", "lagging")], python: [] });
    expect(parseAppHealth(ok)).toEqual({ carp: "nominal", lionfish: "stale", python: "unknown" });
    const degraded = body("degraded", { carp: { error: "database is locked" }, lionfish: [], python: [feed("nws", "down")] });
    expect(parseAppHealth(degraded)).toEqual({ carp: "down", lionfish: "unknown", python: "down" });
    expect(healthLabel("down")).toBe("feeds down");
  });

  test("strict: the pre-contract guesses and any other shape read as unknown for every app", () => {
    const unknown: Record<AppId, AppHealth> = { carp: "unknown", lionfish: "unknown", python: "unknown" };
    expect(parseAppHealth({ apps: [{ id: "carp", state: "lagging" }] })).toEqual(unknown);
    expect(parseAppHealth({ apps: { lionfish: { feeds: [{ state: "stale" }] } } })).toEqual(unknown);
    const extra = body("ok", { carp: [feed("usgs", "nominal")], lionfish: [], python: [] });
    expect(parseAppHealth({ ...extra, uptime: 3 })).toEqual(unknown);
    expect(parseAppHealth(body("ok", { carp: [{ ...feed("usgs", "nominal"), state: "ok" }], lionfish: [], python: [] }))).toEqual(unknown);
    expect(parseAppHealth("ok")).toEqual(unknown);
    expect(parseAppHealth(null)).toEqual(unknown);
  });

  test("a 503 carries the degraded body; text, other errors or no answer read as unknown, never throw", async () => {
    const answer = (b: BodyInit, status = 200) => (async () => new Response(b, { status })) as unknown as typeof fetch;
    const degraded = JSON.stringify(body("degraded", { carp: { error: "boom" }, lionfish: [], python: [feed("nws", "nominal")] }));
    expect(await fetchAppHealth(answer(degraded, 503))).toEqual({ carp: "down", lionfish: "unknown", python: "nominal" });
    expect((await fetchAppHealth(answer("ok"))).carp).toBe("unknown");
    expect((await fetchAppHealth(answer("{}", 500))).carp).toBe("unknown");
    expect((await fetchAppHealth((async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).python).toBe("unknown");
  });
});
