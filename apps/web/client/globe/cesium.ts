/**
 * CesiumJS at runtime. The browser loads Cesium's own prebuilt ES module (`Build/Cesium/index.js`, copied to
 * `/cesium/index.js` with the workers and assets) through a native `import()` the bundler leaves alone, instead
 * of bundling the npm sources: the production minifier mangles the WebAssembly byte strings Cesium embeds
 * (@spz-loader/core) into template literals with octal escapes, a SyntaxError that takes down the whole chunk.
 * The prebuilt module also keeps ~4.7 MB out of the Next build and caches independently of app deploys.
 *
 * Globe modules therefore import Cesium *types* only and reach values through `cesium()`. Tests hand in the
 * npm module with `setCesium`.
 */
import type * as CesiumModule from "cesium";

export type Cesium = typeof CesiumModule;

/** Where `scripts/copy-cesium.ts` puts index.js, Workers, Assets, Widgets and ThirdParty. */
export const CESIUM_BASE_URL = "/cesium";

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

let lib: Cesium | null = null;
let loading: Promise<Cesium> | null = null;

export function setCesium(namespace: Cesium): void {
  lib = namespace;
}

/** The loaded Cesium namespace. Throws before `loadCesium` (or `setCesium`) has finished. */
export function cesium(): Cesium {
  if (!lib) throw new Error("Cesium is not loaded yet; await loadCesium() first");
  return lib;
}

/** Load Cesium once per page. Sets `CESIUM_BASE_URL` first so workers and assets resolve under /cesium. */
export function loadCesium(baseUrl: string = CESIUM_BASE_URL): Promise<Cesium> {
  if (lib) return Promise.resolve(lib);
  loading ??= (async () => {
    window.CESIUM_BASE_URL = baseUrl;
    const url = `${baseUrl}/index.js`;
    const loaded = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as Cesium;
    lib = loaded;
    return loaded;
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
