// Lossless PNG compressor for make.fun png-squeeze-01-run-20261127.
// Reads /input/<id>/image.png (1280x720 RGBA), writes the smallest lossless
// PNG it can to /output/<id>/image.png. Input/output dirs may be overridden
// with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR for local grading.
// Node 22 standard library only; deterministic (no clock, no randomness,
// instance ids sorted).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './src/pngDecode.ts';
import { encodePng } from './src/pngEncode.ts';
import { reduceColors } from './src/colorReduce.ts';
import type { PaletteOrder, Reduced } from './src/colorReduce.ts';
import { bruteFilters, candidateFilters, filterImage } from './src/filters.ts';
import { bestDeflate, proxySize } from './src/compress.ts';
import { deflateOptimal } from './src/deflate.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function pixelsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Best filtered image for one reduced image: 5 fixed + MinSum + brute
 * per-row search, ranked by the level-6 proxy. */
function bestFiltered(reduced: Reduced): Uint8Array {
  const { data, width, height, bpp } = reduced;
  const cands = candidateFilters(data, width, height, bpp);
  cands.push(bruteFilters(data, width, height, bpp, proxySize));
  let best: Uint8Array | null = null;
  let bestProxy = Infinity;
  for (const rowFilters of cands) {
    const filtered = filterImage(data, width, height, bpp, rowFilters);
    const size = proxySize(filtered);
    if (size < bestProxy) {
      bestProxy = size;
      best = filtered;
    }
  }
  return best!;
}

function compressOne(inputPath: string): Uint8Array {
  const input = readFileSync(inputPath);
  const { width, height, rgba } = decodePng(input);
  const first = reduceColors(rgba, width, height, 'freq');
  let reduced: Reduced;
  let filtered: Uint8Array;
  if (first.colorType === 3) {
    // Palette image: rank the four palette orderings by the better of
    // their filter-0 and filter-2 (Up) proxies — an ordering can win only
    // under Up (e.g. luminance-ordered greys) — and run the full filter
    // search on the best one only.
    const orders: PaletteOrder[] = ['freq', 'lum', 'rgb', 'first'];
    const ranked = orders
      .map((order) => {
        const r = reduceColors(rgba, width, height, order);
        const f0 = filterImage(r.data, width, height, r.bpp, new Uint8Array(height));
        const f2 = filterImage(
          r.data,
          width,
          height,
          r.bpp,
          new Uint8Array(height).fill(2),
        );
        return { order, reduced: r, proxy0: Math.min(proxySize(f0), proxySize(f2)) };
      })
      .sort((a, b) => a.proxy0 - b.proxy0);
    reduced = ranked[0].reduced;
    filtered = bestFiltered(reduced);
  } else {
    reduced = first;
    filtered = bestFiltered(reduced);
  }
  let bestIdat = bestDeflate(filtered);
  // Stage 2/3: optimal-parse deflate; keep it only when it actually beats
  // zlib level 9. Skipped for RGBA images zlib already squeezes below 2%
  // of raw size (measured: optimal parse never wins there, and it is the
  // slowest case). Chain budget and DP iterations scale with data size so
  // the whole set stays within the wall budget.
  const large = filtered.length > 2_000_000;
  const skipOptimal =
    reduced.colorType === 6 && bestIdat.length / filtered.length < 0.02;
  if (!skipOptimal) {
    const custom = deflateOptimal(filtered, {
      chainLimit: large ? 1024 : 4096,
      goodLength: 128,
      niceLength: 258,
      iterations: large ? 1 : 2,
      blockTokens: 100000,
      cacheChainLimit: large ? 256 : 768,
    });
    if (custom.length < bestIdat.length) bestIdat = custom;
  }
  const png = encodePng({
    width,
    height,
    colorType: reduced.colorType,
    plte: reduced.plte,
    trns: reduced.trns,
    idat: bestIdat,
  });
  // Lossless verification: decode what we wrote and compare every pixel.
  // On any mismatch, fall back to the exact input bytes.
  try {
    const check = decodePng(Buffer.from(png));
    if (
      check.width === width &&
      check.height === height &&
      pixelsEqual(check.rgba, rgba)
    ) {
      return png;
    }
  } catch {
    // fall through to the copy fallback
  }
  return new Uint8Array(input);
}

const ids = readdirSync(INPUT_DIR).sort();
for (const id of ids) {
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  const out = compressOne(join(INPUT_DIR, id, 'image.png'));
  writeFileSync(join(outDir, 'image.png'), out);
}
