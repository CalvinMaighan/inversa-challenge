"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import AppIcon from "client/hud/appselect/AppIcon";
import { appTint } from "client/hud/appselect/model";
import styled, { keyframes } from "client/styled";
import { getApp } from "shared/apps";

import Embers from "./Embers";
import { LEAVE_MS, speciesCards } from "./model";
import { choose, enter, introInit, useIntro } from "./store";

const spin = keyframes`
  to { transform: rotate(360deg); }
`;
const rise = keyframes`
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: none; }
`;
const breathe = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--tint) 0%, transparent); }
  50% { box-shadow: 0 0 36px 2px color-mix(in oklab, var(--tint) 38%, transparent); }
`;

const GOLD = "#d8b46a";

const Root = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  background:
    radial-gradient(120% 90% at 50% 38%, rgba(8, 11, 18, 0.35) 0%, rgba(2, 3, 6, 0.82) 100%),
    rgba(4, 6, 10, 0.42);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  backdrop-filter: blur(16px) saturate(1.15);
  color: #ece6d6;
  font-family: var(--font-ui);
  transition:
    opacity ${LEAVE_MS}ms cubic-bezier(0.3, 0, 0.2, 1),
    transform ${LEAVE_MS}ms cubic-bezier(0.3, 0, 0.2, 1),
    backdrop-filter ${LEAVE_MS}ms ease,
    -webkit-backdrop-filter ${LEAVE_MS}ms ease;

  &[data-phase="leaving"] {
    opacity: 0;
    transform: scale(1.1);
    -webkit-backdrop-filter: blur(0) saturate(1);
    backdrop-filter: blur(0) saturate(1);
    pointer-events: none;
  }

  /* No gate when the page did not ask for it (?intro=0): the server still renders it, the stylesheet hides it. */
  html:not([data-intro]) &:not([data-phase="leaving"]) {
    display: none;
  }

  @media (prefers-reduced-motion: reduce) {
    transition-duration: 1ms;
    * {
      animation: none !important;
    }
  }
`;

const Panel = styled.div`
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(1040px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 8px 4px 16px;
  text-align: center;
  scrollbar-width: none;
`;

const Sigil = styled.svg`
  position: absolute;
  top: -150px;
  left: 50%;
  width: 520px;
  height: 520px;
  margin-left: -260px;
  opacity: 0.22;
  pointer-events: none;
  animation: ${spin} 90s linear infinite;

  @media (max-width: 720px) {
    top: -190px;
  }
`;

const Brand = styled.h1`
  position: relative;
  margin: 8px 0 0;
  font: 700 clamp(30px, 6vw, 54px) / 1 var(--font-ui);
  letter-spacing: 0.42em;
  padding-left: 0.42em;
  text-transform: uppercase;
  color: #f4ecd6;
  text-shadow:
    0 0 28px rgba(216, 180, 106, 0.35),
    0 2px 0 rgba(0, 0, 0, 0.6);
  animation: ${rise} 700ms ease both;
`;

const Rule = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  width: min(420px, 80%);
  margin: 16px 0 10px;
  animation: ${rise} 700ms 120ms ease both;

  &::before,
  &::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, transparent, ${GOLD}, transparent);
  }

  span {
    width: 9px;
    height: 9px;
    transform: rotate(45deg);
    border: 1px solid ${GOLD};
    background: rgba(216, 180, 106, 0.25);
  }
`;

const Step = styled.p`
  margin: 0 0 22px;
  font: 600 12px / 1 var(--font-ui);
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: ${GOLD};
  animation: ${rise} 700ms 200ms ease both;
`;

const Cards = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  width: 100%;

  @media (max-width: 860px) {
    grid-template-columns: 1fr;
    gap: 10px;
  }
`;

