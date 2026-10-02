import { key } from "@calvinjs/active-state";

/** The period the timelines span, ending today: the choices of the range button in the top row. */
export const RANGE_OPTIONS: readonly { days: number; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
];

export const DEFAULT_RANGE_DAYS = 365;

/** How many days back the timeline starts (python and lionfish's TIME window, carp's sightings window). */
export const RANGE_DAYS = key("RANGE_DAYS", DEFAULT_RANGE_DAYS);

export const rangeLabel = (days: number): string => RANGE_OPTIONS.find((o) => o.days === days)?.label ?? `${days} days`;
