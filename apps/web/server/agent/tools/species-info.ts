/**
 * General knowledge about the app's species (`species_info`): what it looks like, eats, how it is hunted, the rules and the
 * risks, from `shared/apps/species-facts.ts`. Reference material, not the app's data: no feed, no record and no citation id
 * stand behind it, so the answer names the public sources instead and says it is general information.
 */
import { z } from "zod";

import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { output } from "@/server/agent/tools/shared";
import { FACT_TOPICS, speciesFactsFor, TOPIC_WORDS } from "@/shared/apps/species-facts";

const input = z.object({
  topic: z.enum(FACT_TOPICS).optional().describe(FACT_TOPICS.map((t) => `${t} (${TOPIC_WORDS[t]})`).join(", ") + ". Omit for everything."),
  species: z.string().min(2).max(60).optional().describe("One species by name when the question is about one (silver, bighead, grass or black carp). Omit for the app's species."),
});

export const speciesInfo = {
  name: "species_info",
  description:
    "General knowledge about this app's species for the questions the data cannot answer: what it looks like, how to tell it from look-alikes, how big it gets, what it eats, where and when it lives, how it breeds, why it is a problem, how it is hunted or removed, the rules for taking it, safety and handling, whether it is eaten, and how to report one. Not counts, places or dates of reports (use the data tools for those). Returns facts plus public sources, no record ids.",
  inputSchema: input,
  async execute(args: z.infer<typeof input>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const { species, sources } = speciesFactsFor(ctx.app.id, { species: args.species, topic: args.topic });
    return output(
      {
        kind: "general reference, not this app's data",
        species: species.map((s) => ({ name: s.name, scientificName: s.scientificName, facts: s.facts.map((f) => ({ topic: f.topic, title: f.title, text: f.text })) })),
        sources,
        note: "Answer only from these facts, in plain words and briefly. Say once that this is general information and not from the app's sightings. Name the sources (with their links) when the user asks where it comes from. For rules and safety say they change and to check the current ones with the agency. Do not add a freshness line: no feed is involved.",
      },
      [],
      [],
      species.reduce((n, s) => n + s.facts.length, 0),
    );
  },
};
