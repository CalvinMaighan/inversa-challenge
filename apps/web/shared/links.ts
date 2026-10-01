/**
 * External links open in a new tab, everywhere in the app: React anchors use `externalLinkProps` (through
 * `client/external-link.tsx`), the markdown writer uses `markExternalLink`, and DOM we do not render ourselves
 * (Cesium's credits and its "Data attribution" lightbox) is kept in line by `guardExternalLinks`.
 */

export const NEW_TAB_REL = "noopener noreferrer";

const pageOrigin = (): string | undefined => (typeof location === "undefined" ? undefined : location.origin);

/** An absolute http(s) URL on another origin than `origin` (the page's, by default). */
export function isExternalHref(href: string | null | undefined, origin: string | undefined = pageOrigin()): boolean {
  if (!href || !/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== origin;
  } catch {
    return false;
  }
}

/** `target` and `rel` for an external href; nothing for same-origin or relative ones. */
export function externalLinkProps(href: string | null | undefined, origin?: string): { target?: "_blank"; rel?: string } {
  return isExternalHref(href, origin ?? pageOrigin()) ? { target: "_blank", rel: NEW_TAB_REL } : {};
}

type AnchorLike = Pick<Element, "getAttribute" | "setAttribute">;

/** Give an anchor `target=_blank` and `rel=noopener noreferrer` when its href is external. Returns whether it did. */
export function markExternalLink(a: AnchorLike, origin?: string): boolean {
  const href = a.getAttribute("href");
  if (!isExternalHref(href, origin ?? pageOrigin())) return false;
  if (a.getAttribute("target") !== "_blank") a.setAttribute("target", "_blank");
  const rel = new Set((a.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean));
  if (!rel.has("noopener") || !rel.has("noreferrer")) {
    rel.add("noopener");
    rel.add("noreferrer");
    a.setAttribute("rel", [...rel].join(" "));
  }
  return true;
}

/**
 * Mark every external anchor under `root` now and whenever third-party code adds or edits one. Returns the
 * disconnect function.
 */
export function guardExternalLinks(root: Element): () => void {
  const sweep = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.matches("a[href]")) markExternalLink(node);
    node.querySelectorAll("a[href]").forEach((a) => markExternalLink(a));
  };
  sweep(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") sweep(r.target);
      else r.addedNodes.forEach(sweep);
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "target", "rel"] });
  return () => observer.disconnect();
}
