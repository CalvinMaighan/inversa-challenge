import { beforeEach, describe, expect, test } from "bun:test";

import { gbifPlace, inatPlace, observationPlace, resetObservationPlaces } from "@/server/places/observation-place";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2026-10-03T12:00:00Z");

beforeEach(() => resetObservationPlaces());

describe("observation place", () => {
  test("iNaturalist: the place_guess line, as the site writes it", () => {
    const guess = "Costa Occ. de Isla Mujeres, Pta Cancún y Pta Nizuc, Isla Mujeres, MX-QR, MX";
    expect(inatPlace({ results: [{ place_guess: guess }] })).toBe(guess);
    expect(inatPlace({ results: [{ place_guess: "  " }] })).toBeNull();
    expect(inatPlace({ results: [] })).toBeNull();
    expect(inatPlace(null)).toBeNull();
  });

  test("GBIF: locality, region and country without repeats", () => {
    expect(gbifPlace({ locality: "Isla Mujeres", stateProvince: "Quintana Roo", country: "Mexico" })).toBe("Isla Mujeres, Quintana Roo, Mexico");
    expect(gbifPlace({ verbatimLocality: "Key Largo", stateProvince: "Florida", country: "United States of America" })).toBe("Key Largo, Florida, United States of America");
    expect(gbifPlace({ locality: "Belize", country: "Belize" })).toBe("Belize");
    expect(gbifPlace({})).toBeNull();
  });

  test("asks the right public API once per record and keeps the answer", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => (urls.push(url), json({ results: [{ place_guess: "Isla Mujeres, MX" }] }));
    expect(await observationPlace({ source: "inat", id: "5010" }, fetchImpl, NOW)).toBe("Isla Mujeres, MX");
    expect(await observationPlace({ source: "inat", id: "5010" }, fetchImpl, NOW + 1000)).toBe("Isla Mujeres, MX");
    expect(urls).toEqual(["https://api.inaturalist.org/v1/observations/5010"]);
    const gb: string[] = [];
    await observationPlace({ source: "gbif", id: "77" }, async (u) => (gb.push(u), json({ locality: "Reef" })), NOW);
    expect(gb).toEqual(["https://api.gbif.org/v1/occurrence/77"]);
  });

  test("two cards for the same record at once make one request", async () => {
    let calls = 0;
    const fetchImpl = async () => (calls++, json({ results: [{ place_guess: "X" }] }));
    const [a, b] = await Promise.all([observationPlace({ source: "inat", id: "1" }, fetchImpl, NOW), observationPlace({ source: "inat", id: "1" }, fetchImpl, NOW)]);
    expect([a, b, calls]).toEqual(["X", "X", 1]);
  });

  test("a failure is not an error: no place, remembered for a day, then tried again", async () => {
    let calls = 0;
    const down = async () => (calls++, json({}, 503));
    expect(await observationPlace({ source: "inat", id: "9" }, down, NOW)).toBeNull();
    expect(await observationPlace({ source: "inat", id: "9" }, down, NOW + 3_600_000)).toBeNull();
    expect(calls).toBe(1);
    expect(await observationPlace({ source: "inat", id: "9" }, async () => json({ results: [{ place_guess: "Back" }] }), NOW + 2 * 86_400_000)).toBe("Back");
  });
});
