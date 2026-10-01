# App icons

Each app has one icon, named by `icon` in its config (`spec/apps/*.json`). The app selector, the species chip,
the legend, the evidence card and every sighting on the globe draw it. The path data lives in
`apps/web/shared/app-icons.ts` (`APP_ICONS`, a 24 × 24 box, 2 px round-capped strokes). React renders it inline
(`apps/web/client/hud/appselect/AppIcon.tsx`), and the globe strokes it once per colour onto a 32 px canvas
(`apps/web/client/globe/marker-icons.ts`) that Cesium keeps as one texture-atlas region.

| App | Icon | Source | Licence |
|---|---|---|---|
| Everglades Ops (`python`) | snake | drawn for Inversa | MIT (this repository's licence) |
| Lionfish Watch (`lionfish`) | `fish` | Lucide v0.544.0 | ISC |
| Carp Field Conditions (`carp`) | `fish` | Lucide v0.544.0 | ISC |

An unknown icon id draws the fish (`appIconShape`). The fish is copied as path data from the Lucide repository at
tag v0.544.0 (`icons/fish.svg`), checked against that release on 2026-10-01. Lucide has no snake, so the snake
was drawn in the same box and stroke to sit beside it.

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

A sighting marker draws the app's icon in its taxon's `color` from the app config (`colorOfTaxon` in
`apps/web/client/globe/species.ts`): `#e4572e` for the Burmese python (`spec/apps/python.json`) and `#a06cd5`
for the lionfish (`spec/apps/lionfish.json`). The carp app tracks conditions and has no taxa. The tint sits over
a dark outline so a marker reads on satellite imagery in every theme.