const Card = styled.button`
  --tint: #888;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-height: 252px;
  padding: 26px 20px 22px;
  border: 0;
  color: inherit;
  text-align: center;
  cursor: pointer;
  font: inherit;
  /* Chamfered corners, a thin gold frame drawn by the layered backgrounds. */
  clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 14px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px), 0 14px);
  background:
    linear-gradient(180deg, rgba(20, 24, 34, 0.9), rgba(8, 10, 16, 0.94)) padding-box,
    linear-gradient(180deg, color-mix(in oklab, ${GOLD} 70%, transparent), color-mix(in oklab, ${GOLD} 14%, transparent)) border-box;
  border: 1px solid transparent;
  animation: ${rise} 700ms ease both;
  transition:
    transform 220ms ease,
    filter 220ms ease,
    background 220ms ease;

  &:nth-of-type(2) {
    animation-delay: 90ms;
  }
  &:nth-of-type(3) {
    animation-delay: 180ms;
  }

  /* The species' own light behind its icon. */
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(60% 46% at 50% 24%, color-mix(in oklab, var(--tint) 30%, transparent), transparent 72%);
    opacity: 0.55;
    transition: opacity 220ms ease;
    pointer-events: none;
  }

  &:hover,
  &:focus-visible {
    transform: translateY(-4px);
    outline: none;
  }
  &:hover::before,
  &:focus-visible::before,
  &[aria-checked="true"]::before {
    opacity: 1;
  }

  &[aria-checked="true"] {
    transform: translateY(-6px);
    background:
      linear-gradient(180deg, rgba(26, 30, 42, 0.94), rgba(10, 12, 20, 0.96)) padding-box,
      linear-gradient(180deg, var(--tint), color-mix(in oklab, var(--tint) 20%, transparent)) border-box;
    animation: ${breathe} 2.6s ease-in-out infinite;
  }
  [data-phase="enter"] &[aria-checked="false"] {
    filter: saturate(0.4) brightness(0.62);
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px ${GOLD};
  }

  @media (max-width: 860px) {
    min-height: 0;
    flex-direction: row;
    text-align: left;
    gap: 14px;
    padding: 16px 18px;
    align-items: center;
  }
`;

const Medallion = styled.span`
  position: relative;
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  flex: none;
  border-radius: 50%;
  border: 1px solid color-mix(in oklab, var(--tint) 60%, transparent);
  background: radial-gradient(circle at 50% 35%, color-mix(in oklab, var(--tint) 22%, #0a0c12), #07090e 72%);
  box-shadow:
    inset 0 0 22px color-mix(in oklab, var(--tint) 25%, transparent),
    0 0 0 5px rgba(0, 0, 0, 0.35),
    0 0 0 6px color-mix(in oklab, ${GOLD} 40%, transparent);

  @media (max-width: 860px) {
    width: 64px;
    height: 64px;
  }
`;

const CardBody = styled.span`
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: inherit;
  gap: 6px;
`;

const Title = styled.span`
  font: 700 19px / 1.15 var(--font-ui);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #f4ecd6;
`;

const Area = styled.span`
  font: 600 11px / 1.3 var(--font-ui);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--tint);
`;

const Blurb = styled.span`
  font: 400 13px / 1.5 var(--font-ui);
  color: rgba(236, 230, 214, 0.74);
  text-wrap: balance;

  @media (max-width: 860px) {
    display: none;
  }
`;

const Stat = styled.span`
  margin-top: auto;
  padding-top: 8px;
  font: 500 11px / 1 var(--font-mono, ui-monospace);
  letter-spacing: 0.08em;
  color: rgba(236, 230, 214, 0.5);

  @media (max-width: 860px) {
    display: none;
  }
`;

const Footer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 176px;
  margin-top: 26px;
  animation: ${rise} 700ms 300ms ease both;
`;

/** The button, its hint and the skip link: always there, faint and dead until a species is chosen. */
const Actions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  opacity: 0.15;
  pointer-events: none;
  transition: opacity 400ms ease;

  &[data-active] {
    opacity: 1;
    pointer-events: auto;
  }
`;

const Cta = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 15px 32px 15px 26px;
  border: 1px solid ${GOLD};
  clip-path: polygon(12px 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 12px 100%, 0 50%);
  background: linear-gradient(180deg, rgba(216, 180, 106, 0.28), rgba(216, 180, 106, 0.1));
  color: #f7efd9;
  font: 700 14px / 1 var(--font-ui);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background 160ms ease,
    transform 160ms ease;

  &:hover:not(:disabled),
  &:focus-visible {
    background: linear-gradient(180deg, rgba(216, 180, 106, 0.5), rgba(216, 180, 106, 0.2));
    outline: none;
    transform: translateY(-1px);
  }
  &:disabled {
    opacity: 0.7;
    cursor: progress;
  }
`;

const Quiet = styled.button`
  border: 0;
  background: none;
  color: rgba(236, 230, 214, 0.62);
  font: 500 12px / 1.4 var(--font-ui);
  letter-spacing: 0.06em;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: #f4ecd6;
    outline: none;
  }
`;

const Hint = styled.p`
  margin: 0;
  max-width: 460px;
  font: 400 12.5px / 1.5 var(--font-ui);
  color: rgba(236, 230, 214, 0.62);

  &[data-tone="warn"] {
    color: #ffb4a0;
  }
