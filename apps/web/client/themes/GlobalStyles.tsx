"use client";

import { css, Global } from "client/styled";

import { modeDeclarations, sharedDeclarations } from "./palette";

/**
 * Tokens per `data-theme`, plus the base reset. No `data-theme` (before the bootstrap script, or with it blocked)
 * means dark, the default mode. No prefers-color-scheme fallback: the persisted mode is the only input.
 */
const globalCss = css`
  :root {
    ${sharedDeclarations()}
  }
  :root,
  :root[data-theme="dark"] {
    ${modeDeclarations("dark")}
  }
  :root[data-theme="light"] {
    ${modeDeclarations("light")}
  }
  :root[data-theme="tactical"] {
    ${modeDeclarations("tactical")}
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  html,
  body {
    margin: 0;
    padding: 0;
    height: 100%;
    /* The globe owns every gesture; the page itself never scrolls or bounces. */
    overflow: hidden;
    overscroll-behavior: none;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font: 400 var(--font-m) / 1.5 var(--font-ui);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* A control scrolled into view by Tab stops short of the scroll box's edge, so its ring is not cut off. */
  * {
    scroll-padding: 6px;
  }
  ::selection {
    background: var(--hud-glow);
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }
  img,
  canvas,
  svg {
    display: block;
    max-width: 100%;
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  code,
  kbd,
  samp,
  pre {
    font-family: var(--font-mono);
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      /* One near-instant pass, so an endless pulse settles on its end state instead of flickering. */
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      /* No transitions at all: a forced 0.01 ms duration turns every property change (focus rings included)
         into a transition, since transition-property defaults to all. Nothing here waits for transitionend. */
      transition: none !important;
      scroll-behavior: auto !important;
    }
  }
`;

export default function GlobalStyles() {
  return <Global styles={globalCss} />;
}
