import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";

import Credit from "client/hud/search/Credit";
import NearbyAccess, { AccessList } from "client/hud/search/NearbyAccess";
import { emotionTheme } from "client/themes/theme";
import { mergeAccess, parseAccess } from "shared/places";

import nearbyFixture from "../../../fixtures/places/nearby-marinas.json";
import rampFixture from "../../../fixtures/places/ramp-search.json";

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);

function anchors(markup: string): Record<string, string>[] {
  return [...markup.matchAll(/<a\s([^>]*)>/g)].map((m) => Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!.replace(/&amp;/g, "&")])));
}

const AT = { lat: 25.1417, lon: -80.9245 };

describe("nearby access", () => {
  test("the card shows only the button until asked (nothing requested, nothing on the map)", () => {
    const markup = html(<NearbyAccess at={AT} />);
    expect(markup).toContain('data-testid="access-button"');
    expect(markup).toContain("Boat ramps and marinas nearby");
    expect(markup).not.toContain("access-list");
  });

  test("the list: nearest first with distances, each 'Open in Google Maps' in a new tab with noopener noreferrer, and the Google Maps credit", () => {
    const places = mergeAccess([parseAccess(nearbyFixture, AT, "marina"), parseAccess(rampFixture, AT, "ramp")]);
    const markup = html(<AccessList result={{ status: "ok", places }} />);
    const links = anchors(markup).filter((a) => a["data-testid"] === "access-maps-link");
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a.href!.startsWith("https://www.google.com/maps/search/?api=1&")).toBe(true);
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(links[0]!.href).toContain("query_place_id=fixture-marina-flamingo");
    expect(markup.indexOf("Flamingo Marina")).toBeLessThan(markup.indexOf("Snake Bight Boat Ramp"));
    expect(markup).toContain(">70 m<");
    expect(markup).toContain("Boat ramp · ");
    expect(markup).toContain('data-provider="google"');
    expect(markup).toContain(">Google Maps<");
  });

  test("empty, no key, cap and error states say so in plain words", () => {
    expect(html(<AccessList result={{ status: "ok", places: [] }} />)).toContain("No boat ramps found within 10 km");
    expect(html(<AccessList result={{ status: "no-key" }} />)).toContain("Needs a Google key");
    expect(html(<AccessList result={{ status: "capped" }} />)).toContain("limit for this session reached");
    expect(html(<AccessList result={{ status: "error", message: "Google Places did not answer (HTTP 500)." }} />)).toContain("HTTP 500");
  });

  test("credits: 'Google Maps' untranslated in Roboto 400; Photon credits OpenStreetMap in a new tab", () => {
    const google = html(<Credit provider="google" />);
    expect(google).toContain('translate="no"');
    expect(google).toContain(">Google Maps<");
    const osm = anchors(html(<Credit provider="photon" />));
    expect(osm[0]).toMatchObject({ href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener noreferrer" });
    expect(html(<Credit provider={null} />)).toBe("");
  });
});
