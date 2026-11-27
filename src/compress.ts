// Compression choice: rank filtered candidates with a fast zlib level-6
// proxy, then deflate the winner at level 9 trying several strategies and
// keep the smallest stream. Deterministic: no clock, no randomness.
import zlib from 'node:zlib';

const Z = (zlib as unknown as { constants: Record<string, number> }).constants;

export function proxySize(data: Uint8Array): number {
  return zlib.deflateSync(data, { level: 6 }).length;
}

export function bestDeflate(data: Uint8Array): Uint8Array {
  let best: Buffer | null = null;
  const strategies = [Z.Z_DEFAULT_STRATEGY, Z.Z_FILTERED];
  for (const strategy of strategies) {
    const out = zlib.deflateSync(data, { level: 9, memLevel: 9, strategy });
    if (best === null || out.length < best.length) best = out;
  }
  return best!;
}
