"use client";

import { useState } from "react";

import { placesUsed, PLACES_MAX_CAP, readPlacesCap } from "client/places/budget";
import { browserKeyStore } from "client/keys";

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The place search cap in the Developer panel's Google Maps row, next to the Google 3D monthly cap. The panel's
 * SAVE KEYS saves it (`savePlacesCapField`). Read once per panel render.
 */
export default function PlacesCapField() {
  const [{ cap, used }] = useState(() => ({ cap: readPlacesCap(browserKeyStore()), used: placesUsed(sessionStore()) }));
  return (
    <>
      <label>
        Search cap
        <input type="number" name="places-cap" min={1} max={PLACES_MAX_CAP} step={1} defaultValue={cap} aria-label="Google place search cap, requests per browser session" data-places-cap="" />
      </label>
      Places requests a session · {used} used in this tab
    </>
  );
}
