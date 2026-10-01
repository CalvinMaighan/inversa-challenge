import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";

import { SourcePageIcon } from "client/agent/panels/views";
import SourcePageLink, { RecordValue } from "client/hud/drawer/SourcePageLink";
import { emotionTheme } from "client/themes/theme";
import { PUBLISHERS, publisherOf, sightingPageUrl } from "shared/source-pages";

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);

/** `<a ...>` tags in rendered markup, as attribute maps. */
function anchors(markup: string): Record<string, string>[] {
  return [...markup.matchAll(/<a\s([^>]*)>/g)].map((m) => Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));
}

const INAT = "https://www.inaturalist.org/observations/335508189";

describe("source page link", () => {
  test("the drawer header link names the publisher and opens in a new tab", () => {
    const markup = html(<SourcePageLink url={INAT} />);
    const [a] = anchors(markup);
    expect(a).toMatchObject({ href: INAT, target: "_blank", rel: "noopener noreferrer", "data-testid": "source-page-link" });
    expect(markup).toContain(">Open at iNaturalist <svg");
    expect(markup).toContain("<svg"); // the external-link icon
    const gbif = anchors(html(<SourcePageLink url="https://www.gbif.org/occurrence/6130701656" />));
    expect(gbif[0]).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
  });

  test("source page link: nothing for null, http, or hosts off the allowlist", () => {
    for (const url of [null, undefined, "", "http://www.inaturalist.org/observations/1", "https://evil.test/observations/1", "https://www.inaturalist.org.evil.test/x", "javascript:alert(1)"]) {
      expect(html(<SourcePageLink url={url} />)).toBe("");
    }
  });

  test("source page link: record fields link only when https on an allowlisted host", () => {
    const linked = anchors(html(<RecordValue value={INAT} text={INAT} />));
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ href: INAT, target: "_blank", rel: "noopener noreferrer" });
    for (const value of ["https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg", "http://www.gbif.org/occurrence/1", "/v1/media/7", 42, null]) {
      expect(anchors(html(<RecordValue value={value} text={String(value)} />))).toHaveLength(0);
    }
  });

  test("source page link: agent table rows get a ↗ that opens in a new tab", () => {
    const [a] = anchors(html(<SourcePageIcon url={INAT} />));
    expect(a).toMatchObject({ href: INAT, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open at iNaturalist" });
    expect(html(<SourcePageIcon url={null} />)).toBe("");
    expect(html(<SourcePageIcon url="https://evil.test/" />)).toBe("");
  });

  test("source page link: sighting patterns match the API for real fixture records", () => {
    expect(sightingPageUrl("inat", "335508189")).toBe(INAT);
    expect(sightingPageUrl("gbif", "50c9509d-22c7-4a22-a47d-8c48425ef4a7:335508189:6130701656")).toBe("https://www.gbif.org/occurrence/6130701656");
    expect(sightingPageUrl("nas", "1936189")).toBe("https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=1936189");
    expect(sightingPageUrl("nas", "NAS-1720331")).toBeNull();
    expect(sightingPageUrl("web", "web-1")).toBeNull();
    expect(sightingPageUrl("inat", "1?x=<b>")).toBeNull();
    expect(publisherOf("https://www.gbif.org:8443/occurrence/1")).toBeNull();
    expect(publisherOf("https://user@www.gbif.org/occurrence/1")).toBeNull();
  });

  test("source page link: the web allowlist equals the API's PUBLISHERS", () => {
    const rust = readFileSync(resolve(import.meta.dir, "../../../../../api/src/source_pages.rs"), "utf8");
    const block = rust.slice(rust.indexOf("pub const PUBLISHERS"), rust.indexOf("];", rust.indexOf("pub const PUBLISHERS")));
    const api = Object.fromEntries([...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(api).length).toBeGreaterThan(5);
    expect(api).toEqual({ ...PUBLISHERS });
  });
});
