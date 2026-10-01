/**
 * Validates the supported chat questions (spec/apps/questions/{carp,lionfish,python}.json)
 * and renders docs/questions.md from them.
 *
 *   bun scripts/check-questions.ts                  schema, ids, counts, categories
 *   bun scripts/check-questions.ts --require <app>  the questions the gates name for that app
 *   bun scripts/check-questions.ts --write          also (re)write docs/questions.md
 *
 * Tool names are checked against the live agent registry (`buildAgentRegistry` in
 * apps/web/server/agent/tools/capabilities.ts, read as source) plus the file's `newTools`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN } from "../apps/web/eval/golden.ts";

const ROOT = join(import.meta.dir, "..");
const APPS = ["carp", "lionfish", "python"] as const;
type AppId = (typeof APPS)[number];
const CATEGORIES = ["lookup", "change", "explain", "relevance", "quality", "planning", "sources", "replay", "boundary", "team"] as const;
type Category = (typeof CATEGORIES)[number];
const MIN_PER_CATEGORY = 6;
const MIN_PER_APP = 48;
const HELPERS = [6, 8] as const;
const MODES = ["answer", "caveat", "refuse"] as const;
/** Evidence kinds a citation can carry (PLAN.md C14 plus the kinds the new tools add). */
const KINDS = ["sighting", "reading", "alert", "fetch", "hotspot", "backtest", "note", "mission", "message", "forecast", "source"];
/** Categories whose answers must say how fresh each cited feed is, whatever the file sets. */
const FEED_STATE_REQUIRED: Category[] = ["quality", "sources", "replay"];

type NewTool = { name: string; purpose: string; input: string; output: string; evidence: string };
type Pass = {
  mode: (typeof MODES)[number];
  phrases: string[];
  forbid: string[];
  groundedNumbers: boolean;
  feedState: boolean;
  minCitations: number;
  cites?: Record<string, number>;
};
type Question = {
  id: string;
  app: AppId;
  category: Category;
  question: string;
  intent: string;
  expectedTools: string[];
  mustCite: string[];
  view?: { map?: string; timeline?: string };
  pass: Pass;
  helper: boolean;
  context?: Record<string, string>;
  legacyId?: string;
};
type AppFile = {
  app: AppId;
  scope: string;
  feeds: string[];
  newTools: NewTool[];
  toolChanges: { tool: string; change: string }[];
  questions: Question[];
};

const errors: string[] = [];
const fail = (where: string, msg: string) => errors.push(`ERR ${where}: ${msg}`);

// ------------------------------------------------------------- registry

/**
 * Tool names `buildAgentRegistry` can register, resolved from source: the identifiers in `allCapabilities`'s
 * list (per-app allowlists pick from it), with `...carpTools` and `...commonTools` expanded from their modules.
 */
function registryTools(): string[] {
  const dir = join(ROOT, "apps/web/server/agent/tools");
  const files = ["capabilities.ts", "carp.ts", "common.ts", "notes.ts", "species.ts", "views.ts", "evidence.ts", "gazetteer.ts", "gql.ts"].map((f) =>
    readFileSync(join(dir, f), "utf8"),
  );
  const layerIds = [...readFileSync(join(ROOT, "apps/web/shared/apps/schema.ts"), "utf8").matchAll(/LAYER_IDS = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!));
  const body = files[0]!.match(/function allCapabilities\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  // Every array literal in the function (the per-kind lists and the returned list), spreads expanded from the
  // exported arrays of the other modules; local list names and the `species` schema argument are not tools.
  const lists = [...body.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
  const local = new Set([...body.matchAll(/const (\w+) =/g)].map((m) => m[1]!));
  const idents = [
    ...new Set(
      lists.flatMap((list) =>
        [...list.matchAll(/(\.\.\.)?(\w+)(?:\([^)]*\))?/g)]
          .map((m) => [m[1] === "...", m[2]!] as const)
          .filter(([, name]) => name !== "species" && !local.has(name))
          .flatMap(([spread, name]) => {
            if (!spread) return [name];
            const arr = files.map((src) => src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))?.[1]).find(Boolean) ?? "";
            return [...arr.matchAll(/\w+/g)].map((m) => m[0]);
          }),
      ),
    ),
  ];
  if (!idents.length) fail("registry", "no tools found in allCapabilities");
  return idents.map((ident) => {
    for (const src of files) {
      const m = src.match(new RegExp(`const ${ident} = (?:\\([^)]*\\) => )?\\(?\\{\\s*name: ([^,\\n]+),`));
      if (!m) continue;
      const expr = m[1]!.trim();
      const lit = expr.match(/^"([^"]+)"$/);
      if (lit) return lit[1]!;
      const layer = expr.match(/^LAYER\.(\w+)$/);
      if (layer && layerIds.includes(layer[1]!)) return layer[1]!;
      const idx = expr.match(/^LAYER_IDS\[(\d+)\]$/);
      if (idx && layerIds[Number(idx[1])]) return layerIds[Number(idx[1])]!;
      fail("registry", `cannot resolve name expression ${expr} for ${ident}`);
      return ident;
    }
    fail("registry", `no definition for registered tool ${ident}`);
    return ident;
  });
}

