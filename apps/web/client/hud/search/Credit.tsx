"use client";

import ExternalLink from "client/external-link";
import styled from "client/styled";

/**
 * Attribution under place results (docs/places.md "Display and caching"). Google's Places policies ask for the
 * words "Google Maps", untranslated, in Roboto (or any sans-serif) at weight 400, 12 to 16 px, in white, #1F1F1F or
 * #5E5E5E; Photon results credit OpenStreetMap (ODbL).
 */
const Line = styled.p`
  margin: var(--gap-s) 0 0;
  color: var(--muted);
  font: 400 12px / 1.4 var(--font-ui);

  .google {
    font: 400 12px / 1.4 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
    letter-spacing: normal;
  }

  :root[data-theme="light"] & .google {
    color: #5e5e5e;
  }

  a {
    color: inherit;
    text-decoration: underline 1px;
    text-underline-offset: 2px;
  }
`;

export default function Credit({ provider }: { provider: "google" | "photon" | null }) {
  if (provider === "google") {
    return (
      <Line data-testid="places-credit" data-provider="google">
        <span className="google" translate="no" lang="en">
          Google Maps
        </span>
      </Line>
    );
  }
  if (provider === "photon") {
    return (
      <Line data-testid="places-credit" data-provider="photon">
        Search by Photon ·{" "}
        <ExternalLink href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</ExternalLink>
      </Line>
    );
  }
  return null;
}
