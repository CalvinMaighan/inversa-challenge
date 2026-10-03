"use client";

import styled, { keyframes } from "client/styled";

import { CITE_CLASS } from "./markdown/mount";

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
`;

export const Header = styled.header`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  min-height: 44px;
  padding: var(--gap-xs) var(--gap-xs) var(--gap-xs) var(--gap-m);
  border-bottom: 1px solid var(--border);
`;

export const Title = styled.h2`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font: 600 var(--font-s) / 1.2 var(--font-ui);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

export const Status = styled.span`
  font: 400 var(--font-xs) / 1.2 var(--font-mono);
  letter-spacing: 0;
  text-transform: none;
  color: var(--muted);
`;

export const IconButton = styled.button`
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--muted);
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: var(--surface-2);
    color: var(--text);
  }

  &[aria-pressed="true"] {
    background: var(--accent);
    color: var(--accent-fg);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }

  svg {
    width: 16px;
    height: 16px;
  }
`;

export const VoiceBar = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  min-width: 0;
  padding: 6px var(--gap-m);
  border-bottom: 1px solid var(--border);
  font: 400 var(--font-xs) / 1.3 var(--font-ui);
  color: var(--muted);
`;

export const VoiceDot = styled.span<{ $active: boolean }>`
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ $active }) => ($active ? "var(--ok)" : "var(--muted)")};
  animation: ${pulse} 1.2s ease-in-out infinite;
  animation-play-state: ${({ $active }) => ($active ? "running" : "paused")};
`;

export const VoiceLine = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text);
`;

export const Thread = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--gap-m);
  min-height: 0;
  padding: var(--gap-m);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
`;

export const Empty = styled.p`
  margin: auto 0;
  color: var(--muted);
  font: 400 var(--font-s) / 1.5 var(--font-ui);
  text-align: center;
  text-wrap: balance;
