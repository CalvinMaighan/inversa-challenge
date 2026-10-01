import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mountStreamMarkdown } from "client/agent/markdown/mount";
import { externalLinkProps, isExternalHref, markExternalLink } from "shared/links";

/** The few DOM calls the markdown writer makes, on plain objects. */
class FakeElement {
  children: (FakeElement | string)[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  type = "";
  title = "";
  constructor(readonly tagName: string) {}
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  links(): FakeElement[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [...(c.tagName === "a" ? [c] : []), ...c.links()]));
  }
}

const ORIGIN = "http://localhost:3050";
const saved = { document: globalThis.document, location: globalThis.location };

beforeAll(() => {
  Object.assign(globalThis, { document: { createElement: (tag: string) => new FakeElement(tag) }, location: { origin: ORIGIN } });
});
afterAll(() => {
  Object.assign(globalThis, saved);
});

describe("markdown links", () => {
  test("external links open in a new tab, links into the app stay in this one", () => {
    const host = new FakeElement("div");
    mountStreamMarkdown(
      host as unknown as HTMLElement,
      `See [the observation](https://www.inaturalist.org/observations/335508189) and [this view](${ORIGIN}/?t=1).\n\n- [GBIF](http://www.gbif.org/occurrence/1)`,
      new Map(),
    );
    const links = host.links().map((a) => Object.fromEntries(a.attributes));
    expect(links).toEqual([
      { href: "https://www.inaturalist.org/observations/335508189", target: "_blank", rel: "noopener noreferrer" },
      { href: `${ORIGIN}/?t=1` },
      { href: "http://www.gbif.org/occurrence/1", target: "_blank", rel: "noopener noreferrer" },
    ]);
  });

  test("helpers: external means http(s) on another origin; rel keeps existing tokens", () => {
    expect(isExternalHref("https://www.gbif.org/x", ORIGIN)).toBe(true);
    expect(isExternalHref(`${ORIGIN}/dev`, ORIGIN)).toBe(false);
    expect(isExternalHref("/v1/media/1", ORIGIN)).toBe(false);
    expect(isExternalHref("mailto:a@b.c", ORIGIN)).toBe(false);
    expect(externalLinkProps("https://cesium.com/", ORIGIN)).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(externalLinkProps("#help", ORIGIN)).toEqual({});
    // Cesium's own credit markup: target set, rel missing.
    const a = new FakeElement("a");
    a.setAttribute("href", "https://cesium.com/");
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "nofollow");
    expect(markExternalLink(a, ORIGIN)).toBe(true);
    expect(Object.fromEntries(a.attributes)).toEqual({ href: "https://cesium.com/", target: "_blank", rel: "nofollow noopener noreferrer" });
  });
});
