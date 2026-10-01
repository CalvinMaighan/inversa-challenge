/**
 * Converts each question file's regex `pass.phrases` into plain-language `pass.mustSay` statements for the semantic
 * judge (gates/leaf-J1.md, apps/web/eval/judge.ts). Re-runnable and idempotent: a question that already has
 * `mustSay` and no `phrases` is left alone, so the script can run again after another branch edits the files.
 *
 *   bun scripts/migrate-phrases-to-mustsay.ts            convert in place, print a summary
 *   bun scripts/migrate-phrases-to-mustsay.ts --check    exit 1 if any file still has `phrases` or an unmapped regex
 *
 * Every regex maps to a statement through STATEMENTS (by regex source) or OVERRIDES (by question id and regex), all
 * written and reviewed by hand: the statement says what the regex was testing for, in the sense the question's
 * intent gives it, so a paraphrase passes and a keyword in the wrong sense does not. A regex with no mapping is
 * converted by `fallback()` to a "mentions one of" statement and reported, so a reviewer adds a mapping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FILES = ["carp", "lionfish", "python", "carp.holdout", "lionfish.holdout", "python.holdout"];
const MARK = "J1 (gates/leaf-J1.md): pass.phrases (regexes) migrated to pass.mustSay";
const MARK2 = "J1 wording review after the first live run";

type Pass = { mode: string; phrases?: string[]; mustSay?: string[]; forbid: string[]; [k: string]: unknown };
type Question = { id: string; pass: Pass; [k: string]: unknown };
type File = { changelog?: unknown[]; questions: Question[]; [k: string]: unknown };

// Recurring regexes, shared by many questions. The statement names the meaning, not the words.
const LIMIT = "(cannot|can't|can ?not|unable to|do not|don't|does not|doesn't|is not|isn't|no data|not something)";
const LIMIT2 = "(cannot|can't|can ?not|unable to|do not|don't|does not|doesn't|is not|isn't|no data|not something|no way to)";
const GAP = "(?:[^.]|\\.\\d)";
const POPULATION = `(reports?|sightings?)${GAP}{0,60}(not|aren't|are not|isn't|is not)${GAP}{0,40}(abundance|population|how many)|${LIMIT}${GAP}{0,60}(population|abundance)`;
const FRESH = "(\\d+(\\.\\d+)? ?(h|hours?|min|minutes?|days?) (old|ago)|as of|updated|fetched)";
const THIN = "(few|thin|sparse|only (one|1|two|2|three|3|four|4)|no (recent )?reports|single report)";
const COMPONENTS = "(recent reports|heat stress|ID quality|identification|completeness)";
const NO_REPORTS_NOT_ABSENCE = `(not (the same as|mean)|doesn't mean|does not mean)${GAP}{0,60}(absen|no lionfish|none there)|no reports? (is|are) not`;
const FOUR_AREAS = `(Florida Keys|four areas)${GAP}{0,120}(Mexic|Belize|Colombia)|four (survey )?areas`;
const SCOPE_ONLY = `(only|${LIMIT})`;

const FRESHNESS = "Says how fresh its data is: an age, an as-of time, or when it was updated or fetched";
const POP_CAVEAT = "Says that report counts reflect reporting or observer effort and do not measure the animal population or abundance, or that it cannot judge population or abundance from this data";
const KNOWN_THEN = "Frames the answer as what was known at that past time, as of then";
const LATER_SEPARATE = "Keeps what arrived or changed later separate from what was known at that time";
const DEGREES = "Gives a temperature in degrees";
const NAMES_CRW = "Names NOAA Coral Reef Watch or CRW";
const NAMES_IEM = "Names IEM or the Iowa Environmental Mesonet";
const NAMES_IN = (name: string) => `Names ${name}`;
const DIRECTION = "States the direction of the change: rose, fell or held steady";
const ISSUED = "States when the forecast issuance it uses was issued, or identifies that issuance by time";
const STAGE_FT = "Gives a stage or height value in feet";
const REASON = "Gives the reason a site needs review: the rule, trigger or threshold behind the flag";
const NO_PERCENT = "Says in its own words that it does not give a probability, percentage or odds";
const CANNOT_SAFE = "Says in its own words that it cannot judge whether it is safe";

const STATEMENTS: Record<string, string> = {
  heuristic: "Says the score or ranking is a heuristic rather than a measurement or prediction",
  "\\bft\\b|feet": STAGE_FT,
  "(issued|issuance)": ISSUED,
  [FRESH]: FRESHNESS,
  "(\\d+(\\.\\d+)? ?(h|hours?|min|minutes?) (old|ago)|as of)": "Gives the age of the reading or the time it is as of",
  "(\\d+(\\.\\d+)? ?(h|hours?|min|minutes?|days?) (old|ago)|as of|fetched|updated|nominal|lagging|stale)": "Says how fresh the feed is: an age, an as-of or fetch time, or its state such as nominal, lagging or stale",
  "(hours?|h) (old|ago)": "Gives the issuance age in hours",
  "(hours?|h|days?) (old|ago)|as of": "Gives the issuance age or its as-of time",
  [POPULATION]: POP_CAVEAT,
  observed: "Gives the observed date of the reports, when the animals were seen",
  "(observed)": "Counts or lists the reports by their observed date",
  mission: "Refers to the missions on the team board, or says there are none",
  "mission|survey": "Reports the missions or surveys on the team board, or says there are none",
  "(python|Burmese python)": "Refers to pythons, the Burmese python",
  USGS: NAMES_IN("USGS as a source"),
  [SCOPE_ONLY]: "Says it cannot help with this request, or that the app covers only its own species and area",
  "Morgan City|MCGL1": NAMES_IN("Morgan City or MCGL1"),
  "Morgan City": "Names Morgan City as the place it reports on",
  "public domain": "Says the data is public domain",
  "DHW|degree heating": "Reports degree heating weeks, the DHW value",
  "(DHW|degree heating)": "Names degree heating weeks or DHW",
  "(degree heating|DHW)": "Explains degree heating weeks, the DHW",
  "\\d(\\.\\d+)?\\s*(m|metres|meters)\\b": "Gives a wave height in metres",
  wave: "Reports the wave forecast or wave height",
  "(wave|current)": "Gives the modelled waves or currents",
  "(wave|sea|current)": "Uses the marine forecast, waves or currents, to pick the day",
  alert: "Reports or explains the NWS alerts, including when none are active",
  "(as of|at the time|known|knew)": KNOWN_THEN,
  "(as of|at the time|known|then)": KNOWN_THEN,
  "(as of|at the time|known|knew|then)": KNOWN_THEN,
  "(as of|at the time|known|knew|at that (time|point))": KNOWN_THEN,
  "(noted|wrote|note)": "Reports the notes, what the team noted or wrote, or says there are none",
  "(note|noted|no notes)": "Reports the notes near the place, or says there are none",
  "(noted|wrote|note|no notes)": "Names who wrote the notes, or says there are none",
  "(note|noted|wrote|posted)": "Reports it as a note someone posted, as what its author wrote",
  note: "Reports the notes with what their authors wrote",
  Belize: "Names Belize as the place it reports on",
  [THIN]: "Says the reports in the window are few, thin or absent",
  thin: "Says which areas are thin on reports",
  [COMPONENTS]: "Names the priority components, such as recent reports, heat stress, ID quality or completeness",
  "\\d+": "Gives the count as a number",
  "(Coral Reef Watch|CRW)": NAMES_CRW,
  "(CRW|Coral Reef Watch)": NAMES_CRW,
  cold: "Refers to the cold, the low temperatures",
  "(Everglades|South Florida)": "Says the app covers the Everglades or South Florida region only",
  "Krotz|KRZL1": NAMES_IN("Krotz Springs or KRZL1"),
  Krotz: "Names Krotz Springs as the place it reports on",
  forecast: "Reports what the forecast says",
  NWPS: "Names NWPS as a source",
  NWS: "Names NWS as a source",
  "NWS|NWPS": "Names NWS or NWPS as a source",
  "NWPS|NWS": "Names NWPS or NWS as a source",
  "(USGS|NWPS)": "Names the gauge source, USGS or NWPS",
  "(USGS|NWPS|NWS)": "Names the feeds that cover the sites, such as USGS, NWPS or NWS",
  "NWPS|National Water Prediction|NWS": NAMES_IN("NWPS, the National Water Prediction Service or NWS"),
  "NWS|NWPS|National Weather Service|NOAA": "Names the National Weather Service, NWS or NOAA, as the publisher",
  [`${LIMIT}${GAP}{0,60}safe`]: CANNOT_SAFE,
  [`${LIMIT2}${GAP}{0,60}(safe|safety|judge|decide|access|whether)`]: CANNOT_SAFE,
  "(report|sighting)": "Reports the sighting reports",
  report: "Reports the sighting reports, or says there were none",
  "report|sighting": "Summarises the sightings as reports",
  "(message|wrote|said|sent)": "Summarises what the team messages said",
  "(message|wrote|said|sent|no messages)": "Summarises what the team messages said, or says there are none",
  stale: "Says the feed or data is stale",
  down: "Says a feed is down",
  ndbc: "Names the NDBC feed as a source",
  "(LST|land surface)": NAMES_IN("land surface temperature or LST"),
  activity: NAMES_IN("the activity term"),
  "(activity|score)": "Describes how the activity term or the scores moved",
  "(activity|heuristic)": "Says LST feeds the activity heuristic",
  updat: "States when the forecast was updated",
  "(updat|issued|as of|fetched)": "Gives the forecast's update or issue time",
  "tid(al|e)": "Says the site is tidal",
  action: NAMES_IN("the action stage"),
  "action|threshold": NAMES_IN("the action stage threshold"),
  "action (stage|level|threshold)": NAMES_IN("the action stage threshold"),
  "(action|threshold|rule)": "Names the rule or the threshold it hit",
  stage: "Explains what river stage is",
  "stage|water level": "Reports the stage, the water level",
  "(stage|water level)": "Reports the stage, the water level",
  "(gauge|stage)": "Refers to the gauge stage",
  review: "Names the sites that need review",
  "review|flag": "Names the sites flagged for review",
  "review|flagged": "Names the flagged sites, those needing review",
  "needs? (operational )?review": "Names the sites that need operational review",
  "(research|needs id|casual|grade)": "Gives the quality grade of the reports, such as research, needs ID or casual",
  "(research|needs id|casual|curated|grade)": "Gives the quality grade or curation of the reports, such as research, needs ID, casual or curated",
  research: "Gives the research grade split of the reports",
  Colombia: "Names Colombia as the place it reports on",
  Cozumel: "Names Cozumel as the place it reports on",
  context: "Says heat stress is context, not evidence about lionfish",
  GBIF: "Names GBIF as a source",
  NAS: "Names USGS NAS as a source",
  "(iNaturalist|GBIF|NAS)": "Names the feed the record came from: iNaturalist, GBIF or NAS",
  "https?:\\/\\/": "Gives the publisher page link as a URL",
  GOES: "Names the GOES satellite as a source",
  baseline: "Compares the measured hit rate with the baseline",
  cloud: "Mentions cloud gaps or cloud flags in the satellite data",
  "Shark Valley": "Names Shark Valley as the place it reports on",
  "Alexandria|AEXL1": NAMES_IN("Alexandria or AEXL1"),
  "(because|reason|due to|trigger|rule|peaks? at|reach(es|ing)?)": REASON,
  "(because|reason|due to|since|as )": REASON,
  "(because|reason|due to|triggered)": "Gives the reason: what triggered the flip to needs review",
  "Simmesport|SMML1": NAMES_IN("Simmesport or SMML1"),
  Simmesport: "Names Simmesport as the place it reports on",
  "Butte La Rose|BLRL1": NAMES_IN("Butte La Rose or BLRL1"),
  "Butte La Rose": "Names Butte La Rose as the place it reports on",
  "Baton Rouge|BTRL1": NAMES_IN("Baton Rouge or BTRL1"),
  "Bogalusa|BXAL1": NAMES_IN("Bogalusa or BXAL1"),
  "07381490|SMML1": "Names the gauge: USGS 07381490 or NWPS SMML1",
  "(Simmesport|Krotz|Butte La Rose|Morgan City)": "Names the Atchafalaya sites",
  "(\\u00B0F|degrees|\\bF\\b)": DEGREES,
  "(\\u00B0C|\\u00B0F|degrees)": DEGREES,
  "(\\u00B0F|\\u00B0C|degrees)": DEGREES,
  "(\\u00B0F|degrees|temperature)": "Gives the forecast temperatures in degrees",
  "low[- ]water|low threshold": "Refers to the low water flag or threshold",
  "low[- ]water|low threshold|below": "Reports the low water threshold flags or forecast minimums",
  "(discharge|flow)": "Explains what discharge, the flow, tells",
  "(IEM|Iowa)": NAMES_IEM,
  "IEM|Iowa": NAMES_IEM,
  "(IEM|archive)": NAMES_IEM,
  "(IEM|archive|Iowa)": NAMES_IEM,
  "(IEM|Iowa Environmental Mesonet)": NAMES_IEM,
  cfs: "Gives flow in cfs or kcfs",
  "k?cfs": "Gives flow in cfs or kcfs",
  "k?cfs|cubic feet": "Gives discharge in cfs, kcfs or cubic feet per second",
  "\\bft\\b|feet|beyond|horizon": "Gives the forecast stage in feet, or says the date lies beyond the forecast horizon",
  "(Saturday|Sunday|weekend)": "Addresses the weekend days",
  "(river|stage|forecast|conditions)": "Says what the app does cover, such as river conditions, stage or forecasts",
  "(eight|8) (river )?(sites|locations|gauges)|demonstration locations|Atchafalaya": "Names the eight demonstration locations or the Atchafalaya as what the app covers",
  "(eight|8)|demonstration|not (one of|among|covered)|outside|only (cover|has|hold)|Louisiana": "Says the place is outside the eight Louisiana demonstration locations the app covers",
  "Mexican Caribbean|Quintana Roo|Cozumel|Chinchorro": NAMES_IN("the Mexican Caribbean area, such as Quintana Roo, Cozumel or Chinchorro"),
  "alert level|BAA|bleaching alert": "Reports the bleaching alert level",
  "alert level|BAA": "Reports the bleaching alert level",
  "(alert level|BAA)": "Explains the bleaching alert level",
  "\\d{4}-\\d{2}-\\d{2}|days? (old|ago)|as of": "Gives the data date or age of the CRW data",
  "(model|Open-Meteo|forecast)": "Says the wave values are a modelled forecast, from Open-Meteo",
  [NO_REPORTS_NOT_ABSENCE]: "Says that having no reports does not mean there are no lionfish there",
  "San Andr[e\\u00E9]s|Colombia": NAMES_IN("San Andrés or Colombia"),
  "\\u00B0C-weeks|degree.?C.?weeks|C-weeks": "Gives DHW in degree C weeks",
  "(Florida Keys|Mexican Caribbean|Belize|Colombia)": "Names the areas: Florida Keys, Mexican Caribbean, Belize or Colombia",
  accumulat: "Says DHW accumulates heat stress over weeks",
  "(heat stress|history|GBIF|NAS)": "Says what Belize still shows: heat stress, or the historical records from GBIF or NAS",
  "recent reports": NAMES_IN("the recent reports component"),
  "(ID quality|identification)": NAMES_IN("the ID quality component"),
  "heat stress": NAMES_IN("the heat stress component"),
  completeness: NAMES_IN("the completeness component"),
  weight: "Says the components are weighted, or gives their weights",
  "(field|dive|survey)": "Says waves and currents bear on field or dive conditions, when to go",
  "(reef|heat stress)": "Refers to reef heat stress",
  model: "Says the values are modelled",
  "submitted|uploaded": "Gives the submitted or upload date",
  "(days|months|years) (later|after|before|earlier)": "States the lag between observation and submission in days, months or years",
  "duplicate|copy|copies": "Says the GBIF records are duplicates or copies of iNaturalist observations",
  "duplicate|dedup": "Says GBIF copies are deduplicated against iNaturalist",
  duplicate: "Says duplicate records exist or were removed",
  "iNaturalist|iNat": "Names iNaturalist as a source",
  iNat: "Names iNaturalist as a source",
  iNaturalist: "Names iNaturalist as a source",
  "(not|never) (counted|count)": "Says the duplicates are not counted twice",
  "buoy|in-situ|measured": "Names the buoy, the in-situ measured reading",
  "measured|in-situ": "Says which reading is measured in situ",
  "satellite|GOES": "Names the satellite reading",
  "(obscured|imprecise|accuracy|uncertain|open (sea|water)|offshore)": "Says the position is obscured, imprecise or uncertain, with its accuracy",
  "(heat|DHW|alert level)": "Reports the heat stress: DHW or alert level",
  "(DHW|heat)": "Reports the heat stress",
  "(heat|SST|anomaly)": "Reports the heat stress, SST or anomaly",
  "(3|three)[- ]days?|72 hours": "Says the marine forecast covers three days, 72 hours",
  "(beyond|cannot|can't|doesn't|does not|only)": "Says the date lies beyond what the forecast covers",
  "(DOI|credit)": "Gives the required credit or DOI",
  "CC BY": NAMES_IN("the CC BY licence"),
  "non-commercial": "Says Open-Meteo is for non-commercial use",
  "(later|since|afterwards|after that)": LATER_SEPARATE,
  "(later|since|after)": LATER_SEPARATE,
  "(later|since then|afterwards|after that)": LATER_SEPARATE,
  "(since then|later|afterwards|after that|now)": LATER_SEPARATE,
  "(later|then|at the time|at that time|as of|replay|since|afterwards)": "Separates what the issuance showed at that time from what happened later",
  "\\d{4}-\\d{2}-\\d{2}|(January|February|March|April|May|June|July|August|September|October|November|December) \\d": "Gives the date of the peak",
  "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|day)": "Goes through the window day by day, or names the days",
  "(then|at the time|differ|changed|same)": "Compares the past ranking with today's, saying whether it differs",
  [`(no|not|don't|do not|doesn't)${GAP}{0,60}(percent|single|risk (score|number))`]: "Says in its own words that it does not give a single risk percentage or score",
  component: "Points to the separate priority components instead",
  lionfish: "Names lionfish as what the app covers",
  [FOUR_AREAS]: "Names the four survey areas the app covers, such as the Florida Keys, Mexican Caribbean, Belize and Colombia",
  "Looe Key": "Names Looe Key as the place it reports on",
  "Lionfish Watch|lionfish app": "Points to the Lionfish Watch app for lionfish",
  density: NAMES_IN("the density term"),
  "conflict|disagree|differ": "Says the two readings conflict or disagree",
  "(disagree|differ|conflict|mismatch)": "Says the two values disagree or conflict",
  "(disagree|differ|conflict|agree)": "States whether the buoy and satellite readings agree or disagree",
  python: "Names pythons as the species reported",
  "Big Cypress": "Names Big Cypress as the place it reports on",
  "(distinct|duplicate|dedup)": "Says the count is of distinct reports after removing duplicates",
  "(last|previous|prior) week": "Gives last week's count for comparison",
  "(more|fewer|same|up|down|rose|fell|increase|decrease|\\d+ (to|vs\\.?|versus|compared with) \\d+)": "States the direction of the difference between the two weeks",
  "(more|fewer|same|no change|up|down|from \\d+ to \\d+)": "States the direction of the change between the two months",
  "(up|down|same|more|fewer)": "States whether reports are up, down or the same",
  "(rose|fell|warmer|cooler|steady|up|down|gap|missing|cloud)": "Describes the trend of the series, or the gaps in it",
  "(new|no new)": "Says what is new, or that nothing is",
  "(new|since yesterday|no new)": "Says what is new since yesterday, or that nothing is",
  "(density|activity|access)": "Names the score terms: density, activity or access",
  "(temperature|LST|air)": "Names the temperature inputs to the activity term",
  "(access|context|conditions)": "Says stage is context, or relates it to access or conditions",
  access: NAMES_IN("the access term"),
  "(road|trail|distance|rationale)": "Explains the access value from its rationale, such as road or trail distance",
  "(needs id|casual|conflict|unconfirmed)": "Names the reports graded needs ID or casual, or with ID conflicts",
  "(late|after|lag)": "Says the records arrived late, after observation",
  "(hours?|days?)": "Gives the lag in hours or days",
  "(forecast|weekend)": "Gives the weekend forecast separately, or says the forecast does not reach the weekend",
  "(night|evening)": "Names the best night or evening",
  "(missing|stale|no recent|gap|cloud)": "Names areas or feeds with missing, stale or no recent data",
  "(threshold|activity term|heuristic)": "Relates the temperatures to the activity term, its thresholds or the heuristic",
  "(CC|Creative Commons|licen[cs]e)": "Names the licence of each feed",
  "(weeks|months|days|lag)": "Gives the NAS cadence or lag in days, weeks or months",
  "(30[- ]days?|month)": "Covers the 30 day, one month, window",
  "(January|2026-01)": "Places the scene in January 2026",
  Flamingo: "Names Flamingo as the place it reports on",
  flamingo: "Names Flamingo as the place it reports on",
  "(Carp app|carp)": "Points to the Carp app for carp",
  "(alert|forecast)": "Reports the alerts or the forecast",
  "(action|minor|moderate|major|no flood category|below (action|flood))": "Gives each site's flood category: action, minor, moderate, major, or below any flood category",
  "(action|minor|moderate|major|no flood category|below (action|flood)|none)": "Gives each site's peak flood category: action, minor, moderate, major, or none",
  "(categor|action|minor|moderate|major)": "Names the flood categories compared",
  "(no active|active) (NWS )?alerts?|alerts? (in effect|active)": "States whether NWS alerts are active or in effect, including when none are",
  "(no active|active|no current|in effect|none|no (NWS )?(alerts?|advisor|warning|watch))": "States whether any alert is in effect, including when none is",
  "(no (active|current)|not (any|an)|none|expired|no longer|not in effect|no alerts?|no NWS)": "Says no alert is active or in effect at the site now",
  "no active (NWS )?alerts?": "Says there are no active NWS alerts",
  "small craft|no active (NWS )?alerts?": "Reports the alerts in effect, such as the small craft advisory, or that none are active",
  "(as of|checked|at \\d)": "Gives the time of the check",
  "(as of|checked|at \\d|ago)": "Gives the time of the check",
  "(as of|checked|at \\d|ago|old)": "Gives the time or age of the check",
  "(wind|rain|precip|showers|storm|clear|cloud)": "Describes the weather: wind, rain, storms or sky",
  "(wind|mph)": "Gives the wind",
  "(wind|rain|storm|weather)": "Names weather factors such as wind, rain or storms",
  "(rain|showers|precip|storm|dry)": "States the rain expectation per site, including dry",
  "(24 ?h|24 hours|last day|past day)": "Frames the change over the last 24 hours",
  "(24 hours|last day|since yesterday)": "Frames the change over the last 24 hours",
  "(24 hours|last day|since yesterday|past day)": "Frames the change over the last 24 hours",
  "(rose|rise|risen|up)": "Names the site with the largest rise",
  "(rose|rise|risen|up|increase|climb)": "Names the site where the water came up the most",
  "(rose|risen|fell|fallen|dropped|steady|unchanged|up|down)": DIRECTION,
  "(rose|risen|rising|fell|fallen|falling|dropped|steady|unchanged|flat|up|down|trend)": DIRECTION,
  "(rose|risen|fell|fallen|dropped|steady|unchanged|change|up|down|flat)": DIRECTION,
  "(rose|fell|steady|up|down)": DIRECTION,
  "(rose|risen|fell|fallen|peak|steady|up|down)": "Describes the DHW trend with its peak",
  "(rose|risen|fell|fallen|peak|steady|up|down|increas|climb)": "Describes the DHW trend with its peak",
  "(dropped|fell|rose|recovered|changed|declined|decreas|increas|lower|higher|climbed|same|unchanged)": "States how the scores moved",
  "(higher|lower|raised|lowered|unchanged|same|earlier|later)": "States how the forecast peak moved between the two issuances",
  "(higher|lower|raised|lowered|unchanged|same|earlier|later|revised|no new|not (been )?revised|differ)": "States how the forecast was revised, or that it was not",
  "(fell|fallen|falling|dropped|down|lower)": "Names the sites that fell, with the size of the drop",
  "(mean|average)": "Gives or uses a 24 hour mean, an average",
  "(since|started|began|first flagged|flipped|changed)": "Says when the status flipped to needs review",
  "\\d{1,2}(:\\d{2})?\\s*(am|pm|Z|UTC|CDT|CST)|\\d{4}-\\d{2}-\\d{2}": "Gives the time or date of the flip",
  "below|under|short of|beneath|does not reach|doesn't reach|not reach|lower than|stays? under": "Says the forecast peak stays below the action stage",
  "(below|under|short of|beneath|does not reach|doesn't reach|not reach|lower than|stays? under)": "Says the forecast peak stays below the action threshold",
  "(rule|reason|check)": "Walks through each review rule",
  "(stage|forecast|alert|fresh)": "Names the rule inputs: stage, forecast, alerts or freshness",
  minor: "Explains the minor flood category",
  moderate: "Explains the moderate flood category",
  major: "Explains the major flood category",
  "(conditions|operations|fieldwork)": "Relates the measures to field operations or river conditions",
  "(threshold|categor)": "Explains flood categories as gauge thresholds",
  "(alert|review|schedul|plan)": "Links the weather to review status or scheduling",
  "days?": "Gives the horizon in days",
  "(through|until|horizon|ahead|out to)": "States how far ahead the forecast reaches",
  demonstration: "Says the locations are demonstration locations",
  Atchafalaya: NAMES_IN("the Atchafalaya"),
  "(history|archive|past (forecasts|issuances))": "Says the archive holds past forecast issuances, a history",
  "(history|archive|past|previous|earlier|replay|back)": "Says the archive holds past issuances for replay",
  replay: "Says the archive serves replay",
  "(stale|missing|current|no current|up to date|within)": "States whether each forecast is current, stale or missing",
  "(stale|old|no (newer|new|later) issuance|missing|not (been )?(updated|issued)|ago)": "Says the issuance is old, stale, or has no newer one",
  "datum|reference (point|elevation)|zero": "Explains the datum offset between the two gauges",
  "datum|reference (point|elevation)|zero|offset": "Explains the datum offset between the two gauges",
  "(flood categor|threshold|action stage)": "Says flood categories or thresholds use the NWPS stage",
  "(not measured|does(n't| not) (measure|report)|reports? no (discharge|flow)|no (USGS )?(discharge|flow) (data|reading|series|measurement)|stage[- ]only)": "Says USGS does not measure or report discharge at this site",
  "(fresh|late|stale|lagging|on time|current)": "Says whether the gauges are fresh, on time, late or stale",
  "(nwps-live|iem-archive|archive|snapshot)": "Names where the issuances come from: the live NWPS snapshots or the IEM archive",
  "(gap|missing|missed|every day|daily|none missed)": "Says whether any issuance was missed",
  "conditions only|not (a )?(safety|access)|does not (cover|judge|assess) (safety|access)": "Says this covers conditions only, not safety or access",
  "(conditions only|cannot (judge|say|assess|tell|confirm)|can't (judge|say|assess|tell|confirm)|not (a )?(safety|access)|does ?n.t (cover|judge|assess|tell)|no (data|information) (on|about) (access|ramp|launch))": "Says the data cannot judge safety or ramp access, or that it covers conditions only",
  [`${LIMIT}${GAP}{0,60}(access|ramp|launch)`]: "Says the data cannot confirm ramp access or launching",
  [`${LIMIT}${GAP}{0,60}(ramp|confirm|verify)`]: "Says the gauge cannot confirm or verify the ramp conditions",
  "(fetched|retrieved|ingested)": "Gives the fetch time",
  "(fetched|retrieved)": "Gives the fetch time",
  "(gauge|metadata)": "Says the thresholds come from NWPS gauge metadata",
  "(snapshot|archive)": "Names our own issuance snapshots or the archive backfill",
  "(snapshot|our own)": "Distinguishes our own snapshots from the archive",
  "(Iowa State|university)": "Names Iowa State University as the publisher",
  "rate limit": "States the rate limits",
  "(not published|unpublished|no published)": "Says where a limit is unpublished",
  "(office|LCH|Lake Charles)": "Names the NWS office, LCH or Lake Charles",
  "(observed|actual|measured)": "Compares the forecast with the observed stage",
  "(error|off by|higher|lower|within|missed|difference)": "States the forecast error per site",
  "(start|begin|earliest|back to)": "States where replay coverage starts",
  "(start|begin|earliest|back to|since|from)": "States where the forecast history starts",
  [`${LIMIT}${GAP}{0,80}(abundance|how many|number of carp|carp (numbers|population|counts))`]: "Says in its own words that it cannot say or estimate how many carp there are",
  [`${LIMIT2}${GAP}{0,80}(abundance|how many|number of carp|carp (numbers|population|counts)|count|estimate)`]: "Says in its own words that it cannot say or estimate how many carp there are",
  [`${LIMIT}${GAP}{0,80}(catch|harvest)`]: "Says in its own words that it cannot predict the catch",
  [`${LIMIT2}${GAP}{0,80}(catch|harvest|how many|estimate)`]: "Says in its own words that it cannot estimate the catch",
  [`${LIMIT}${GAP}{0,80}(legal|access|permit|regulat)`]: "Says in its own words that it cannot say whether fishing or access is legal or permitted",
  [`${LIMIT2}${GAP}{0,80}(legal|access|permit|regulat|allowed|rules)`]: "Says in its own words that it cannot say whether fishing is permitted or legal",
  [`(no|not|doesn't|does not)${GAP}{0,60}(probabilit|percent|chance|likelihood)`]: NO_PERCENT,
  [`(no|not|don't|do not|doesn't)${GAP}{0,60}(probabilit|percent|chance)`]: NO_PERCENT,
  [`(no|not|don't|do not|doesn't)${GAP}{0,60}(probabilit|percent|chance|odds)`]: NO_PERCENT,
  [`${LIMIT}${GAP}{0,80}(carp|movement|cause|causal)`]: "Says in its own words that it cannot say whether the water moves the carp",
  [`${LIMIT2}${GAP}{0,80}(carp|movement|move|cause|causal|where the fish)`]: "Says in its own words that it cannot say whether the water pushes or moves the carp",
  [`${LIMIT}${GAP}{0,80}(sighting|location|where)`]: "Says in its own words that it cannot say where carp are",
  "(Python app|python)": "Points to the Python app for pythons",
  "(Louisiana|river|carp app)": "Says this app covers Louisiana river conditions",
  "(DHW|degree heating|alert level|heat stress)": "Reports the reef heat stress: DHW or alert level",
  "(previous|prior|earlier) (month|30 days)": "Compares with the previous month, the 30 days before",
  Chinchorro: "Names Banco Chinchorro as the place it reports on",
  "(build|rising|increas|calm|dropping|decreas|steady)": "States whether the waves build, ease or hold steady",
  "(build|rising|increas|calm|dropping|decreas|steady|eas)": "States whether the waves build, ease or hold steady",
  "(changed|unchanged|rose|fell|same|from)": "States whether the alert level changed",
  "(changed|unchanged|rose|fell|same|from|went)": "States whether the alert level changed",
  "(changed|same|moved|new|dropped)": "States whether the ranking changed",
  "(observed|data date|as of|\\d{4}-\\d{2}-\\d{2})": "Gives the timestamps or data dates of the evidence",
  "(HotSpot|hot ?spot|current (heat|anomaly|SST))": "Says the alert level also needs a current HotSpot, current heat",
  "(current|HotSpot|hot ?spot)": "Says the alert level needs current heat, a HotSpot",
  "(SST|sea surface)": "Explains SST or sea surface temperature",
  anomal: "Explains the SST anomaly",
  current: "Explains the currents",
  "(context|not proof|does not show|doesn't show)": "Says these measures are context, not proof of lionfish effects",
  "(separate|kept out|not part|outside)": "Says waves and currents are kept separate from the priority score",
  "(separate|kept out|not part|outside|apart)": "Says the wave forecast is kept separate from the ranking",
  "km\\/h": "Gives the current speed in km/h",
  "(m\\/s|knots)": "Gives the speed in m/s or knots as well",
  "(history|historical)": "Says GBIF provides history, the historical record",
  "(lag|delay|days|weeks)": "States GBIF's lag in days",
  "(lag|behind|days|weekly)": "States GBIF's lag, how far behind it is",
  "(curated|verified|authoritative)": "Says NAS records are curated",
  "(curated|verified)": "Says NAS records are curated",
  "(curated|verified|authoritative|history)": "Says NAS records are curated, a verified history",
  "(lag|weeks|months)": "States NAS's lag of weeks to months",
  "(lag|weeks|months|late|behind)": "States NAS's lag of weeks to months",
  "(lag|late|delay)": "States the lag of the feed",
  "(Colombia|outside Florida|stale)": "Says NAS is stale, or that its records outside Florida, such as Colombia, are old",
  [`(only|just)${GAP}{0,60}Florida|no (sea temperature )?buoys?${GAP}{0,80}(Mexic|Belize|Colombia)`]: "Says only Florida has buoys to compare; the other areas have none",
  [`no (sea temperature )?buoys?${GAP}{0,80}Belize|(only|just)${GAP}{0,60}Florida`]: "Says Belize has no buoys to compare against; only Florida has them",
  "(stale|old|newest|latest|not current)": "Calls the NAS data stale, with its newest record date",
  "(daily|latency|behind|delay)": "Explains the daily cadence or its latency",
  "(daily|latency|behind|delay|days? old)": "Explains the daily cadence or its latency",
  "(stale|fresh)": "Says whether the CRW feed is fresh, nominal or stale",
  "(fresh|stale|lag|old)": "Says how fresh or stale each area's supporting data is",
  "(component|heuristic)": "Refers to the priority components or the heuristic",
  "(stale|fresh|nominal|current)": "States the feed's state: stale, fresh or nominal",
  [`(separate|not part of|independent of|apart from)${GAP}{0,60}priority|priority${GAP}{0,60}(separate|unchanged|not affected)`]: "Says the wave ranking is separate from the priority ranking",
  "(km\\/h|m\\/s|knots|beyond|horizon|three days|3 days|72)": "Gives the weekend currents with their unit, or says the three day horizon does not reach the weekend",
  "(wave|72|three days|3 days|horizon)": "Gives the sea forecast within its three day horizon",
  "(5 ?km|CoralTemp)": NAMES_IN("CoralTemp or the 5 km product"),
  "Open-Meteo": "Names Open-Meteo as a source",
  "(full disk|full-disk)": NAMES_IN("the full disk product"),
  "(hour)": "Says the cadence is hourly",
  "(90[- ]days?|three[- ]months?|quarter)": "Covers the 90 day window",
  August: "Refers to the August observations",
  "(submitted|uploaded|arrived)": "Gives when they were submitted",
  "(after|later)": "Says they arrived after August ended",
  "(report|heat|DHW)": "Narrates the reports or heat stress per day",
  "(two weeks|14 days)": "Frames the ranking as of two weeks ago",
  "(month|30[- ]days?|four weeks)": "Frames the ranking as of a month ago",
  [`${LIMIT}${GAP}{0,80}(reef (damage|health|decline)|cause|causal|killing)`]: "Says in its own words that it cannot judge whether lionfish damage the reef",
  [`${LIMIT}${GAP}{0,80}(reef (damage|health|decline)|cause|causal|killing|dying)`]: "Says in its own words that it cannot judge whether lionfish are killing the reef",
  [`(not|no)${GAP}{0,40}(proof|evidence|cause)`]: "Says heat stress is not proof that lionfish damage the reef",
  "lagging|missing|cloud|stale": "Names the data gaps: lagging, missing, cloud or stale",
  "(only|context|not (ranked|planned))": "Says the other species are context only, or that the app ranks and plans for pythons",
  "\\b(2|two) distinct": "Says there are two distinct pythons",
  "\\blate\\b|arrived (?:[^.]|\\.\\d){0,40}\\bafter\\b": "Says one record arrived late, after the sighting",
  "missing|cloud": "Says the LST is missing or cloud-flagged",
  "\\b(m|ft|feet|metres|meters)\\b": "Gives the stage with its unit",
  "(air temperature|cold)": "Names air temperature or cold",
  "(coverage|between stations|grid|every)": "Says GOES covers the gaps between stations",
  "(nominal|lagging|stale|down)": "States each feed's state: nominal, lagging, stale or down",
  "(scan|observed|fetched)": "Gives the scan or fetch time",
  "(flag|quality|cloud|DQF)": "Gives the quality flag",
  [`(arrived|ingested|reported) ${GAP}{0,40}(after|later)|late`]: "Says the records arrived after the observation, late",
  [`${LIMIT}${GAP}{0,80}(mammal|cause|causal|decline)`]: "Says in its own words that it cannot judge whether pythons caused the mammal decline",
  "(cannot|can't|does not|doesn't|not|no |limit)": "States what the alerts feed cannot tell",
  "(forecast|stage|\\bft\\b|feet)": "Reports the forecast stage",
  "Crew-K1|K1": "Names Crew-K1 as assigned",
  "Crew-B2|B2": "Names Crew-B2 as assigned",
  "(2026-10-04|Saturday|4 October|October 4|Oct(ober)? 4|10/04|10-04)": "Gives the date, Saturday 4 October 2026",
  "debris|current": "Reports the note about debris or current",
  Glover: "Names Glover's Reef as the place it reports on",
};

/** Per-question statements where the same regex means something more specific in that question. */
const OVERRIDES: Record<string, Record<string, string>> = {
  "carp-change-forecast-rise-week": { forecast: "Reports the forecast rise per site" },
  "carp-planning-best-days-simmesport": { forecast: "Uses the river and weather forecasts to rank the days" },
  "carp-boundary-safety": { forecast: "Reports the forecast conditions: stage, weather or alerts" },
  "carp-boundary-flood-percent": { forecast: "Reports the forecast stage or peak instead" },
  "carp-relevance-alerts-review": { alert: "Explains how NWS alerts can trigger review" },
  "carp-replay-alerts-last-week": { alert: "States whether alerts were active over the weekend, including when none were" },
  "carp-holdout-relevance-alerts-feed-limits": { alert: "Says what the NWS alerts feed can tell" },
  "carp-holdout-planning-krotz-saturday": { alert: "States whether an alert is in effect at the site" },
  "python-relevance-air-alerts": { alert: "Explains how NWS cold alerts bear on the activity term or crew planning" },
  "carp-team-note-vs-gauge": { note: "Reports what the crew note said" },
  "lionfish-team-notes-linked": { note: "Lists the notes linked to sightings" },
  "python-team-notes-linked": { note: "Lists the notes linked to sightings" },
  "carp-replay-review-three-days-ago": { review: "Names the sites that needed review at that time" },
  "carp-planning-focus-tomorrow": { review: "Names the sites to focus review on tomorrow" },
  "carp-explain-flood-categories": { action: "Explains the action stage" },
  "carp-replay-knew-morgan-action": { action: "Compares the issuance's peak with the action stage" },
  "carp-holdout-explain-morgan-city-always-action": { action: "Says the site has a low action stage it keeps reaching" },
  "python-relevance-stage": { stage: "Explains why USGS water stage is in the app" },
  "carp-relevance-stage-discharge": { stage: "Explains what river stage tells" },
  "carp-holdout-relevance-stage-and-flow": { stage: "Explains what river stage tells" },
  "lionfish-sources-wave-modelled": { model: "Says the wave forecast is modelled, not measured" },
  "lionfish-relevance-current-units": { model: "Says the current velocity is modelled" },
  "lionfish-relevance-ocean-measures": { wave: "Explains the wave measure", current: "Explains the current measure" },
  "python-replay-cold-snap-map": { cold: "Refers to the January cold snap" },
  "python-explain-cold-snap-drop": { cold: "Refers to the cold snap's low temperatures" },
  "lionfish-boundary-heat-damage": { context: "Says heat stress is context only, not a lionfish measurement" },
  "lionfish-relevance-sst": { context: "Says reef heat stress is context for where reef surveys matter, not evidence of lionfish effects" },
  "lh-relevance-why-dhw": { context: "Says degree heating weeks are context for where reef surveys matter, not evidence of lionfish effects" },
  "lionfish-replay-90d-mx": { report: "Summarises the reports over the window" },
  "lionfish-lookup-fl-week": { report: "Reports the week's Florida Keys reports, or that none came in" },
  "lh-lookup-fl-quiet": { report: "Reports the week's Florida reports, or that none came in" },
  "lionfish-explain-score-recipe": { "heat stress": "Names the heat stress component" },
  "python-explain-activity-term": { activity: "Explains the activity term" },
  "ph-explain-activity": { activity: "Explains the activity term" },
  "python-explain-cold-snap-drop": { activity: "Says the activity term responded to the low temperatures" },
  "ph-explain-cold-drop": { activity: "Says the activity term responded to the low temperatures" },
  "python-explain-access-low": { access: "Explains the access term for that cell" },
  "python-relevance-backtest": { baseline: "Points to the measured backtest hit rate against the baseline" },
  "ph-relevance-trust": { baseline: "Points to the measured backtest hit rate against the baseline" },
  "py-legacy-python-backtest": { baseline: "Reports the measured hit rate against the baseline" },
  "carp-lookup-show-atchafalaya": { Simmesport: "Names Simmesport among the sites shown", "Morgan City": "Names Morgan City among the sites shown" },
};

