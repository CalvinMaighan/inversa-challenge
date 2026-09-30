import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MODE, THEME_MODES } from "./palette";

/** active-state localStorage prefix. Providers passes the same value to `<ActiveState storagePrefix>`. */
export const STORAGE_PREFIX = "inversa:";

/**
 * Inline script for `<head>`: reads the persisted THEME / ACCENT_COLOR keys (JSON, as active-state writes them)
 * and sets `data-theme`, `data-accent` and the accent vars on `<html>` before first paint. Same writes as
 * active-theme's `applyTheme`, so `<ActiveTheme />` hydrating afterwards changes nothing and nothing flashes.
 */
export function themeBootstrapScript(prefix: string = STORAGE_PREFIX): string {
  const accents = Object.fromEntries(Object.entries(ACCENTS).map(([id, a]) => [id, [a.hue, a.chromaBase]]));
  const config = JSON.stringify({ p: prefix, m: THEME_MODES, dm: DEFAULT_MODE, a: accents, da: DEFAULT_ACCENT });
  return (
    `(function(c){var d=document.documentElement;` +
    `function r(k){try{return JSON.parse(localStorage.getItem(c.p+k)||"null")}catch(e){return null}}` +
    `var m=r("THEME"),a=r("ACCENT_COLOR");` +
    `if(c.m.indexOf(m)<0)m=c.dm;` +
    `if(!Object.prototype.hasOwnProperty.call(c.a,a))a=c.da;` +
    `var h=c.a[a][0],k=c.a[a][1],s=d.style;` +
    `d.setAttribute("data-theme",m);d.setAttribute("data-accent",a);` +
    `s.setProperty("--hue",String(h));s.setProperty("--hue-accent",String(h-3));` +
    `s.setProperty("--chroma-base",String(k));s.setProperty("--chroma-accent",String(k*11.111))` +
    `})(${config});`
  );
}
