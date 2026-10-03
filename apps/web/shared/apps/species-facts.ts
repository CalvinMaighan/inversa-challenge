/**
 * General knowledge about each app's species, for the questions a hunter, a diver or a field crew asks that no feed answers:
 * what it looks like, what it eats, where it lives, how it is removed, what the rules and the risks are. This is reference
 * material, not the app's data: the agent says so, and points at the public sources below rather than at a record. Rules
 * change and differ by place, so every "rules" fact says to check the current ones with the agency that sets them.
 */
import type { AppId } from "./schema";

export const FACT_TOPICS = ["look", "identify", "size", "diet", "habitat", "life", "impact", "hunting", "rules", "safety", "eating", "report"] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export type Fact = { topic: FactTopic; title: string; text: string };
export type SpeciesFacts = { id: string; name: string; scientificName: string; facts: readonly Fact[] };
export type FactSource = { label: string; url: string };

/** What each topic answers, in the words people ask it. */
export const TOPIC_WORDS: Record<FactTopic, string> = {
  look: "what it looks like",
  identify: "how to tell it from look-alikes",
  size: "how big it gets",
  diet: "what it eats",
  habitat: "where it lives and when it is active",
  life: "how it breeds and grows",
  impact: "why it is a problem",
  hunting: "how it is hunted or removed",
  rules: "the rules for taking it",
  safety: "risks and safe handling",
  eating: "whether and how it is eaten",
  report: "how to report one",
};

export const SOURCES: Record<string, FactSource> = {
  nas: { label: "USGS Nonindigenous Aquatic Species (NAS)", url: "https://nas.er.usgs.gov/" },
  fwc: { label: "Florida Fish and Wildlife Conservation Commission (nonnative species)", url: "https://myfwc.com/wildlifehabitats/nonnatives/" },
  nps: { label: "Everglades National Park: Burmese pythons", url: "https://www.nps.gov/ever/learn/nature/burmesepython.htm" },
  noaa: { label: "NOAA Ocean Service: lionfish", url: "https://oceanservice.noaa.gov/facts/lionfish.html" },
  reef: { label: "REEF: lionfish", url: "https://www.reef.org/lionfish" },
  carp: { label: "Invasive Carp (Asian carp regional coordinating committee)", url: "https://invasivecarp.us/" },
  ldwf: { label: "Louisiana Department of Wildlife and Fisheries", url: "https://www.wlf.louisiana.gov/" },
};

const PYTHON: SpeciesFacts = {
  id: "burmese-python",
  name: "Burmese python",
  scientificName: "Python bivittatus",
  facts: [
    { topic: "look", title: "What it looks like", text: "A large, heavy-bodied constrictor. The back is tan to brown with large, irregular dark blotches that have pale edges, a dark arrow-shaped mark on top of the head and a dark stripe from the eye to the jaw. The belly is pale. It has heat-sensing pits along the upper lip and a forked tongue it flicks to smell." },
    { topic: "size", title: "How big it gets", text: "Most pythons removed in Florida are about 6 to 9 feet, and many are larger; females grow bigger than males. Individuals over 15 feet are taken every year, and a few longer than 18 feet have been reported. A python can weigh well over 100 pounds." },
    { topic: "identify", title: "Telling it from native snakes", text: "The blotched pattern and the arrowhead on the head set it apart. The protected eastern indigo snake is uniformly glossy blue-black, and native water snakes and rat snakes are much smaller. Never kill a snake you have not identified: the eastern indigo snake is a protected native species." },
    { topic: "diet", title: "What it eats", text: "An ambush predator that swallows prey whole. In the Everglades it eats mammals (rabbits, raccoons, opossums, rodents, deer), birds including wading birds, and reptiles including alligators. A large meal can keep it from eating for weeks." },
    { topic: "habitat", title: "Where it lives and when it is active", text: "Wet habitats of south Florida: Everglades marsh and tree islands, canals, levees, swamps and the edges of roads. It swims well. It is most active at dawn, dusk and at night in warm, humid weather, and is often seen basking on levees and roads on cool mornings. Hard cold snaps can kill many." },
    { topic: "life", title: "How it breeds", text: "Breeding is in the cooler months, and females lay a clutch of dozens of eggs in spring, guarding and warming them until they hatch. Hatchlings are about 1.5 to 2 feet long." },
    { topic: "impact", title: "Why it is a problem", text: "Pythons are established in the Everglades and have been linked by researchers to steep declines in small and medium mammals there. They compete with and eat native wildlife, and have no natural predators once they are large." },
    { topic: "hunting", title: "How pythons are hunted and removed", text: "People look for them by walking or driving levees and roads at dawn, dusk and night, and by checking canals and edges after warm, humid nights. A python is secured by hand (a trained person grabs behind the head and supports the body), by tongs or a hook, or by a snake bag. Programs such as the FWC Python Action Team and the Python Elimination Program use trained, permitted or contracted removers. Do not try to handle a large python alone." },
    { topic: "rules", title: "The rules for taking one", text: "Burmese pythons are a prohibited, nonnative species in Florida and the state encourages removing them. As a general rule they may be humanely killed on private land with the owner's permission, with no hunting license or permit needed; on public land, rules and permits differ by the managing agency (FWC, the South Florida Water Management District, the National Park Service). Killing must be humane. Rules change, so check the current ones with FWC and the land manager before going out." },
    { topic: "safety", title: "Risks and safe handling", text: "Pythons are not venomous. They bite, and a large one can constrict, so a big snake needs trained people and more than one of them. Keep your distance from one you cannot control, watch where you step at night (alligators and venomous native snakes share the habitat) and wear boots." },
    { topic: "report", title: "How to report one", text: "In Florida, report a sighting to the FWC Exotic Species Hotline at 888-IveGot1 (888-483-4681) or with the IveGot1 app, with a photo and the exact place if you can. A photo on iNaturalist also becomes a record on this map." },
  ],
};

