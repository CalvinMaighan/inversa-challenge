"use client";

import { useEffect, useId, useRef, useState } from "react";

import ExternalLink from "client/external-link";
import { browserPlacesDeps } from "client/places/browser";
import { loadAccess, NO_ACCESS_MESSAGE, type AccessResult } from "client/places/search";
import styled from "client/styled";
import { formatKm, mapsPlaceUrl, type AccessPlace, type LatLon } from "shared/places";

import Credit from "./Credit";

const Box = styled.section`
  margin-bottom: var(--gap-l);

  > button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text);
    font: 600 12px / 1.3 var(--font-ui);
    cursor: pointer;

    &:hover {
      border-color: var(--accent);
    }
  }

  h4 {
    margin: 0 0 var(--gap-s);
    font: 600 13px / 1.3 var(--font-ui);
  }

  p {
    margin: var(--gap-s) 0 0;
    color: var(--muted);
    font-size: 12px;
  }
`;

const List = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px var(--gap-s);
    padding: 6px 0;
    border-top: 1px solid var(--border);
  }

  .name {
    font-weight: 600;
    font-size: 13px;
  }

  .km {
    color: var(--text);
    font: 600 12px / 1.4 var(--font-mono);
    text-align: right;
  }

  .addr {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 12px;
  }

  a {
    grid-column: 1 / -1;
    color: var(--accent);
    font: 600 12px / 1.4 var(--font-ui);
  }
`;

const KIND_LABEL: Record<AccessPlace["kind"], string> = { marina: "Marina", ramp: "Boat ramp" };

/** One row: name, distance, address, and Google Maps in a new tab (for directions). */
export function AccessRow({ place }: { place: AccessPlace }) {
  return (
    <li data-access-kind={place.kind}>
      <span className="name">{place.name}</span>
      <span className="km" aria-label={`${formatKm(place.km)} away`}>
        {formatKm(place.km)}
      </span>
      <span className="addr">
        {KIND_LABEL[place.kind]}
        {place.address ? ` · ${place.address}` : ""}
      </span>
      <ExternalLink href={mapsPlaceUrl(place.id, place.name)} data-testid="access-maps-link">
        Open in Google Maps
      </ExternalLink>
    </li>
  );
}

/** The list for a loaded result (exported for the unit tests). */
export function AccessList({ result }: { result: AccessResult }) {
  switch (result.status) {
    case "no-key":
      return <p data-testid="access-note">Needs a Google key: add one under Developer settings (top right).</p>;
    case "no-map":
      return <p data-testid="access-note">The Google 3D monthly cap is reached, so Google places are off until next month (Developer settings).</p>;
    case "capped":
      return <p data-testid="access-note">Google search limit for this session reached; raise it in Developer settings.</p>;
    case "error":
      return <p data-testid="access-note">{result.message}</p>;
    case "ok":
      if (result.places.length === 0) return <p data-testid="access-empty">{NO_ACCESS_MESSAGE}</p>;
      return (
        <>
          <List aria-label="Boat ramps and marinas, nearest first" data-testid="access-list">
            {result.places.map((p) => (
              <AccessRow key={p.id} place={p} />
            ))}
          </List>
          <Credit provider="google" />
        </>
      );
  }
}

/**
 * "Boat ramps and marinas nearby" (gates/leaf-GE6.md G3): in the sighting card, for a removal crew planning how to
 * get to the water. Nothing is requested, and nothing is drawn on the map, until the button is pressed.
 */
export default function NearbyAccess({ at }: { at: LatLon }) {
  // The result belongs to one sighting: another sighting shows the button again, and a late answer for the old
  // one is dropped.
  const key = `${at.lat},${at.lon}`;
  const [state, setState] = useState<{ for: string; value: "loading" | AccessResult } | null>(null);
  const current = state?.for === key ? state.value : "idle";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const loaded = typeof current === "object";
  useEffect(() => {
    if (loaded) headingRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  if (current === "idle") {
    return (
      <Box>
        <button
          type="button"
          data-testid="access-button"
          onClick={() => {
            setState({ for: key, value: "loading" });
            void loadAccess(at, browserPlacesDeps()).then((r) => setState((s) => (s?.for === key && s.value === "loading" ? { for: key, value: r } : s)));
          }}
        >
          Boat ramps and marinas nearby
        </button>
      </Box>
    );
  }
  return (
    <Box aria-labelledby={headingId} data-testid="access-section">
      <h4 id={headingId} ref={headingRef} tabIndex={-1}>
        Boat ramps and marinas within 10 km
      </h4>
      {current === "loading" ? <p role="status">Looking for boat ramps and marinas…</p> : <AccessList result={current} />}
    </Box>
  );
}
