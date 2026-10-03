import { describe, expect, test } from "bun:test";

import { overlayWarmUrls } from "client/intro/preload";
import { APP_IDS } from "shared/apps";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const [CARP_ID, LIONFISH_ID, PYTHON_ID] = APP_IDS;

describe("overlay warm plan", () => {
  test("each app warms the overlays it lists, as the same-origin tile URLs Cesium asks for", () => {
    const lion = overlayWarmUrls(LIONFISH_ID, NOW);
    for (const id of ["sst-map", "radar", "lightning"]) expect(lion.some((u) => u.startsWith(`/v1/${LIONFISH_ID}/overlay/${id}/`))).toBe(true);
    expect(lion).toContain(`/v1/${LIONFISH_ID}/overlay/cyclones`);
    expect(overlayWarmUrls(PYTHON_ID, NOW).some((u) => u.includes("/overlay/sst-map/"))).toBe(false);
    expect(overlayWarmUrls(CARP_ID, NOW).some((u) => u.includes("/overlay/sst-map/"))).toBe(true);
  });

  test("clouds are not warmed (they are off everywhere) and tiles stay inside the zoom range", () => {
    const urls = overlayWarmUrls(LIONFISH_ID, NOW, [3, 4]);
    expect(urls.some((u) => u.includes("/overlay/clouds/"))).toBe(false);
    for (const u of urls.filter((x) => /\/\d+\/\d+\/\d+\?/.test(x))) {
      const [z, x, y] = u.split("?")[0]!.split("/").slice(-3).map(Number) as [number, number, number];
      expect([3, 4]).toContain(z);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(2 ** z);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(2 ** z);
    }
    expect(urls.length).toBeGreaterThan(20);
    expect(urls.length).toBeLessThan(400);
  });

  test("finer levels add more tiles of the same layers", () => {
    expect(overlayWarmUrls(LIONFISH_ID, NOW, [5]).length).toBeGreaterThan(overlayWarmUrls(LIONFISH_ID, NOW, [3]).length);
  });
});