const LIONFISH: SpeciesFacts = {
  id: "lionfish",
  name: "Lionfish",
  scientificName: "Pterois volitans and Pterois miles",
  facts: [
    { topic: "look", title: "What it looks like", text: "Red lionfish and common lionfish look nearly alike: reddish-brown to maroon bodies with white vertical bands, wide fan-like pectoral fins, long separate dorsal spines and feathery tentacles above the eyes. It hovers head-down near cover and does not flee from divers." },
    { topic: "size", title: "How big it gets", text: "Most seen are 6 to 12 inches. They can reach about 15 inches (38 cm) and a few pounds in the Atlantic." },
    { topic: "identify", title: "Telling it from look-alikes", text: "Few fish look like it. The long, banded dorsal spines and the fanned pectoral fins are the tell. Native scorpionfish are mottled and stout, without the banded fans. Both lionfish species in the Atlantic are invasive, and the two cannot be told apart in the water." },
    { topic: "diet", title: "What it eats", text: "An ambush predator on small fish (juvenile snapper, grouper, wrasses, gobies and damselfish) and crustaceans such as shrimp and small crabs. It swallows prey whole, and its stomach can stretch to many times its normal size, so it can eat prey up to about half its own length." },
    { topic: "habitat", title: "Where it lives", text: "Coral and rocky reefs, ledges and caves, mangroves, seagrass, piers and wrecks, from shallow water to deep reefs. It is native to the Indo-Pacific and became established along the US Southeast coast, the Gulf of Mexico and the Caribbean from the 1980s onward. Cold water slows it, and it is rarely found north of the Carolinas in winter." },
    { topic: "life", title: "How it breeds", text: "It matures within about a year, and females release batches of thousands of eggs every few days, which is commonly cited as around two million eggs a year. The larvae drift in the current for weeks, which is how it spreads between reefs." },
    { topic: "impact", title: "Why it is a problem", text: "In the Atlantic it has no natural predators of note, and it eats the young of native reef fish, including species that are fished and species that keep algae off the reef. Studies on small reefs have found large drops in young native fish where lionfish settle." },
    { topic: "hunting", title: "How lionfish are hunted and removed", text: "Divers remove them with a pole spear or a Hawaiian sling and carry them in a puncture-resistant container (a containment unit) so the spines do not hurt. They are a slow, unafraid target. Hand nets are used too, and organised derbies (for example by REEF) reward the most removed. Culling at depth needs dive training; do not dive beyond your certification." },
    { topic: "rules", title: "The rules for taking one", text: "Florida encourages removal: there is no bag limit, and special rules make spearing and netting lionfish easier than for native fish. In protected areas, national parks and marine sanctuaries spearing is usually restricted and lionfish removal needs the manager's permission or a permit. Belize, Mexico and Colombia set their own rules. Rules change, so check the agency for the place you will dive before you go." },
    { topic: "safety", title: "Risks and safe handling", text: "Thirteen dorsal, two pelvic and three anal spines are venomous, and they stay venomous after the fish is dead. A sting is very painful and rarely deadly. The usual first aid is to immerse the area in water as hot as can be tolerated without scalding for 30 to 90 minutes and see a doctor, especially for swelling, weakness or a sting near the chest. Trim the spines with kitchen shears (wear heavy gloves) before cleaning the fish." },
    { topic: "eating", title: "Is it good to eat?", text: "Yes. The flesh is not poisonous (only the spines carry venom). It is a mild white fish, often served as ceviche, fried or grilled. In some Caribbean waters large reef fish carry ciguatera, so follow local advice there." },
    { topic: "report", title: "How to report one", text: "Report a lionfish to REEF's exotic species sighting program or to the wildlife agency of the country or state, with the date, place and depth. A photo on iNaturalist also becomes a record on this map." },
  ],
};

