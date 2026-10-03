/**
 * Deterministic scope guidance (P4, C-A5): a question that names another app's focus species, or asks for what no
 * feed can give (a risk percent, a causal claim, a population count, a place outside the regions), is recognised from
 * the configs and given to the model as guidance (`scopeGuidance`); the model still answers, in its own words, with
 * its tools. The patterns are built from the configs: the other apps' taxa names, aliases and ids, minus anything this
 * app itself covers. Everything subtler (abundance, catch, access, safety,
 * places outside the region) is the model's job under the prompt's boundary rules and the tools' region checks.
 */

import { APP_IDS, loadApps, type AppConfig } from "@/shared/apps";

/** "select the carp", "switch to lionfish", "go to the python app": a request to move to another of the three apps. */
const SWITCH_REQUEST = /\b(switch|change|go|select|pick|choose|open|take me|move|jump)\b[^.?!]{0,40}\b(carp|lionfish|python|pythons|burmese|asian carp|app|species)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cache = new WeakMap<AppConfig, RegExp | null>();

/** Names of species that belong to other apps only. */
export function foreignSpeciesPattern(app: AppConfig): RegExp | null {
  const cached = cache.get(app);
  if (cached !== undefined) return cached;
  const own = new Set(app.taxa.flatMap((t) => [t.id, t.name, t.scientificName, ...(t.aliases ?? [])]).map((s) => s.toLowerCase()));
  const apps = loadApps();
  const names = new Set<string>();
  for (const id of APP_IDS) {
    if (id === app.id) continue;
    for (const t of apps[id].taxa) {
      for (const name of [t.id, t.name, t.scientificName, ...(t.aliases ?? [])]) {
        const lower = name.toLowerCase();
        if (!own.has(lower) && lower.length >= 4) names.add(lower);
      }
    }
  }
  const pattern = names.size ? new RegExp(`\\b(${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")})(es|s)?\\b`, "i") : null;
  cache.set(app, pattern);
  return pattern;
}

/**
 * What the model is told about a question the guard recognised, or null when it passes. It steers, it does not answer:
 * the model says plainly what the data cannot show, and then gives the most useful thing it can, cited from its tools.
 */
export function scopeGuidance(app: AppConfig, question: string): string | null {
  const guard = scopeGuard(app, question);
  if (!guard) return null;
  if (guard.includes("switch_app")) return ["Scope guidance for this question, from this app's own rules:", guard].join("\n");
  return [
    "Scope guidance for this question, from this app's own rules:",
    guard,
    "Answer the user yourself, in your own words; do not paste the guidance. Say plainly what this app and its data cannot tell, then give the most useful thing they can: call your tools for the part that is in scope (reports in a window, counts of reports, the survey priority and its separate components, conditions at a configured place) and cite it. If nothing in the question is in scope, say so in a sentence and offer what this app does answer. Never invent numbers or sources.",
  ].join("\n");
}

/** The guard's wording for a question, or null when the question passes the guard. */
export function scopeGuard(app: AppConfig, question: string): string | null {
  // Asking to switch to another species or app is an action the model takes (switch_app), not a question out of scope.
  if (SWITCH_REQUEST.test(question)) return null;
  const pattern = foreignSpeciesPattern(app);
  const hit = pattern?.exec(question);
  if (hit) return `"${hit[0]}" is another species of this product, not this app's. Do not refuse and do not answer it from this app's data: call switch_app for that species, then say in one sentence that you switched and that they can ask about it now.`;
  return topicGuard(app, question);
}

/**
 * Topic guards (P4, by category, not by question): a question that asks for what no tool can give is refused
 * before any model call, with the app's refusal plus one generic sentence per topic. Patterns name the topic
 * (a risk percent, a causal claim, a population count, a place outside the regions), never a documented question.
 */
type Topic = { pattern: RegExp; answer: (app: AppConfig, hit: string) => string };

const OUTSIDE_LIONFISH = /\b(bahamas|puerto rico|honduras|hawaii|jamaica|cuba|cayman|aruba|bonaire|cura[cç]ao|venezuela|panama|costa rica|nicaragua|guatemala|dominican republic|haiti|turks|virgin islands|bermuda|roatan|utila|bay islands|texas|north carolina|carolinas|gulf of mexico|mediterranean|red sea|brazil|trinidad|barbados|grenada|st\.? lucia|martinique|guadeloupe|antigua|dominica|st\.? kitts|anguilla)\b/i;
const OUTSIDE_PYTHON = /\b(orlando|tampa|texas|georgia|jacksonville|tallahassee|gainesville|pensacola|louisiana|alabama|mississippi|carolina|california|arizona|nevada|new york|ohio|hawaii|puerto rico|bahamas|cuba|mexico|belize|colombia)\b/i;