// ------------------------------------------------------------- validation

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function regexOk(where: string, src: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(src, "i");
  } catch (e) {
    fail(where, `bad regex ${JSON.stringify(src)}: ${(e as Error).message}`);
    return false;
  }
  // A criterion that matches empty or filler text is not a criterion.
  if (re.test("") || re.test("ok") || re.test("I can help with that.")) {
    fail(where, `regex ${JSON.stringify(src)} matches trivial text`);
    return false;
  }
  return true;
}

function load(app: AppId): AppFile {
  const path = join(ROOT, `spec/apps/questions/${app}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as AppFile;
}

function validate(file: AppFile, app: AppId, registry: string[], ids: Set<string>, toolSpecs: Map<string, string>) {
  if (file.app !== app) fail(app, `file app is ${file.app}`);
  if (!isStr(file.scope)) fail(app, "scope missing");
  if (!isStrArr(file.feeds) || !file.feeds.length) fail(app, "feeds missing");
  for (const tool of file.newTools ?? []) {
    const where = `${app}/newTools/${tool.name}`;
    for (const key of ["name", "purpose", "input", "output", "evidence"] as const) if (!isStr(tool[key])) fail(where, `${key} missing`);
    // A newTool that the registry now has is an implemented spec; the spec stays as its contract.
    const spec = JSON.stringify(tool);
    const prior = toolSpecs.get(tool.name);
    if (prior && prior !== spec) fail(where, "differs from the same tool's spec in another app file");
    toolSpecs.set(tool.name, spec);
  }
  for (const change of file.toolChanges ?? []) {
    if (!isStr(change.tool) || !isStr(change.change)) fail(`${app}/toolChanges`, "tool and change required");
  }
  const tools = new Set([...registry, ...(file.newTools ?? []).map((t) => t.name)]);
  const used = new Set<string>();
  const citable = new Set([...file.feeds.map((f) => `feed:${f}`), ...KINDS.map((k) => `kind:${k}`)]);

  for (const q of file.questions) {
    const where = `${app}/${q.id ?? "?"}`;
    if (!isStr(q.id) || !/^[a-z0-9-]+$/.test(q.id)) fail(where, "id must be kebab-case");
    if (ids.has(q.id)) fail(where, "duplicate id");
    ids.add(q.id);
    if (q.app !== app) fail(where, `app is ${q.app}`);
    if (!CATEGORIES.includes(q.category)) fail(where, `unknown category ${q.category}`);
    if (!isStr(q.question)) fail(where, "question missing");
    if (!isStr(q.intent) || q.intent.split(/[.!?](\s|$)/).filter((s) => s.trim()).length !== 1) fail(where, "intent must be one sentence");
    if (typeof q.helper !== "boolean") fail(where, "helper must be boolean");
    if (!isStrArr(q.expectedTools)) fail(where, "expectedTools must be an array of names");
    for (const t of q.expectedTools ?? []) {
      if (!tools.has(t)) fail(where, `tool ${t} is neither registered nor in newTools`);
      used.add(t);
    }
    if (!Array.isArray(q.mustCite) || !q.mustCite.every(isStr)) fail(where, "mustCite must be an array");
    for (const c of q.mustCite ?? []) if (!citable.has(c)) fail(where, `mustCite ${c} is not a feed of this app or an evidence kind`);
    if (q.view !== undefined && !(isStr(q.view.map) || isStr(q.view.timeline))) fail(where, "view needs map or timeline");
    if (q.legacyId !== undefined && !isStr(q.legacyId)) fail(where, "legacyId must be a string");

    const p = q.pass;
    if (!p || typeof p !== "object") {
      fail(where, "pass missing");
      continue;
    }
    if (!MODES.includes(p.mode)) fail(where, `pass.mode ${p.mode}`);
    if (!isStrArr(p.phrases) || !p.phrases.length) fail(where, "pass.phrases needs at least one regex");
    if (!Array.isArray(p.forbid)) fail(where, "pass.forbid must be an array");
    for (const r of [...(p.phrases ?? []), ...(p.forbid ?? [])]) regexOk(where, r);
    if (p.groundedNumbers !== true) fail(where, "pass.groundedNumbers must be true: every number traces to tool output");
    if (typeof p.feedState !== "boolean") fail(where, "pass.feedState must be boolean");
    if (FEED_STATE_REQUIRED.includes(q.category) && !p.feedState) fail(where, `${q.category} answers must disclose feed state`);
    if (!Number.isInteger(p.minCitations) || p.minCitations < 0) fail(where, "pass.minCitations must be a non-negative integer");
    for (const [kind, n] of Object.entries(p.cites ?? {})) {
      if (!KINDS.includes(kind)) fail(where, `pass.cites kind ${kind}`);
      if (!Number.isInteger(n) || n < 1) fail(where, `pass.cites.${kind} must be >= 1`);
    }
    const kindTotal = Object.values(p.cites ?? {}).reduce((a, b) => a + b, 0);
    if (kindTotal > p.minCitations) fail(where, "pass.cites asks for more citations than minCitations");

    if (q.category === "boundary") {
      if (p.mode === "answer") fail(where, "boundary questions must refuse or caveat");
      if (!p.forbid.length) fail(where, "boundary questions must forbid the claim they refuse");
    } else if (p.mode === "refuse") {
      fail(where, "only boundary questions refuse");
    }
    if (p.mode === "refuse" && p.minCitations > 0 && !q.expectedTools.length) fail(where, "a refusal without tools cannot cite");
    if (p.mode !== "refuse") {
      if (!q.expectedTools.length) fail(where, "answers need at least one tool");
      const viewOnly = q.view && q.expectedTools.every((t) => t === "geocode" || t === "set_view");
      if (p.minCitations < 1 && !viewOnly) fail(where, "answers need at least one citation");
      if (!q.mustCite.length && !viewOnly) fail(where, "answers must name the feeds or evidence kinds they cite");
    }
  }

  const counts = new Map<Category, number>();
  for (const q of file.questions) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
  for (const c of CATEGORIES) if ((counts.get(c) ?? 0) < MIN_PER_CATEGORY) fail(app, `category ${c} has ${counts.get(c) ?? 0} < ${MIN_PER_CATEGORY}`);
  if (file.questions.length < MIN_PER_APP) fail(app, `${file.questions.length} questions < ${MIN_PER_APP}`);
  const helpers = file.questions.filter((q) => q.helper).length;
  if (helpers < HELPERS[0] || helpers > HELPERS[1]) fail(app, `${helpers} helper questions, want ${HELPERS[0]}-${HELPERS[1]}`);
  for (const t of file.newTools ?? []) if (!used.has(t.name)) fail(app, `newTools ${t.name} is not used by any question`);
  return CATEGORIES.filter((c) => (counts.get(c) ?? 0) >= MIN_PER_CATEGORY).length;
}

// ------------------------------------------------------------- required questions (G2-G4)

type Req = { label: string; re: RegExp; category?: Category; mode?: Pass["mode"] | "refuse-or-caveat" };

const REQUIRED: Record<AppId, Req[]> = {
  carp: [
    { label: "largest 24 h stage rise", re: /largest.*rise.*(24 hours|24 ?h)/i, category: "change" },
    { label: "compare two locations for tomorrow morning", re: /compare .+ and .+ tomorrow morning/i, category: "planning" },
    { label: "why did this location start needing review", re: /why did this location start needing review/i, category: "explain" },
    { label: "what we knew yesterday afternoon", re: /what we knew yesterday afternoon/i, category: "replay" },
    { label: "stale or missing forecasts", re: /stale or missing forecasts/i, category: "quality" },
    { label: "forecast issued 2 days ago vs what happened", re: /forecast issued (2|two) days ago .*what (actually )?happened/i, category: "replay" },
    { label: "flood category forecast for Atchafalaya sites", re: /flood category forecast .*Atchafalaya/i },
    { label: "USGS vs NWPS stage at Krotz Springs", re: /USGS and NWPS stage differ at Krotz Springs/i, category: "quality" },
    { label: "boundary: carp abundance", re: /how many carp are/i, category: "boundary", mode: "refuse" },
    { label: "boundary: expected catch", re: /catch/i, category: "boundary", mode: "refuse" },
    { label: "boundary: legal access", re: /legal/i, category: "boundary", mode: "refuse" },
    { label: "boundary: trip safety", re: /safe/i, category: "boundary", mode: "refuse-or-caveat" },
  ],
  lionfish: [
    { label: "recent reports near heat-stressed reefs in Belize", re: /recent lionfish reports near .*heat.stress.* Belize/i, category: "lookup" },
    { label: "compare with the previous month", re: /compare (this )?with the previous month/i, category: "change" },
    { label: "why was this area highlighted", re: /why was this area highlighted/i, category: "explain" },
    { label: "newly submitted reports of older sightings", re: /newly submitted reports of older sightings/i, category: "quality" },
    { label: "highlighted areas with the freshest supporting data", re: /highlighted areas have the freshest supporting data/i, category: "quality" },
    { label: "calmer waves over the next three days", re: /waves forecast calmer over the next three days/i, category: "planning" },
    { label: "meaning of SST, anomaly, DHW, alert level, waves, currents", re: /SST.*anomaly.*degree heating weeks.*alert level.*waves.*currents/i, category: "relevance" },
    { label: "why DHW and alert level can disagree", re: /degree heating weeks and the (bleaching )?alert level disagree/i },
    { label: "GBIF records duplicating iNaturalist", re: /GBIF records duplicate iNaturalist/i, category: "quality" },
    { label: "buoys vs satellite SST disagreeing", re: /buoys and satellite SST disagree/i, category: "quality" },
    { label: "boundary: population growth", re: /population growing/i, category: "boundary", mode: "refuse-or-caveat" },
    { label: "boundary: invasion risk percent", re: /invasion risk percent/i, category: "boundary", mode: "refuse" },
    { label: "boundary: causal reef damage", re: /(killing|damaging) the reef/i, category: "boundary", mode: "refuse" },
    { label: "boundary: non-lionfish species", re: /iguana|python|carp|tegu/i, category: "boundary", mode: "refuse" },
    { label: "boundary: area outside the four", re: /Bahamas|Puerto Rico|Honduras|Hawaii/i, category: "boundary", mode: "refuse" },
  ],
  python: [
    { label: "boundary: non-python species", re: /iguana|tegu|lionfish|carp/i, category: "boundary", mode: "refuse" },
    { label: "boundary: area outside the Everglades region", re: /Orlando|Tampa|Texas|Georgia|Jacksonville/i, category: "boundary", mode: "refuse" },
  ],
};

function checkRequired(app: AppId, file: AppFile): { met: number; total: number } {
  const reqs = REQUIRED[app];
  let met = 0;
  for (const r of reqs) {
    const hit = file.questions.find(
      (q) =>
        r.re.test(q.question) &&
        (!r.category || q.category === r.category) &&
        (!r.mode || (r.mode === "refuse-or-caveat" ? q.pass.mode !== "answer" : q.pass.mode === r.mode)),
    );
    if (hit) met++;
    else console.log(`MISSING ${app}: ${r.label}`);
  }
  let total = reqs.length;
  if (app === "python") {
    // Every legacy golden case keeps its question, mapped to py-legacy-<id>.
    for (const g of GOLDEN) {
      total++;
      const q = file.questions.find((x) => x.id === `py-legacy-${g.id}`);
      if (q && q.legacyId === g.id && q.question === g.question) met++;
      else console.log(`MISSING python: legacy ${g.id} (py-legacy-${g.id}, same question text, legacyId set)`);
    }
  }
  return { met, total };
}

// ------------------------------------------------------------- docs/questions.md

function renderDoc(files: AppFile[]): string {
  const out: string[] = [
    "# Supported chat questions",
    "",
    "Generated by `bun scripts/check-questions.ts --write` from `spec/apps/questions/{carp,lionfish,python}.json`. Do not edit by hand; edit the JSON and re-run.",
    "",
    "Each question lists its intent, the agent tools it should call, what it must cite, and the pass criteria the benchmark applies. Phrases are case-insensitive regular expressions the answer must match; forbidden patterns must not appear. Starred questions are UI starter chips.",
    "",
    "| App | Questions | Helpers | New tools |",
    "|---|---|---|---|",
    ...files.map((f) => `| ${f.app} | ${f.questions.length} | ${f.questions.filter((q) => q.helper).length} | ${f.newTools.map((t) => `\`${t.name}\``).join(", ") || "none"} |`),
    "",
  ];
  const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
  for (const f of files) {
    out.push(`## ${f.app}`, "", f.scope, "", `Feeds: ${f.feeds.map((x) => `\`${x}\``).join(", ")}.`, "");
    if (f.newTools.length) {
      out.push("### New tools", "");
      for (const t of f.newTools) {
        out.push(`- **\`${t.name}\`**: ${t.purpose}`, `  - Input: ${t.input}`, `  - Output: ${t.output}`, `  - Evidence: ${t.evidence}`);
      }
      out.push("");
    }
    if (f.toolChanges.length) {
      out.push("### Changes to existing tools", "");
      for (const c of f.toolChanges) out.push(`- **\`${c.tool}\`**: ${c.change}`);
      out.push("");
    }
    for (const cat of CATEGORIES) {
      const qs = f.questions.filter((q) => q.category === cat);
      out.push(`### ${f.app} / ${cat} (${qs.length})`, "");
      for (const q of qs) {
        const p = q.pass;
        out.push(`- **${q.id}**${q.helper ? " ★" : ""}${q.legacyId ? ` (legacy \`${q.legacyId}\`)` : ""}: ${q.question}`);
        out.push(`  - Intent: ${q.intent}`);
        if (q.context) out.push(`  - Context: ${Object.entries(q.context).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        out.push(`  - Tools: ${q.expectedTools.length ? q.expectedTools.map((t) => `\`${t}\``).join(", ") : "none"}. Cites: ${q.mustCite.length ? q.mustCite.map((c) => `\`${c}\``).join(", ") : "nothing"}.`);
        if (q.view) out.push(`  - View: ${[q.view.map && `map: ${q.view.map}`, q.view.timeline && `timeline: ${q.view.timeline}`].filter(Boolean).join("; ")}`);
        const rules = [
          `mode ${p.mode}`,
          `min ${p.minCitations} citation${p.minCitations === 1 ? "" : "s"}${p.cites ? ` (${Object.entries(p.cites).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`,
          "numbers trace to tool output",
          p.feedState ? "discloses feed state" : null,
        ].filter(Boolean);
        out.push(`  - Pass: ${rules.join("; ")}. Must match ${p.phrases.map(code).join(", ")}.${p.forbid.length ? ` Must not match ${p.forbid.map(code).join(", ")}.` : ""}`);
      }
      out.push("");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

// ------------------------------------------------------------- main

const args = process.argv.slice(2);
const requireApp = args.includes("--require") ? (args[args.indexOf("--require") + 1] as AppId) : null;
if (requireApp && !APPS.includes(requireApp)) {
  console.log(`unknown app ${requireApp}`);
  process.exit(2);
}
const registry = registryTools();
const ids = new Set<string>();
const toolSpecs = new Map<string, string>();
const files = APPS.map(load);
const covered = APPS.map((app, i) => validate(files[i]!, app, registry, ids, toolSpecs));
for (const e of errors) console.log(e);

if (args.includes("--write")) writeFileSync(join(ROOT, "docs/questions.md"), renderDoc(files));

const coveredAll = Math.min(...covered);
const ok = errors.length === 0;
console.log(`registry: ${registry.join(", ")}`);
console.log(`newTools: ${[...toolSpecs.keys()].join(", ")}`);
console.log(
  `QUESTIONS ${APPS.map((a, i) => `${a}=${files[i]!.questions.length}`).join(" ")} categories=${coveredAll}/${CATEGORIES.length} ${ok ? "ok" : `FAIL (${errors.length} errors)`}`,
);
if (requireApp) {
  const { met, total } = checkRequired(requireApp, files[APPS.indexOf(requireApp)]!);
  console.log(`REQUIRED ${requireApp} ${met}/${total} ${ok && met === total ? "ok" : "FAIL"}`);
}
process.exit(ok ? 0 : 1);
