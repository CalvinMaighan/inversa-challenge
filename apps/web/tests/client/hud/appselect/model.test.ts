import { describe, expect, test } from "bun:test";

import { fetchAppHealth, healthLabel, parseAppHealth } from "client/hud/appselect/health";
import { appIconCategory, appOptions, appTint, nextIndex } from "client/hud/appselect/model";
import { getApp } from "shared/apps";
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

describe("app health from /health", () => {
  test("reads an apps array, an apps map, per-feed states (worst wins) and aliases; the rest is unknown", () => {
    expect(parseAppHealth({ apps: [{ id: "carp", state: "LAGGING" }, { id: "python", status: "ok" }, { id: "bogus", state: "down" }] })).toEqual({ carp: "lagging", lionfish: "unknown", python: "nominal" });
    expect(parseAppHealth({ apps: { lionfish: { feeds: [{ state: "nominal" }, { state: "stale" }, { state: "lagging" }] }, carp: "down" } })).toEqual({ carp: "down", lionfish: "stale", python: "unknown" });
    expect(parseAppHealth("ok")).toEqual({ carp: "unknown", lionfish: "unknown", python: "unknown" });
    expect(parseAppHealth(null)).toEqual({ carp: "unknown", lionfish: "unknown", python: "unknown" });
    expect(healthLabel("down")).toBe("feeds down");
  });

  test("an API that answers text, an error status or nothing reads as unknown, never throws", async () => {
    const answer = (body: BodyInit, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect((await fetchAppHealth(answer("ok"))).carp).toBe("unknown");
    expect((await fetchAppHealth(answer("{}", 500))).carp).toBe("unknown");
    expect((await fetchAppHealth((async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).python).toBe("unknown");
    expect((await fetchAppHealth(answer(JSON.stringify({ apps: [{ id: "python", state: "down" }] })))).python).toBe("down");
  });
});
