import { INTRO_ATTR, INTRO_FLAG, INTRO_SKIP_PARAM, LEAVE_MS } from "./constants";

/**
 * Inline `<head>` script: marks the page `data-intro` before first paint, so the stylesheet below hides the chat and
 * the HUD from the very first frame (the gate itself is server-rendered). `introInit` (store.ts) removes the mark when
 * the gate opens the app.
 *
 * No gate for `?intro=0`, and none for automated browsers (`navigator.webdriver`: the e2e scripts drive the app
 * itself) unless `?intro=1` asks for it.
 */
export function introBootstrapScript(): string {
  const on = `document.documentElement.setAttribute(${JSON.stringify(INTRO_ATTR)},"");window[${JSON.stringify(INTRO_FLAG)}]=true`;
  const p = `var p=new URLSearchParams(location.search).get(${JSON.stringify(INTRO_SKIP_PARAM)});`;
  return `(function(){try{${p}if(p==="0"||(p!=="1"&&navigator.webdriver===true))return}catch(e){}${on}})();`;
}

/** The chrome (chat card and HUD) and the page's embers are hidden while the gate is up (it has its own), and fade in when it opens. The globe stays. */
export const INTRO_CSS =
  `[data-slot="hud"],[data-slot="side"]{transition:opacity ${LEAVE_MS}ms ease .1s}` +
  `[data-embers="page"]{transition:opacity ${LEAVE_MS}ms ease .5s}` +
  `html[${INTRO_ATTR}] [data-embers="page"]{opacity:0;transition:none}` +
  `html[${INTRO_ATTR}] [data-slot="hud"],html[${INTRO_ATTR}] [data-slot="side"]{opacity:0;visibility:hidden;pointer-events:none;transition:none}`;