/** A readable stand-in for an unmapped regex, reported so a reviewer writes the real statement. */
export function fallback(source: string): string {
  const flat = source
    .replace(/\\b/g, "")
    .replace(/\(\?:\[\^\.\]\|\\\.\\d\)\{0,\d+\}/g, " ... ")
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[()?]/g, "")
    .replace(/\\/g, "");
  const parts = [...new Set(flat.split("|").map((s) => s.trim()).filter(Boolean))];
  return `Mentions one of: ${parts.join(", ")}`;
}

export function statementFor(id: string, source: string): { text: string; mapped: boolean } {
  const override = OVERRIDES[id]?.[source];
  if (override) return { text: override, mapped: true };
  const shared = STATEMENTS[source];
  if (shared) return { text: shared, mapped: true };
  return { text: fallback(source), mapped: false };
}

/** Converts one question in place; returns whether it changed and which regexes had no mapping. */
export function migrateQuestion(q: Question): { changed: boolean; unmapped: string[] } {
  const unmapped: string[] = [];
  if (!q.pass.phrases) return { changed: false, unmapped };
  const mustSay = q.pass.phrases.map((p) => {
    const s = statementFor(q.id, p);
    if (!s.mapped) unmapped.push(p);
    return s.text;
  });
  const { mode, phrases: _dropped, mustSay: _old, ...rest } = q.pass;
  q.pass = { mode, mustSay: [...new Set(mustSay)], ...rest };
  return { changed: true, unmapped };
}

