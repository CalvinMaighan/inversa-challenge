/**
 * Writes the shared invalid app-config corpus `spec/apps/invalid/*.json` (PLAN.md C-A3): each file is one of the
 * three real configs with exactly one rule broken, named `<field>.<what>.json` (`unknown-field.json` breaks the
 * root). Rust (`app_config_conformance_*` in api/src/app/config.rs) and the web (`app config conformance` in
 * apps/web/tests/shared/apps/schema.test.ts) must both refuse every file; the web test also checks that the
 * first issue is on the named field, so a file that fails for another reason (a config change) is caught.
 *
 * Run after changing a config: `bun scripts/gen-invalid-app-configs.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const SPEC = path.resolve(import.meta.dir, "../spec/apps");
const OUT = path.join(SPEC, "invalid");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
type J = any;
const base = (id: string): J => JSON.parse(readFileSync(path.join(SPEC, `${id}.json`), "utf8"));

const cases: [string, string, (c: J) => void][] = [
  ["unknown-field", "python", (c) => (c.futureField = 1)],
  ["id.unknown-app", "python", (c) => (c.id = "otter")],
  ["tagline.blank", "carp", (c) => (c.tagline = "   ")],
  ["provisional.not-boolean", "carp", (c) => (c.provisional = "yes")],
  ["taxa.listed-for-conditions-app", "carp", (c) => (c.taxa = base("python").taxa)],
  ["locations.empty-for-conditions", "carp", (c) => (c.locations = [])],
  ["locations.lat-out-of-range", "carp", (c) => (c.locations[0].lat = 91)],
  ["taxa.empty-for-species", "lionfish", (c) => (c.taxa = [])],
  ["taxa.scientific-instead-of-scientificName", "python", (c) => {
    c.taxa[0].scientific = c.taxa[0].scientificName;
    delete c.taxa[0].scientificName;
  }],
  ["taxa.category-unknown", "python", (c) => (c.taxa[0].category = "dragons")],
  ["taxa.short-blank", "python", (c) => (c.taxa[1].short = " ")],
  ["taxa.aliases-blank", "python", (c) => (c.taxa[0].aliases = ["burmese python", ""])],
  ["taxa.iconicGroup-null", "python", (c) => (c.taxa[0].iconicGroup = null)],
  ["taxa.inatTaxonId-zero", "python", (c) => (c.taxa[0].inatTaxonId = 0)],
  ["taxa.rules-unknown", "python", (c) => (c.taxa[0].rules = "dragon")],
  ["taxa.id-duplicate", "python", (c) => (c.taxa[1].id = "python")],
  ["taxa.color-not-hex", "lionfish", (c) => (c.taxa[0].color = "purple")],
  ["regions.empty", "python", (c) => (c.regions = [])],
  ["regions.bbox-object", "python", (c) => {
    const [west, south, east, north] = c.regions[0].bbox;
    c.regions[0].bbox = { west, south, east, north };
  }],
  ["regions.bbox-swapped", "python", (c) => {
    const b = c.regions[0].bbox;
    c.regions[0].bbox = [b[2], b[1], b[0], b[3]];
  }],
  ["regions.bbox-not-multiple-of-10-cells", "python", (c) => (c.regions[0].bbox[2] = Math.round((c.regions[0].bbox[2] - 0.05) * 100) / 100)],
  ["regions.overlap", "lionfish", (c) => (c.regions[1].bbox = [-82.0, 25.0, -80.0, 27.0])],
  ["regions.camera-altitudeM", "lionfish", (c) => {
    c.regions[0].camera.altitudeM = c.regions[0].camera.heightM;
    delete c.regions[0].camera.heightM;
  }],
  ["regions.camera-missing", "carp", (c) => delete c.regions[0].camera],
  ["feeds.source-unknown", "python", (c) => (c.feeds.find((f: J) => f.source === "goes19").source = "goes")],
  ["feeds.mode-mismatch", "python", (c) => (c.feeds.find((f: J) => f.source === "goes19").mode = "poll")],
  ["feeds.name-null", "carp", (c) => (c.feeds[1].name = null)],
  ["score.components-empty", "carp", (c) => (c.score.components = [])],
  ["windows.default-options-spelling", "carp", (c) => (c.windows = { default: 72, options: [24, 72, 168] })],
  ["windows.defaultHours-not-an-option", "carp", (c) => (c.windows.defaultHours = 48)],
  ["windows.optionsHours-zero", "carp", (c) => (c.windows.optionsHours = [0, 72])],
  ["layers.bare-ids", "python", (c) => (c.layers = c.layers.map((l: J) => l.id))],
  ["layers.id-not-kebab-case", "python", (c) => (c.layers[0].id = "Sightings")],
  ["legend.names-no-layer", "carp", (c) => (c.legend.radar = "Radar")],
  ["legend.title-object", "python", (c) => (c.legend = { title: { text: "Invasive animals" } })],
  ["copy.about-missing", "lionfish", (c) => delete c.copy.about],
  ["copy.timezone-not-iana", "carp", (c) => (c.copy.timezone = "Louisiana/Baton_Rouge")],
  ["copy.timezone-missing", "python", (c) => delete c.copy.timezone],
  ["copy.value-not-string", "carp", (c) => (c.copy.shortTitle = 3)],
  ["helperQuestions.empty", "lionfish", (c) => (c.helperQuestions = [])],
  ["helperQuestions.more-than-8", "python", (c) => (c.helperQuestions = Array.from({ length: 9 }, (_, i) => `Question ${i + 1}?`))],
  ["agent.missing", "python", (c) => delete c.agent],
  ["agent.scopeText-spelling", "python", (c) => {
    c.agent.scopeText = c.agent.scope;
    delete c.agent.scope;
  }],
  ["agent.tools-empty", "carp", (c) => (c.agent.tools = [])],
  ["agent.tools-duplicate", "carp", (c) => c.agent.tools.push(c.agent.tools[0])],
  ["agent.refusal-blank", "lionfish", (c) => (c.agent.refusal = "")],
  ["eval.string", "python", (c) => (c.eval = "python")],
];

for (const [name, from, mutate] of cases) {
  const c = base(from);
  mutate(c);
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(c, null, 2) + "\n");
}
console.log(`${cases.length} files`);
