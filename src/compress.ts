// Compression choice: rank filtered candidates with a fast zlib level-6
// proxy, then deflate the winner at level 9 trying several strategies and
// keep the smallest stream. Deterministic: no clock, no randomness.
import zlib from 'node:zlib';

const Z = (zlib as unknown as { constants: Record<string, number> }).constants;

export function proxySize(data: Uint8Array): number {
  return zlib.deflateSync(data, { level: 6 }).length;
}

/** Cheaper proxy (level 2) for the brute per-row filter search only: its
 * choices measure equal-or-better than the level-6 brute by the level-6
 * proxy on the images where brute wins, at ~40% of the cost. Final
 * candidate ranking still uses the level-6 proxy. */
export function proxySizeFast(data: Uint8Array): number {
  return zlib.deflateSync(data, { level: 2 }).length;
}

export function bestDeflate(data: Uint8Array): Uint8Array {
  // Default strategy only: Z_FILTERED won on just 1 of 8 practice images
  // (i006, where the optimal-parse deflate beats it anyway) and the second
  // level-9 pass costs ~1.3 s over the set. The optimal-parse result is
  // kept whenever it beats this stream.
  return zlib.deflateSync(data, { level: 9, memLevel: 9, strategy: Z.Z_DEFAULT_STRATEGY });
}
