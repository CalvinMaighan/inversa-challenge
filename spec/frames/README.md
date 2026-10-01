# EVF2 golden vectors

Written by `api/src/frames.rs` (`cargo test -- evf_golden frames_regions`, regenerate with
`EVF_UPDATE_GOLDEN=1`); read by `apps/web/shared/frames.ts` and its tests. The authoritative byte
layout is the doc comment in `apps/web/shared/frames.ts`, extended by PLAN.md C-A4 as follows.

## Header (72 bytes, little-endian)

```
0 magic "EVF2" | 4 frameCount u32 | 8 hsCols u32 | 12 hsRows u32 | 16 west f64 | 24 south f64 |
32 hsCellDeg f64 | 40 frame0UnixMs i64 | 48 stepMinutes u32 | 52 speciesCount u32 |
56 envCols u16 | 58 envRows u16 | 60 envCellDeg f32 | 64 hotspotScale f32 | 68 regionCount u32
```

- `speciesCount` is the app's `taxa[]` length (4 for python, 1 for lionfish); hotspot sections are
  taxon-major in `taxa[]` order and `u16 taxon` in a sighting record is still `taxa.id` of the
  observations database.
- `regionCount` (the former reserved word) is the app's `regions[]` length. The grid fields at
  8–39 and 56–63 describe region 0.
- When `regionCount > 1`, `regionCount` descriptors of 40 bytes follow the header, one per region
  in `regions[]` order:

```
0 hsCols u32 | 4 hsRows u32 | 8 west f64 | 16 south f64 | 24 hsCellDeg f64 |
32 envCols u16 | 34 envRows u16 | 36 envCellDeg f32
```

  Header length is therefore `72 + regionCount * 40` for multi-region apps, `72` otherwise.

## Frames

Each frame is the concatenation of one body per region, in region order. A region body is the
pre-pivot frame body computed from that region's descriptor: `hotspot u8[speciesCount * hsCols *
hsRows]`, pad to 2, `lst i16[envCols * envRows]`, `sst i16[...]`, pad to 4, `sightingCount u32`
and 16-byte records for the sightings inside that region observed in the frame's window.

## Files

| file | app shape | notes |
|---|---|---|
| `sample.evf` | one region (20 × 10 scoring cells), 4 taxa, 3 hourly frames | the pre-pivot vector; the only byte that changed in the pivot is offset 68 (`regionCount` = 1) |
| `two-regions.evf` | two regions (20 × 10 and 30 × 20 scoring cells), 1 taxon, 3 hourly frames | header 72 + 2 × 40 bytes; frame bodies are region "west" then region "east"; sighting counts per region per frame are `[0,0] [1,0] [0,1]` |

`two-regions.evf` expectations (see `frames_regions_round_trip` in `api/src/frames.rs`):

- region 0 hotspot grid 10 × 5, env 4 × 2, west -80.5, south 25.2; region 1 hotspot 15 × 10, env
  6 × 4, west -80.2, south 25.2; both `hsCellDeg` 0.02, `envCellDeg` 0.05.
- frame0 2025-02-01T00:00:00Z, step 60, speciesCount 1, regionCount 2.
- region 0 cell (2,2) scores 100 in every frame; region 1 cell (10,10) scores 10 (rough sea);
  region 1 env cell (0,0) SST is 2400 centi-°C; region 0 has no SST.
- frame 2's east record: sighting id 4, quality 2, flags 2 (conflict).
