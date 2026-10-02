import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { devRoutesEnabled } from "@/server/dev-routes";

const DEV_DIR = path.resolve(import.meta.dir, "../../app/dev");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("dev routes", () => {
  test("on under next dev, off in production unless INVERSA_DEV_ROUTES=1", () => {
    expect(devRoutesEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devRoutesEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(devRoutesEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(devRoutesEnabled({ NODE_ENV: "production", INVERSA_DEV_ROUTES: "0" })).toBe(false);
    expect(devRoutesEnabled({ NODE_ENV: "production", INVERSA_DEV_ROUTES: "true" })).toBe(false);
    expect(devRoutesEnabled({ NODE_ENV: "production", INVERSA_DEV_ROUTES: "1" })).toBe(true);
  });

  test("every /dev page sits under the guarding layout, and every /dev route handler checks the guard itself", () => {
    const layout = readFileSync(path.join(DEV_DIR, "layout.tsx"), "utf8");
    expect(layout).toMatch(/if \(!devRoutesEnabled\(\)\) notFound\(\)/);
    expect(layout).toMatch(/export const dynamic = "force-dynamic"/);
    const all = files(DEV_DIR);
    expect(all.filter((f) => f.endsWith("page.tsx")).length).toBeGreaterThanOrEqual(4);
    const handlers = all.filter((f) => /route\.tsx?$/.test(f));
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    for (const f of handlers) expect([f, /if \(!devRoutesEnabled\(\)\) return new Response\("not found", \{ status: 404 \}\)/.test(readFileSync(f, "utf8"))]).toEqual([f, true]);
  });
});
