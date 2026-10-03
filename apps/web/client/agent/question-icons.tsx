import type { ReactNode } from "react";

import type { QuestionIcon } from "shared/apps/question-catalog";

const PATHS: Record<QuestionIcon, ReactNode> = {
  species: (
    <>
      <path d="M2 8.5c2-3.2 5-4.5 8-4.5 1.6 0 3 .4 4 1l-1.4 2.2L14 9.5c-1 .8-2.4 1.3-4 1.3-3 0-6-1.2-8-3.4z" />
      <circle cx="10.6" cy="7" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  pin: <path d="M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14zM8 8.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z" />,
  water: <path d="M8 2.2S4 6.4 4 9.2a4 4 0 0 0 8 0C12 6.4 8 2.2 8 2.2zM6.2 9.6a2 2 0 0 0 1.6 1.6" />,
  hotspot: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="2.8" />
      <circle cx="8" cy="8" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  source: <path d="M3 4.5C3 3.4 5.2 2.5 8 2.5s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4.5v3.5c0 1.1 2.2 2 5 2s5-.9 5-2V4.5M3 8v3.5c0 1.1 2.2 2 5 2s5-.9 5-2V8" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.6V8l2.3 1.5" />
    </>
  ),
  layers: <path d="M8 2 14 5.2 8 8.4 2 5.2zM2.5 8 8 11 13.5 8M2.5 10.8 8 13.8l5.5-3" />,
  voice: <path d="M8 10.3a2.3 2.3 0 0 0 2.3-2.3V4.3a2.3 2.3 0 0 0-4.6 0V8A2.3 2.3 0 0 0 8 10.3zM3.8 7.6A4.2 4.2 0 0 0 8 11.8a4.2 4.2 0 0 0 4.2-4.2M8 11.8V14" />,
};

/** Small stroke icons for the question topics (16 px box, currentColor). */
export function QuestionIconView({ name }: { name: QuestionIcon }) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
