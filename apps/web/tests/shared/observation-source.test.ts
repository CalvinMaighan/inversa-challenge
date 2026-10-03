import { describe, expect, test } from "bun:test";

import { parseSourcePage } from "shared/observation-source";

describe("source page to record", () => {
  test("iNaturalist observation and GBIF occurrence pages", () => {
    expect(parseSourcePage("https://www.inaturalist.org/observations/123456789")).toEqual({ source: "inat", id: "123456789" });
    expect(parseSourcePage("https://inaturalist.org/observations/42")).toEqual({ source: "inat", id: "42" });
    expect(parseSourcePage("https://www.gbif.org/occurrence/4321987654")).toEqual({ source: "gbif", id: "4321987654" });
  });

  test("anything else has no lookup", () => {
    for (const url of [null, undefined, "", "not a url", "https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=1", "https://evil.example/observations/12", "https://www.inaturalist.org/observations/12/edit", "https://www.inaturalist.org/observations/abc"]) {
      expect(parseSourcePage(url)).toBeNull();
    }
  });
});
