/**
 * Ocean-data guide for Lionfish Watch (docs/LIONFISH_WATCH.md R10): what each measurement is, why the survey
 * view uses it, where it comes from and what it cannot tell you. Plain text; the help panel and the evidence
 * card both read it.
 */
import type { HelpTopic } from "./store";

export type HelpSource = { label: string; href: string };

export type HelpEntry = {
  id: HelpTopic;
  title: string;
  /** What the number is. */
  what: string;
  /** Why it is on the survey view, and how far it goes. */
  why: string;
  source: string;
  links: HelpSource[];
  limits: string;
};

const CRW: HelpSource = { label: "NOAA Coral Reef Watch, 5 km products", href: "https://coralreefwatch.noaa.gov/product/5km/index.php" };
const CRW_DATA: HelpSource = { label: "CRW dhw_5km dataset (PacIOOS ERDDAP)", href: "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.html" };
const MARINE: HelpSource = { label: "Open-Meteo Marine Weather API", href: "https://open-meteo.com/en/docs/marine-weather-api" };
const NDBC: HelpSource = { label: "NOAA National Data Buoy Center", href: "https://www.ndbc.noaa.gov/" };

export const HELP: readonly HelpEntry[] = [
  {
    id: "temperature",
    title: "Sea surface temperature (SST)",
    what: "Temperature of the top layer of the sea, in °C. Coral Reef Watch gives one value per 5 km pixel per day; Florida buoys measure it about a metre down every hour or so.",
    why: "Background for the heat-stress layer, and the input both anomaly and DHW are built from. It does not rank cells by itself.",
    source: "NOAA Coral Reef Watch CoralTemp (satellite, daily). Buoy water temperature from NOAA NDBC, Florida only.",
    links: [CRW, CRW_DATA, NDBC],
    limits: "A 5 km pixel mixes reef, sand and deeper water. Satellite and buoy can disagree by half a degree or more because they measure different depths and times; the view shows both and never averages them.",
  },
  {
    id: "anomaly",
    title: "SST anomaly",
    what: "Today's SST minus the long-term average for this day of the year at the pixel, in °C. Positive means warmer than usual.",
    why: "Shows how unusual the water is right now. A short warm spell shows here before it builds up in DHW.",
    source: "NOAA Coral Reef Watch, CRW_SSTANOMALY in the dhw_5km dataset.",
    links: [CRW, CRW_DATA],
    limits: "A difference from a climatology, not a measure of harm. It says nothing about lionfish.",
  },
  {
    id: "dhw",
    title: "Degree heating weeks (DHW)",
    what: "Heat stress accumulated over the last 12 weeks, in °C-weeks: every day the water is at least 1 °C above the warmest month's usual mean adds to it. Around 4 bleaching becomes likely; around 8, severe bleaching and coral death.",
    why: "Accumulated stress on the reef, used in the heat-stress component as context for where reefs are under pressure. Context, not proof of lionfish damage.",
    source: "NOAA Coral Reef Watch, CRW_DHW in the dhw_5km dataset.",
    links: [CRW, CRW_DATA],
    limits: "A model of thermal stress from satellite SST, not an observation of bleaching. It stays high for weeks after the water cools.",
  },
  {
    id: "baa",
    title: "Bleaching alert area (BAA)",
    what: "Today's alert level: No stress (0), Bleaching watch (1), Bleaching warning (2), then Alert level 1 (3) and up as DHW passes 4, 8 and beyond. Warning and the alert levels need the water to be at least 1 °C above the usual warmest month today.",
    why: "The current state next to DHW's accumulated one. Both are shown because they can disagree: after the water cools, BAA drops to watch or no stress while DHW still carries weeks of stress (Florida on 2026-09-29: DHW 13.65, BAA 1).",
    source: "NOAA Coral Reef Watch, CRW_BAA in the dhw_5km dataset.",
    links: [CRW, CRW_DATA],
    limits: "A daily satellite product, about 1.7 days behind. Older than 72 hours, the view marks it stale; missing pixels stay missing, never zero.",
  },
  {
    id: "waves",
    title: "Waves",
    what: "Significant wave height (m) and wave period (s), forecast hourly for the next three days on a coarse grid.",
    why: "Field planning only: calm hours (waves under 1.2 m) tell a dive team when a survey is workable. Kept apart from survey priority and never part of the rank.",
    source: "Open-Meteo Marine (Météo-France wave model). Free tier: non-commercial use, CC BY 4.0.",
    links: [MARINE],
    limits: "A model forecast on a grid of about half a degree; it does not resolve reef crests, lagoons or harbours. A forecast, not an observation.",
  },
  {
    id: "currents",
    title: "Currents",
    what: "Surface current speed (m/s, converted from the source's km/h) and direction, forecast hourly for three days.",
    why: "Field planning only: strong currents make transects and drift dives harder. Not part of survey priority.",
    source: "Open-Meteo Marine (Météo-France currents model).",
    links: [MARINE],
    limits: "Modelled surface currents on a coarse grid; currents at depth and around the reef differ.",
  },
];

/** Why the four priority components exist, and what the view refuses to claim. */
export const RELEVANCE: readonly string[] = [
  "Survey priority orders cells by four separate components: recent reports, identification quality, reef heat stress and data completeness. The rank only says where to look first.",
  "Recent reports are people's uploads. More reports can mean more divers and more observers, not more lionfish; no reports can mean nobody looked.",
  "Heat stress is context about the reef, not evidence that lionfish caused or will cause damage.",
  "Data completeness lowers confidence when feeds are thin or stale; it never raises or lowers the rank.",
];

export function helpEntry(id: HelpTopic): HelpEntry {
  return HELP.find((h) => h.id === id) ?? HELP[0]!;
}
