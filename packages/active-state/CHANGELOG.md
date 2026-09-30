# Changelog

## 0.2.0 (unreleased)

### Added

- `@calvinjs/active-state/threads`: run the store across Web Workers.
  - `hostThread(worker, catalog)` on the main thread and `connectThread(self, catalog)` in a worker. `set` on either side lands in the other store; `subscribe` and `useActiveState` fire as usual. Remote applies never echo back; with several workers, main fans out. The existing `key / get / set / subscribe` API is unchanged.
  - `Transport` interface with two implementations: `SabTransport` (a pair of SPSC byte rings over `SharedArrayBuffer`, `Atomics.notify` / `Atomics.waitAsync` / sliced `Atomics.wait`) and `MessageTransport` (postMessage). `createChannel()` picks SAB when `crossOriginIsolated`, otherwise postMessage; `openChannel(handle)` attaches the other end.
  - `Ring`: control block `Int32Array[2 + 256]` (write cursor, read cursor, one version per key index), power-of-2 capacity, `u16 keyIndex, u32 len, UTF-8 JSON` records, `0xFFFF` pad marker at the wrap, backpressure instead of overwrite. The default 2 MiB ring takes 1 MB values; oversized values throw with the limit in the message.
  - `keyIndexTable(catalog)`: a key's index is its position in the sorted id list.
  - `allocFrameGrid` / `attachFrameGrid`: `Float32Array` views over a SAB in the EVF1 per-frame order (hotspot per species, lst, sst) with a version counter (`bump`, `waitVersion`) so readers never copy.

### Size

- New entry `dist/threads/index.js`: 17,913 bytes raw, 5,130 bytes gzip (~5.0KB), 4,534 bytes brotli (~4.4KB), measured with `bun run size` / `bun run size:brotli`. Existing entries are unchanged: core 3,036, dom 5,274, react 1,373, eslint 2,427, CDN IIFE 5,824 bytes gzip before and after.

## 0.1.0

- Initial release: keyed pub/sub core, React bindings, DOM verbs, ESLint rules.