const SILVER: SpeciesFacts = {
  id: "silver",
  name: "Silver carp",
  scientificName: "Hypophthalmichthys molitrix",
  facts: [
    { topic: "look", title: "What it looks like", text: "A deep, silvery fish with very small scales, a large head with eyes set low and forward, and a big upturned mouth with no teeth. The belly keel is scaleless and runs from the throat to the anus." },
    { topic: "size", title: "How big it gets", text: "Commonly 15 to 40 pounds in US rivers, with larger ones to about 60 pounds and 3 feet or more in length." },
    { topic: "diet", title: "What it eats", text: "A filter feeder: it strains plankton (mostly algae and some small animals) from the water with fine gill rakers, so it competes with native filter feeders and young fish." },
    { topic: "habitat", title: "Where it lives", text: "Large rivers and their backwaters and floodplain lakes. It stays in the upper water and in slow water out of the main current. It spawns when rivers rise and warm in late spring and summer." },
    { topic: "identify", title: "The leaping carp", text: "Silver carp are the ones that leap, often several feet out of the water, when a boat motor passes. Wear eye protection and keep your head clear on a boat in carp water, because a leaping fish can injure a person." },
  ],
};

const BIGHEAD: SpeciesFacts = {
  id: "bighead",
  name: "Bighead carp",
  scientificName: "Hypophthalmichthys nobilis",
  facts: [
    { topic: "look", title: "What it looks like", text: "Silver to dark grey on the back with irregular dark blotches, a very large head with eyes set low, and a big toothless mouth. The scales are small. The keel on the belly is scaleless and runs only from the pelvic fins to the anus, unlike the silver carp's longer keel." },
    { topic: "size", title: "How big it gets", text: "Typically 20 to 60 pounds, and the biggest reach about 5 feet and over 100 pounds." },
    { topic: "diet", title: "What it eats", text: "A filter feeder that takes zooplankton and other plankton from the water, so it competes with paddlefish, bigmouth buffalo and young native fish for food." },
    { topic: "habitat", title: "Where it lives", text: "Large rivers, backwaters and reservoirs, usually in the middle of the water. It does not leap as readily as silver carp." },
  ],
};

const GRASS: SpeciesFacts = {
  id: "grass",
  name: "Grass carp",
  scientificName: "Ctenopharyngodon idella",
  facts: [
    { topic: "look", title: "What it looks like", text: "An elongated, torpedo-shaped fish, olive-brown on the back and lighter below, with large scales that have dark edges and a broad head with the mouth at the front. It has no keel." },
    { topic: "size", title: "How big it gets", text: "Often 20 to 40 pounds, with the largest near 100 pounds." },
    { topic: "diet", title: "What it eats", text: "Plants. It eats submerged water plants in large amounts, a large share of its own weight in a day, and strips weedy waters bare. Some sterile grass carp are stocked on purpose to control weeds; wild fertile fish are the concern." },
    { topic: "habitat", title: "Where it lives", text: "Slow rivers, backwaters, lakes, ponds and flooded vegetation, near the plants it eats." },
  ],
};

const BLACK: SpeciesFacts = {
  id: "black",
  name: "Black carp",
  scientificName: "Mylopharyngodon piceus",
  facts: [
    { topic: "look", title: "What it looks like", text: "Dark grey to black, with a long, rounded body, a smooth pointed head and large scales. It looks like a darker, heavier grass carp." },
    { topic: "size", title: "How big it gets", text: "Commonly 20 to 60 pounds, with the largest well over that and about 4 to 5 feet long." },
    { topic: "diet", title: "What it eats", text: "Mollusks. Strong teeth in its throat crush snails and mussels, so it threatens native mussels and snails, many of them already at risk." },
    { topic: "habitat", title: "Where it lives", text: "Large rivers, lakes and backwaters, usually near the bottom. It is the rarest of the four in the wild and the one most often reported in the lower Mississippi basin by fishers." },
  ],
};

