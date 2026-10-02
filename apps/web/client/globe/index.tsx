"use client";

import dynamic from "next/dynamic";

import type { GlobeViewProps } from "./GlobeView";

/** WebGL, workers and SharedArrayBuffer: the view is browser-only, never server-rendered, and loads in its own chunk. */
const GlobeView = dynamic(() => import("./GlobeView"), { ssr: false });

/** The full-bleed globe (PLAN.md C16 slot). Registers the `GlobeApi` once the scene is up. */
export default function Globe(props: GlobeViewProps) {
  return <GlobeView {...props} />;
}
