/**
 * Bundle size report + leave-one-out compression attribution.
 *
 *   bun run size
 *   bun run size -- --brotli
 *   bun scripts/size.ts dist/index.js --brotli
 *
 * For each `// src/...` chunk:
 *   delta ≈ compress(full) − compress(full without chunk)
 */
import {
  brotliCompressSync,
  constants,
  gzipSync,
} from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Chunk = { name: string; start: number; end: number; text: string };
type Codec = "gzip" | "brotli";

function splitChunks(source: string): Chunk[] {
  const re = /^\/\/ src\/\S+/gm;
  const marks: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    marks.push({ name: m[0].slice(3), index: m.index });
  }
  if (marks.length === 0) {
    return [
      { name: "(entire file)", start: 0, end: source.length, text: source },
    ];
  }

  const chunks: Chunk[] = [];
  if (marks[0]!.index > 0) {
    chunks.push({
      name: "(preamble)",
      start: 0,
      end: marks[0]!.index,
      text: source.slice(0, marks[0]!.index),
    });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.index;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : source.length;
    chunks.push({
      name: marks[i]!.name,
      start,
      end,
      text: source.slice(start, end),
    });
  }
  return chunks;
}

function gzipBytes(text: string | Buffer): number {
  return gzipSync(text, { level: 9 }).length;
}

function brotliBytes(text: string | Buffer): number {
  return brotliCompressSync(text, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

function compressBytes(codec: Codec, text: string | Buffer): number {
  return codec === "brotli" ? brotliBytes(text) : gzipBytes(text);
}

function listDistJs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".js") && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

function printTotals(files: string[], showBrotli: boolean): void {
  console.log(
    showBrotli
      ? "\nTotals\n     raw   gzip9  brotli11  file"
      : "\nTotals\n     raw   gzip9  file",
  );
  for (const file of files) {
    const buf = readFileSync(file);
    const raw = buf.length;
    const gz = gzipBytes(buf);
    if (showBrotli) {
      const br = brotliBytes(buf);
      console.log(
        `${String(raw).padStart(8)} ${String(gz).padStart(7)} ${String(br).padStart(9)}  ${file}`,
      );
    } else {
      console.log(`${String(raw).padStart(8)} ${String(gz).padStart(7)}  ${file}`);
    }
  }
}

function analyze(filePath: string, codec: Codec): void {
  const source = readFileSync(filePath, "utf8");
  const full = compressBytes(codec, source);
  const fullRaw = Buffer.byteLength(source);
  const chunks = splitChunks(source);
  const label = codec === "brotli" ? "br" : "gz";

  type Row = {
    name: string;
    raw: number;
    alone: number;
    delta: number;
    pct: number;
  };

  const rows: Row[] = chunks.map((chunk) => {
    const without = source.slice(0, chunk.start) + source.slice(chunk.end);
    const delta = Math.max(0, full - compressBytes(codec, without));
    return {
      name: chunk.name,
      raw: Buffer.byteLength(chunk.text),
      alone: compressBytes(codec, chunk.text),
      delta,
      pct: full === 0 ? 0 : (delta / full) * 100,
    };
  });

  rows.sort((a, b) => b.delta - a.delta);

  console.log(`\n${filePath}`);
  console.log(`  total  raw=${fullRaw}  ${codec}=${full}`);
  console.log(
    "  " +
      "raw".padStart(6) +
      `${label}Alone`.padStart(9) +
      `${label}Delta`.padStart(9) +
      `  %${label}  module`,
  );
  for (const r of rows) {
    console.log(
      "  " +
        String(r.raw).padStart(6) +
        String(r.alone).padStart(9) +
        String(r.delta).padStart(9) +
        `${r.pct.toFixed(1).padStart(6)}%  ${r.name}`,
    );
  }

  const accounted = rows.reduce((n, r) => n + r.delta, 0);
  console.log(
    `  sum(${label}Delta)=${accounted} vs full ${codec}=${full} (overlap/shared dict ⇒ sum ≠ total)`,
  );
}

const dist = join(import.meta.dir, "..", "dist");
const argv = process.argv.slice(2);
const showBrotli = argv.includes("--brotli");
const codec: Codec = showBrotli ? "brotli" : "gzip";
const targets = argv.filter((a) => a !== "--brotli" && a !== "--");
const files = targets.length > 0 ? targets : listDistJs(dist);

if (files.length === 0) {
  console.error("No dist JS found. Run `bun run build` first.");
  process.exit(1);
}

console.log(
  showBrotli
    ? "Leave-one-out brotli attribution (quality 11)"
    : "Leave-one-out gzip attribution (level 9)",
);
console.log(
  `delta = ${codec}(full) − ${codec}(full without chunk) ← trust this`,
);
console.log("alone = compress(chunk by itself) ← usually overstates");

printTotals(files, showBrotli);

for (const file of files) {
  analyze(file, codec);
}