const TOPICS: Partial<Record<AppConfig["id"], Topic[]>> = {
  lionfish: [
    {
      pattern: /invasion[- ]risk|\brisk (percent|percentage|score|number|rating)|percent(age)? (risk|chance)|chance of (an )?invasion/i,
      answer: (app) => `${app.agent.refusal} There is no single invasion-risk percent or risk score in this data, and none is computed. The survey priority is shown as four separate components (recent reports, identification quality, reef heat stress, data completeness), each labelled a heuristic; ask which area to prioritise to see them.`,
    },
    {
      pattern: /heat stress (mean|means|show|shows|prove|proves|imply|implies|indicate|indicates)[^.?]{0,40}lionfish|lionfish[^.?]{0,40}(because of|due to|caused by) (the )?heat/i,
      answer: (app) => `${app.agent.refusal} High heat stress does not show or prove that lionfish are damaging a reef: heat stress (degree heating weeks and the bleaching alert level) is context for where reefs are under pressure, not proof or evidence of lionfish impact, and the two are reported as separate components with no causal link.`,
    },
    {
      pattern: /lionfish (are|is) (killing|destroying|damaging|wrecking|ruining)|lionfish (killing|destroying|damaging) the reef|reef damage (from|by|caused by) lionfish|(dying|declin\w*|damage\w*|bleach\w*|dead)[^.?]{0,30}(because of|due to|caused by|from) (the )?lionfish/i,
      answer: (app) => `${app.agent.refusal} The data cannot say whether lionfish are killing or damaging a reef: it holds reports of where lionfish were seen and NOAA Coral Reef Watch heat stress (context, not proof of anything about lionfish), not reef health or cause. No causal claim can be made from these feeds; the components are shown separately for that reason.`,
    },
    {
      pattern: /how many lionfish (live|are there|exist|are on|inhabit|are living|are in|are at)|lionfish population (size|count|estimate)|number of lionfish (living|on|in|at)|estimate (the )?(lionfish )?population/i,
      answer: (app) => `${app.agent.refusal} Sightings are reports, not abundance: the data cannot say how many lionfish live anywhere. More reports can mean more observers and no reports can mean no sampling, so no population estimate is possible from these feeds; ask for the reports in a window instead.`,
    },
    {
      pattern: OUTSIDE_LIONFISH,
      answer: (app, hit) => `${app.agent.refusal} ${hit} is outside the four areas, so there is nothing to show there. The four areas are the Florida Keys, the Mexican Caribbean, Belize and the Colombian Caribbean.`,
    },
  ],
  python: [
    {
      pattern: /percent chance|probability of|chance of (finding|seeing|catching|encountering)|how likely (is it|am i|are we) to (find|see|catch)|odds of (finding|seeing)|what are the odds/i,
      answer: (app) => `${app.agent.refusal} There is no probability or percent chance of finding a python here: the hotspot score is a heuristic (density × activity × access) that orders cells, not a probability, so no percent is computed. Ask which cells rank highest tonight to see the heuristic and its reasons.`,
    },
    {
      pattern: /how many pythons (live|are there|exist|are in|are living|inhabit)|python population (size|count|estimate)|number of pythons (living|in the)|estimate (the )?(python )?population|total (number of )?pythons/i,
      answer: (app) => `${app.agent.refusal} Sightings are reports, not abundance: the data cannot estimate how many pythons live in the Everglades. More reports can mean more observers and no reports can mean no sampling, so no population count comes out of these feeds; ask for the reports in a window instead.`,
    },
    {
      pattern: /(did|do|have|are) pythons? (cause|caused|causing|drive|driven|drove|responsible for)|pythons? (caused|are causing|drove) (the )?(mammal|prey|wildlife)|mammal decline/i,
      answer: (app) => `${app.agent.refusal} The data cannot say whether the mammal decline (or any other decline) was caused by pythons: it holds python reports, readings, alerts and a hotspot heuristic, not mammal counts or cause. No causal claim can be made from these feeds.`,
    },
    {
      pattern: /\bcarp\b|river conditions|river stage|atchafalaya|baton rouge|morgan city/i,
      answer: (app) => `${app.agent.refusal} River conditions and carp belong to the Carp app (Louisiana rivers); this app covers Burmese pythons in the Everglades and South Florida.`,
    },
    {
      pattern: OUTSIDE_PYTHON,
      answer: (app, hit) => `${app.agent.refusal} ${hit} is outside the region, so there is nothing to show there: this app covers the Everglades, South Florida and the Keys only.`,
    },
  ],
};

function topicGuard(app: AppConfig, question: string): string | null {
  for (const topic of TOPICS[app.id] ?? []) {
    const hit = topic.pattern.exec(question);
    if (hit) return topic.answer(app, hit[0]);
  }
  return null;
}
