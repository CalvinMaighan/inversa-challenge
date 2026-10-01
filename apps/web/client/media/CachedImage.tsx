"use client";

import { useEffect, useState, type ImgHTMLAttributes } from "react";

import { loadMedia, type MediaSource } from "./cache";

type Loaded = { src: string; url: string; source: MediaSource | "direct" };

/**
 * An `<img>` whose bytes come through the media cache (`./cache.ts`): a blob URL of the cached or freshly fetched
 * photo. `data-media-source` says which (`cache`, `network`, or `direct` when the cache path failed and the browser
 * loads `src` itself); it reads `loading` until then, while the image stays invisible. `data-src` keeps the media
 * URL on the element (server markup, tests, e2e).
 */
export default function CachedImage({ src, alt, style, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & { src: string; alt: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    loadMedia(src)
      .then(({ blob, source }) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ src, url: objectUrl, source });
      })
      .catch(() => {
        if (alive) setLoaded({ src, url: src, source: "direct" });
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  const ready = loaded?.src === src ? loaded : null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the local media cache; the image optimizer cannot serve it
    <img {...rest} alt={alt} src={ready?.url} data-src={src} data-media-source={ready?.source ?? "loading"} style={ready ? style : { ...style, visibility: "hidden" }} />
  );
}
