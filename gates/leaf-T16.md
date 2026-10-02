# Gates: T16 active-state ./threads (fable)

Scope: `packages/active-state/src/threads/**`, exported as `@calvinjs/active-state/threads`:
- the C6 SAB SPSC ring and control block;
- the Transport interface, with SAB and postMessage implementations;
- `connectThread` for workers and `hostThread` for main;
- a key-index table derived from a catalog;
- cross-thread `set`/`subscribe` that leave the existing key/get/set/subscribe/useActiveState API unchanged;
- Float32Array bulk views over SAB for EVF frames.

- [x] G1: package tests pass, old and new
  CHECK: cd packages/active-state && bun test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 96 pass | 0 fail

- [x] G2: ring tests cover wraparound with the pad marker, a 1 MB value, 10k messages in order, a full ring applying backpressure (no overwrite), and version bumps
  CHECK: cd packages/active-state && bun test tests/threads 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([5-9]|[1-9][0-9]+) pass\s+0 fail/
  EVIDENCE: 30 pass | 0 fail

- [x] G3: a real Worker round trip: a Bun Worker with a SAB exchanges 10k messages in order, and the same test passes with the postMessage fallback
  CHECK: cd packages/active-state && bun test tests/threads -t "worker round trip" 2>&1 | grep -E "pass|fail"
  EXPECT: /[2-9] pass[\s\S]*0 fail|[1-9][0-9] pass[\s\S]*0 fail/
  EVIDENCE: 5 pass | 0 fail

- [x] G4: the ./threads export builds and resolves
  CHECK: cd packages/active-state && bun run build >/dev/null 2>&1 && node -e "import('@calvinjs/active-state/threads').then(m=>console.log(Object.keys(m).length>0?'EXPORT-OK':'EMPTY'))"
  EXPECT: EXPORT-OK
  EVIDENCE: EXPORT-OK

- [x] G5: the size delta is measured with scripts/size.ts and recorded in the package CHANGELOG or README
  CHECK: grep -iE "threads.*(kb|bytes)" packages/active-state/README.md packages/active-state/CHANGELOG.md 2>/dev/null | head -1
  EXPECT: /[0-9]/
  EVIDENCE: packages/active-state/README.md:| `@calvinjs/active-state/threads` | ~5.4KB | ~4.8KB | Workers — `hostThread` / `connectThread`, SAB ring, EVF2 frame grids (+ core) |

- [x] G6: EVF2 view sizes: FrameGrid exposes u8 hotspot views of 170x160 per species and i16 lst/sst views of 68x64, frame stride padded to 4, with hotspotScale and env dims in the header
  CHECK: cd packages/active-state && bun test tests/threads/bulk.test.ts -t "EVF2 view sizes" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail
