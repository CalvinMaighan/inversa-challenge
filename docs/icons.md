# Species icons

Every sighting on the globe, every chip in the species bar, every row of the categories popover, the evidence
card and the legend draw one icon per species category, tinted in the category's label colour over a dark
outline. The path data lives in `apps/web/shared/species-icons.ts`; React renders it inline
(`apps/web/client/hud/species/CategoryIcon.tsx`) and the globe strokes it once per category and colour onto a
32 px canvas (`apps/web/client/globe/species-icons.ts`) that Cesium keeps as one texture-atlas region.

| Category | Icon | Source | Licence |
|---|---|---|---|
| Snakes | snake | drawn for Inversa | MIT (this repository's licence) |
| Lizards | lizard | drawn for Inversa | MIT |
| Turtles & tortoises | `turtle` | Lucide v0.544.0 | ISC |
| Crocodilians | crocodile | drawn for Inversa | MIT |
| Frogs & toads | frog | drawn for Inversa | MIT |
| Birds | `bird` | Lucide v0.544.0 | ISC |
| Mammals | `paw-print` | Lucide v0.544.0 | ISC |
| Fish | `fish` | Lucide v0.544.0 | ISC |
| Snails & slugs | `snail` | Lucide v0.544.0 | ISC |
| Insects | `bug` | Lucide v0.544.0 | ISC |
| Spiders | spider | drawn for Inversa | MIT |
| Plants | `leaf` | Lucide v0.544.0 | ISC |
| Other | `circle-dot` | Lucide v0.544.0 | ISC |

Lucide icons are copied as path data from the Lucide repository at tag v0.544.0 (`icons/<name>.svg`), checked
against that release on 2026-10-01. Lucide has no snake, lizard, crocodile, frog or spider, so those five were
drawn in the same 24 × 24 box, 2 px round-capped strokes, to sit beside them.

## Lucide licence (ISC)

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other
copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING
ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Colours

One label colour per category (`CATEGORY_COLORS` in `apps/web/shared/species-categories.ts`), chosen apart from
the four focus colours (amber python, orange tegu, green iguana, pink lionfish) and from the hotspot heat ramp.
The focus species draw their category's icon in their own focus colour. An off category keeps its colour and
reads dimmer; nothing is grey except a taxon the client has not loaded yet.

## How a sighting gets its category

iNaturalist's `/v1/taxa` gives every taxon its `ancestor_ids`; Axum stores them (`taxa.ancestor_ids`,
migration `0005_taxon_ancestry.sql`) and serves them as `Taxon.ancestorIds`. `categoryFromAncestry` picks the
first category whose ancestor id appears: Serpentes 85553, Sauria 85552, Testudines 39532, Crocodylia 26039,
Anura 20979, Aves 3, Mammalia 40151, Actinopterygii 47178, Gastropoda 47114, Insecta 47158, Arachnida 47119,
Plantae 47126 (each checked against `GET https://api.inaturalist.org/v1/taxa/<id>` on 2026-10-01). A taxon
with no ancestry falls back to its iconic group where that is unambiguous (birds, mammals, fish, plants, …);
anything else is "Other".