const CARP_SHARED: SpeciesFacts = {
  id: "asian-carp",
  name: "Asian carp (all four)",
  scientificName: "silver, bighead, grass and black carp",
  facts: [
    { topic: "identify", title: "Telling the four apart", text: "Silver and bighead carp both have small scales, a big head with eyes set low and a toothless upturned mouth. Silver carp are silvery all over and the scaleless keel on the belly runs from the throat to the anus; bighead carp are darker grey with blotches, have a bigger head and the keel runs only from the pelvic fins to the anus. Grass carp are long and torpedo-shaped with large dark-edged scales and a normal, forward mouth; black carp are dark grey to black with a smooth pointed head. Silver carp are the ones that leap when a boat passes." },
    { topic: "impact", title: "Why they are a problem", text: "Silver and bighead carp eat the plankton that native young fish and filter feeders depend on, grass carp strip plants and black carp eat mussels and snails. They reproduce in rivers, spread up the Mississippi and its tributaries and are held back from the Great Lakes by barriers and monitoring." },
    { topic: "hunting", title: "How they are harvested", text: "Bowfishing at night or in shallows, commercial netting and gill nets, cast nets and hook and line for smaller ones. Silver carp near a boat are often caught by hand net or bow as they leap. Commercial harvest and markets exist along the Mississippi and the Illinois River." },
    { topic: "rules", title: "The rules for taking them", text: "Rules are set by each state. Many states, Louisiana among them, restrict or forbid keeping or moving live silver and bighead carp, and encourage removal by anglers and bowfishers, often with no bag limit. A fish taken dead by bow or net is usually fine to keep, but confirm the current rule, the season and the licence with the state wildlife agency (in Louisiana, LDWF) before going out." },
    { topic: "safety", title: "Risks and safe handling", text: "Leaping silver carp can hit people on boats: wear eye protection and keep your head low. The fish are heavy and slippery, and a bow or knife needs care in a moving boat." },
    { topic: "eating", title: "Are they good to eat?", text: "Yes. Silver and bighead carp are edible, mild white fish with many small bones, which is why they are often ground into patties or fish cakes; they are sold in the US under names such as Copi." },
    { topic: "report", title: "How to report one", text: "Report an unusual catch to the state wildlife agency (in Louisiana, LDWF) with a photo, the date and the place. A photo on iNaturalist becomes a record on this map." },
  ],
};

export const SPECIES_FACTS: Record<AppId, { sources: readonly string[]; species: readonly SpeciesFacts[] }> = {
  carp: { sources: ["nas", "carp", "ldwf"], species: [CARP_SHARED, SILVER, BIGHEAD, GRASS, BLACK] },
  lionfish: { sources: ["noaa", "reef", "nas"], species: [LIONFISH] },
  python: { sources: ["fwc", "nps", "nas"], species: [PYTHON] },
};

/** The species an app answers for, optionally one by name or id ("silver", "grass carp"), with the facts of a topic when asked. */
export function speciesFactsFor(app: AppId, opts: { species?: string; topic?: FactTopic } = {}): { species: SpeciesFacts[]; sources: FactSource[] } {
  const entry = SPECIES_FACTS[app];
  const want = opts.species?.trim().toLowerCase();
  const match = (s: SpeciesFacts) => !want || s.id === want || s.name.toLowerCase().includes(want) || want.includes(s.id) || (s.id === "asian-carp" && /\b(all|asian|carp)\b/.test(want));
  let species = entry.species.filter(match);
  // A name that matches no species of the app is not a reason to answer with nothing: give them all.
  if (species.length === 0) species = [...entry.species];
  // Facts that hold for all four carp (comparing them, how they are caught, the rules) come with any one of them when a topic is asked.
  const shared = entry.species.find((s) => s.id === "asian-carp");
  if (shared && opts.topic && !species.includes(shared)) species = [shared, ...species];
  const shaped = species.map((s) => ({ ...s, facts: opts.topic ? s.facts.filter((f) => f.topic === opts.topic) : s.facts })).filter((s) => s.facts.length > 0);
  return { species: shaped, sources: entry.sources.map((id) => SOURCES[id]!) };
}
