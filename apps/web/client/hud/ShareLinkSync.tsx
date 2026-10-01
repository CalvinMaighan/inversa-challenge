"use client";

import { useEffect } from "react";
import { subscribe } from "@calvinjs/active-state";

import { APP, activeAppId } from "client/state/app";
import { CARP } from "client/state/carp";
import { LAYERS } from "client/state/layers";
import { SELECTION } from "client/state/selection";
import { TIME } from "client/state/time";
import { VIEW } from "client/state/view";

import { decodeShareLink, encodeShareLink, hasShareFields } from "./share-link";
import { applyShareState, readShareState } from "./share-link-store";

/** Hash writes wait for the state to settle: a scrub or a camera flight writes once, at the end. */
export const SHARE_WRITE_DEBOUNCE_MS = 400;

const currentHash = () => window.location.hash.replace(/^#/, "");

/**
 * Keeps the URL hash in step with camera, time, layers and selection. On load (and on a pasted link, via
 * `hashchange`) the hash is applied to the store; afterwards store changes rewrite it with `replaceState`,
 * debounced, so history is not flooded and nothing is fetched.
 */
export default function ShareLinkSync() {
  useEffect(() => {
    let lastHash = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelFly = () => {};

    const applyHash = (hash: string) => {
      lastHash = hash;
      const decoded = decodeShareLink(hash);
      // The hash is a view within the active app (AppBoot already resolved it, `?app=` first); another app's
      // layers and species mean nothing here.
      if (!hasShareFields(decoded) || (decoded.app !== undefined && decoded.app !== activeAppId())) return;
      cancelFly();
      cancelFly = applyShareState(decoded);
    };
    applyHash(currentHash());

    const write = () => {
      timer = null;
      const next = encodeShareLink(readShareState());
      if (next === lastHash) return;
      lastHash = next;
      const url = new URL(window.location.href);
      url.hash = next;
      window.history.replaceState(window.history.state, "", url);
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, SHARE_WRITE_DEBOUNCE_MS);
    };
    const offs = [APP, VIEW, TIME, LAYERS, SELECTION, CARP].map((k) => subscribe(k, schedule));
    // replaceState never fires hashchange, so this only sees links pasted or edited by hand.
    const onHashChange = () => {
      const hash = currentHash();
      if (hash !== lastHash) applyHash(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      for (const off of offs) off();
      window.removeEventListener("hashchange", onHashChange);
      if (timer !== null) clearTimeout(timer);
      cancelFly();
    };
  }, []);
  return null;
}