`;

const Loading = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  width: min(360px, 80%);
  margin-top: auto;
  font: 500 10.5px / 1 var(--font-mono, ui-monospace);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(236, 230, 214, 0.5);

  div {
    width: 100%;
    height: 2px;
    background: rgba(236, 230, 214, 0.12);
    overflow: hidden;
  }
  b {
    display: block;
    height: 100%;
    width: 100%;
    transform-origin: left;
    background: linear-gradient(90deg, ${GOLD}, #fff2c8);
    transition: transform 300ms ease;
  }
`;

function Mic() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/**
 * The first-run gate (docs/intro.md): a full-screen blurred layer over the globe with the three species to choose
 * from. The first click picks one (its data is already loading), the second asks for the microphone and opens the
 * app with the guide's welcome. The page's own chrome stays hidden meanwhile (`html[data-intro]`, layout.tsx).
 */
export default function Intro() {
  const intro = useIntro();
  const cards = speciesCards();
  const cta = useRef<HTMLButtonElement>(null);
  const firstCard = useRef<HTMLButtonElement>(null);

  // A layout effect: the head script's attribute is put back before the first paint after hydration.
  useLayoutEffect(introInit, []);
  useEffect(() => {
    if (intro.phase === "enter") cta.current?.focus();
  }, [intro.phase]);
  useEffect(() => {
    if (intro.phase === "pick") firstCard.current?.focus({ preventScroll: true });
  }, [intro.phase]);

  if (intro.phase === "done") return null;
  const ready = intro.progress >= 1;
  const picked = intro.phase !== "pick";

  return (
    <Root data-intro-root="" data-phase={intro.phase} role="dialog" aria-modal="true" aria-label="Welcome to Inversa. Choose a species.">
      <Embers variant="gate" />
      <Panel>
        <Sigil viewBox="-100 -100 200 200" fill="none" stroke={GOLD} strokeWidth="0.5" aria-hidden="true">
          <circle r="96" />
          <circle r="88" strokeDasharray="2 5" />
          <circle r="62" />
          <polygon points="0,-62 53.7,31 -53.7,31" />
          <polygon points="0,62 53.7,-31 -53.7,-31" />
          {Array.from({ length: 24 }, (_, i) => (
            <line key={i} x1="0" y1="-88" x2="0" y2="-96" transform={`rotate(${i * 15})`} />
          ))}
        </Sigil>
        <Brand>Inversa</Brand>
        <Rule aria-hidden="true">
          <span />
        </Rule>
        <Step>{picked ? "II · Wake your guide" : "I · Choose your species"}</Step>
        <Cards role="radiogroup" aria-label="Species">
          {cards.map((c, i) => {
            const app = getApp(c.id);
            const tint = appTint(app);
            return (
              <Card
                key={c.id}
                ref={i === 0 ? firstCard : undefined}
                type="button"
                role="radio"
                aria-checked={intro.app === c.id}
                disabled={intro.busy}
                style={{ ["--tint" as string]: tint }}
                onClick={() => choose(c.id)}
                data-species={c.id}
              >
                <Medallion>
                  <AppIcon icon={app.icon} color={tint} size={intro.app === c.id ? 84 : 76} outline={false} />
                </Medallion>
                <CardBody>
                  <Title>{c.title}</Title>
                  <Area>{c.area}</Area>
                  <Blurb>{c.blurb}</Blurb>
                  <Stat>{c.stat}</Stat>
                </CardBody>
              </Card>
            );
          })}
        </Cards>
        <Footer>
          <Actions data-active={picked ? "" : undefined} inert={!picked}>
            <Cta ref={cta} type="button" disabled={intro.busy} onClick={() => void enter(true)}>
              <Mic />
              {intro.busy ? "Waiting for the microphone…" : "Enter the Inversa Experience"}
            </Cta>
            <Hint data-tone={intro.note ? "warn" : undefined}>
              {intro.note
                ? `${intro.note.replace(/[.\s]*$/, ".")} Allow the microphone for this site, or carry on without voice.`
                : "Your browser will ask for the microphone. Your guide speaks first and answers by voice."}
            </Hint>
            {intro.note || !intro.busy ? (
              <Quiet type="button" onClick={() => void enter(false)}>
                Continue without voice
              </Quiet>
            ) : null}
          </Actions>
          <Loading aria-live="polite">
            <div>
              <b style={{ transform: `scaleX(${intro.progress})` }} />
            </div>
            {ready ? "Two years of data ready" : `Loading two years of records · ${Math.round(intro.progress * 100)}%`}
          </Loading>
        </Footer>
      </Panel>
    </Root>
  );
}