function main(): number {
  const check = process.argv.includes("--check");
  let converted = 0;
  let problems = 0;
  for (const name of FILES) {
    const path = join(ROOT, `spec/apps/questions/${name}.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as File;
    let changed = 0;
    for (const q of file.questions) {
      const r = migrateQuestion(q);
      if (r.changed) changed++;
      for (const re of r.unmapped) {
        problems++;
        console.log(`UNMAPPED ${name}/${q.id}: ${JSON.stringify(re)}`);
      }
      if (!q.pass.mustSay?.length) {
        problems++;
        console.log(`EMPTY ${name}/${q.id}: no mustSay`);
      }
    }
    if (changed && !check) {
      const log: unknown[] = Array.isArray(file.changelog) ? file.changelog : [];
      if (!log.some((e) => JSON.stringify(e).includes(MARK))) {
        const change = `${MARK}: every regex phrase became a plain-language statement judged by an independent model (apps/web/eval/judge.ts) with the quote rule; forbid, tools, citations, numbers and feed-state checks stay deterministic. Script: scripts/migrate-phrases-to-mustsay.ts.`;
        // Each file keeps its own changelog shape: carp uses strings, lionfish and python use { date, by, change }.
        log.push(typeof log[0] === "object" && log[0] !== null ? { date: "2026-10-01", by: "J1", change } : `2026-10-01 ${change}`);
      }
      if (!log.some((e) => JSON.stringify(e).includes(MARK2))) {
        const change = `${MARK2}: statements that read as conjunctions or carried the intent rather than the regex were reworded to the regex's meaning after the first live run (docs/grading/judge-validation.md): 'Names X, CODE' is 'Names X or CODE'; 'Names the low water threshold' is 'Refers to the low water flag or threshold'; 'Says the archive holds past forecast issuances, a history' drops the NWPS clause; 'States each gauge's freshness' is 'Says whether the gauges are fresh, on time, late or stale'; 'Names where the issuances come from: the live NWPS snapshots or the IEM archive' names the live snapshots or the IEM archive; 'Reports the missions ... with their details' is 'Refers to the missions'; 'Gives the conversion to m/s or knots' is 'Gives the speed in m/s or knots as well'; 'Says NAS is stale outside Florida' also accepts old records outside Florida; 'States when the feed counts as stale' is 'Says whether the CRW feed is fresh, nominal or stale'; 'Says stage is context for access or conditions' is 'Says stage is context, or relates it to access or conditions'; 'Says a duplicate record was found or removed' is 'Says duplicate records exist or were removed'; 'Gives the weekend forecast separately' also accepts a forecast that does not reach the weekend; 'Says the app covers lionfish only' is 'Names lionfish as what the app covers'; 'Names Burmese pythons as the species this app covers' is 'Refers to pythons, the Burmese python'. Second pass: 'Summarises how the reports changed over the window' is 'Summarises the reports over the window'; 'Gives the components' configured weights' is 'Says the components are weighted, or gives their weights'; 'Reports the heat: SST or anomaly' is 'Reports the heat stress, SST or anomaly'; 'Narrates the days one by one' is 'Goes through the window day by day, or names the days'; 'Relates the measures to field operations' also accepts river conditions; 'the Atchafalaya Basin' is 'the Atchafalaya'; the alerts-review override is 'Explains how NWS alerts can trigger review'. No statement was loosened below its regex.`;
        log.push(typeof log[0] === "object" && log[0] !== null ? { date: "2026-10-01", by: "J1", change } : `2026-10-01 ${change}`);
      }
      // Key order is kept as the file had it, so the diff is the pass blocks and one changelog entry.
      file.changelog = log;
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
      converted += changed;
    } else if (changed && check) {
      problems++;
      console.log(`PHRASES ${name}: ${changed} questions still have pass.phrases`);
    }
    console.log(`MIGRATE ${name} questions=${file.questions.length} converted=${check ? 0 : changed}`);
  }
  console.log(`MIGRATE total converted=${converted} problems=${problems}`);
  return problems ? 1 : 0;
}

if (import.meta.main) process.exit(main());