`;

export const UserBubble = styled.div`
  align-self: flex-end;
  /* Said out loud: a small tag says so. */
  &[data-source="voice"]::before {
    content: "voice";
    display: block;
    margin-bottom: 2px;
    color: var(--muted);
    font: 500 10px / 1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  max-width: 85%;
  padding: 6px 10px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font: 400 var(--font-s) / 1.45 var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

export const Assistant = styled.article`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
`;

export const VoiceTag = styled.span`
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-round);
  font: 500 var(--font-xs) / 1.4 var(--font-mono);
  color: var(--muted);
  white-space: nowrap;
  text-overflow: ellipsis;
`;

export const Reasoning = styled.details`
  font: 400 var(--font-xs) / 1.5 var(--font-ui);
  color: var(--muted);

  summary {
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::after {
    content: " ›";
  }

  &[open] summary::after {
    content: " ⌄";
  }

  p {
    margin-top: 4px;
    padding-left: var(--gap-s);
    border-left: 1.5px solid var(--border);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 160px;
    overflow-y: auto;
  }
`;

/** ActionTimeline (deedee `_deedeeTimeline*`). */
export const Timeline = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

export const TimelineLabel = styled.button<{ $state: "running" | "ok" | "error"; $expandable?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px 0;
  border: 0;
  background: none;
  font: 500 var(--font-xs) / 1.5 var(--font-ui);
  text-align: left;
  color: ${({ $state }) => ($state === "error" ? "var(--danger)" : "var(--muted)")};
  cursor: ${({ $expandable }) => ($expandable ? "pointer" : "default")};
  animation: ${pulse} 1.2s ease-in-out infinite;
  animation-play-state: ${({ $state }) => ($state === "running" ? "running" : "paused")};

  &::after {
    content: ${({ $expandable }) => ($expandable ? '"›"' : '""')};
    transition: transform 120ms ease;
  }

  &[aria-expanded="true"]::after {
    transform: rotate(90deg);
  }

  &:hover {
    color: ${({ $state, $expandable }) => ($state === "error" ? "var(--danger)" : $expandable ? "var(--text)" : "var(--muted)")};
  }
`;

export const TimelineRows = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 2px 0 4px 10px;
  border-left: 1.5px solid var(--border);
  margin-left: 2px;
  list-style: none;
`;

export const TimelineRow = styled.li<{ $state: "running" | "ok" | "error" }>`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
  min-width: 0;
  font: 500 var(--font-xs) / 1.5 var(--font-ui);
  color: ${({ $state }) => ($state === "error" ? "var(--danger)" : "var(--text)")};
  animation: ${pulse} 1.2s ease-in-out infinite;
  animation-play-state: ${({ $state }) => ($state === "running" ? "running" : "paused")};

  small {
    font: 400 var(--font-xs) / 1.5 var(--font-mono);
    color: var(--muted);
  }
`;

export const Note = styled.p`
  font: 400 var(--font-xs) / 1.5 var(--font-ui);
  color: var(--muted);
`;

export const PhaseLine = styled.span`
  font: 400 var(--font-xs) / 1.5 var(--font-ui);
  color: var(--muted);
  animation: ${pulse} 1.2s ease-in-out infinite;
`;

/** Markdown body (deedee `CHAT_MARKDOWN_CSS`, sized for the card) plus citation chips. */
export const Body = styled.div`
  min-width: 0;
  overflow-wrap: anywhere;
  font: 400 var(--font-s) / 1.55 var(--font-ui);

  & > :first-child {
    margin-top: 0;
  }
  & > :last-child {
    margin-bottom: 0;
  }
  & p {
    margin: 0 0 0.7em;
  }
  & b,
  & strong {
    font-weight: 650;
  }
  & code {
    padding: 0.05em 0.3em;
    border-radius: 4px;
    background: var(--surface-2);
    font: 500 0.92em / 1.4 var(--font-mono);
  }
  & pre {
    margin: 0.7em 0;
    padding: 8px 10px;
    overflow-x: auto;
    border-radius: var(--radius-s);
    background: var(--surface-2);
    white-space: pre;
  }
  & pre code {
    padding: 0;
    background: transparent;
  }
  & a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  & h1,
  & h2,
  & h3,
  & h4,
  & h5,
  & h6 {
    margin: 0.9em 0 0.35em;
    font-size: 1em;
    font-weight: 650;
  }
  & ul,
  & ol {
    margin: 0.35em 0 0.7em;
    padding-left: 1.3em;
  }
  & li {
    margin: 0.1em 0;
  }
  & blockquote {
    margin: 0.6em 0;
    padding-left: 0.8em;
    border-left: 2px solid var(--border);
    color: var(--muted);
  }
  & hr {
    margin: 0.9em 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  & .md-table {
    max-width: 100%;
    margin: 0.7em 0;
    overflow-x: auto;
  }
  & table {
    min-width: 100%;
    border-collapse: collapse;
    font-size: 0.95em;
  }
  & th,
  & td {
    padding: 4px 8px 4px 0;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  & .${CITE_CLASS} {
    display: inline-grid;
    place-items: center;
    min-width: 1.45em;
    height: 1.45em;
    margin: 0 1px;
    padding: 0 4px;
    border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
    border-radius: var(--radius-round);
    background: color-mix(in oklab, var(--accent) 14%, transparent);
    color: var(--text);
    font: 600 11px / 1 var(--font-mono);
    vertical-align: 0.1em;
    cursor: pointer;
  }

  & .${CITE_CLASS}:hover,
  & .${CITE_CLASS}:focus-visible {
    background: var(--accent);
    color: var(--accent-fg);
  }
`;

export const Sources = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

export const SourceChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 8px 2px 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-round);
  background: transparent;
  color: var(--muted);
  font: 400 var(--font-xs) / 1.4 var(--font-ui);
  cursor: pointer;

  b {
    display: inline-grid;
    place-items: center;
    min-width: 1.4em;
    height: 1.4em;
    border-radius: var(--radius-round);
    background: color-mix(in oklab, var(--accent) 14%, transparent);
    color: var(--text);
    font: 600 11px / 1 var(--font-mono);
  }

  span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &:hover,
  &:focus-visible,
  &[aria-current="true"] {
    border-color: var(--accent);
    color: var(--text);
  }
`;

export const ErrorLine = styled.p`
  font: 400 var(--font-xs) / 1.45 var(--font-ui);
  color: var(--danger);
  overflow-wrap: anywhere;
`;

export const Composer = styled.form`
  display: flex;
  align-items: flex-end;
  gap: var(--gap-xs);
  padding: var(--gap-s);
  border-top: 1px solid var(--border);
`;

export const Input = styled.textarea`
  flex: 1;
  min-width: 0;
  max-height: 120px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: color-mix(in oklab, var(--bg) 70%, transparent);
  font: 400 var(--font-s) / 1.4 var(--font-ui);
  resize: none;
  field-sizing: content;

  &::placeholder {
    color: var(--muted);
  }

  &:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 0;
    border-color: var(--accent);
  }
`;

export const SendButton = styled(IconButton)`
  width: 36px;
  height: 36px;
  background: var(--accent);
  color: var(--accent-fg);

  &:hover:not(:disabled),
  &:focus-visible {
    background: var(--accent-hover);
    color: var(--accent-fg);
  }
`;

/** Mic in the composer; pulses while voice listens or speaks. */
export const MicButton = styled(IconButton)<{ $live: boolean; $pulse: boolean }>`
  width: 36px;
  height: 36px;
  border: 1px solid ${({ $live }) => ($live ? "var(--accent)" : "var(--border)")};
  animation: ${pulse} 1.2s ease-in-out infinite;
  animation-play-state: ${({ $pulse }) => ($pulse ? "running" : "paused")};

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

/** First-visit hint above the composer: one line plus example questions as chips. */
export const Hint = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: var(--gap-s) var(--gap-s) 0;
  font: 400 var(--font-xs) / 1.4 var(--font-ui);
  color: var(--muted);

  p {
    flex: 1 1 100%;
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    margin: 0;
  }

  p span {
    flex: 1;
    color: var(--text);
  }

  ul {
    flex: 1 1 100%;
    display: grid;
    gap: 2px;
    margin: 2px 0 4px;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  li i {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1px solid #0b0d12;
    transform: translateY(1px);
  }

  li b {
    color: var(--text);
    font-weight: 600;
  }
`;

export const HintChip = styled.button`
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid color-mix(in oklab, var(--accent) 45%, var(--border));
  border-radius: var(--radius-round);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  color: var(--text);
  font: 500 var(--font-xs) / 1.3 var(--font-ui);
  text-align: left;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 18%, transparent);
  }
`;
