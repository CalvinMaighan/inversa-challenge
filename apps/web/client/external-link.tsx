import type { AnchorHTMLAttributes } from "react";

import { externalLinkProps } from "shared/links";

/** An anchor that opens external (other-origin http/https) hrefs in a new tab with `rel="noopener noreferrer"`. */
export default function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...rest} {...externalLinkProps(href)}>
      {children}
    </a>
  );
}
