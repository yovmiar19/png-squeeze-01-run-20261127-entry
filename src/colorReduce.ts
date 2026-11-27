// Colour-type reduction: palette (type 3) when <= 256 distinct RGBA colours,
// grey (type 0) / grey+alpha (type 4) when R=G=B everywhere, RGB (type 2) when
// opaque, else RGBA (type 6). Fully transparent pixels keep their RGB exactly
// (lossless requirement). Palette ordering is a parameter: 'freq' (frequency
// desc), 'lum' (luminance asc), 'rgb' (packed RGB value asc), 'first' (first
// occurrence) — different orders win on different images, so the caller tries
// several and keeps the smallest by proxy.

export interface Reduced {
  colorType: number;
  bpp: number;
  data: Uint8Array; // width*height*bpp, unfiltered, row-major
  plte?: Uint8Array;
  trns?: Uint8Array;
  width: number;
  height: number;
}

export type PaletteOrder = 'freq' | 'lum' | 'rgb' | 'first';

function luminance(key: number): number {
  return ((key >>> 24) & 255) * 299 + ((key >>> 16) & 255) * 587 + ((key >>> 8) & 255) * 114;
}

export function reduceColors(
  rgba: Uint8Array,
  width: number,
  height: number,
  paletteOrder: PaletteOrder = 'freq',
): Reduced {
  const n = width * height;
  const counts = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (counts.size <= 256) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!counts.has(key)) firstSeen.set(key, i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size <= 256) {
    const entries = [...counts.entries()];
    if (paletteOrder === 'freq') entries.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    else if (paletteOrder === 'lum')
      entries.sort((x, y) => luminance(x[0]) - luminance(y[0]) || x[0] - y[0]);
    else if (paletteOrder === 'rgb') entries.sort((x, y) => x[0] - y[0]);
    else entries.sort((x, y) => firstSeen.get(x[0])! - firstSeen.get(y[0])!);
    const indexOf = new Map<number, number>();
    const plte = new Uint8Array(entries.length * 3);
    const alphas = new Uint8Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      indexOf.set(key, i);
      plte[i * 3] = (key >>> 24) & 255;
      plte[i * 3 + 1] = (key >>> 16) & 255;
      plte[i * 3 + 2] = (key >>> 8) & 255;
      alphas[i] = key & 255;
    }
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const key =
        ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>>
        0;
      data[i] = indexOf.get(key)!;
    }
    let trns: Uint8Array | undefined;
    let lastNonOpaque = -1;
    for (let i = 0; i < alphas.length; i++) if (alphas[i] !== 255) lastNonOpaque = i;
    if (lastNonOpaque >= 0) trns = alphas.subarray(0, lastNonOpaque + 1);
    return { colorType: 3, bpp: 1, data, plte, trns, width, height };
  }

  if (allGrey) {
    if (allOpaque) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      return { colorType: 0, bpp: 1, data, width, height };
    }
    const data = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = rgba[i * 4];
      data[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return { colorType: 4, bpp: 2, data, width, height };
  }

  if (allOpaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colorType: 2, bpp: 3, data, width, height };
  }

  return { colorType: 6, bpp: 4, data: rgba.slice(), width, height };
}

/** True when the image reduces to a palette (<= 256 distinct colours). */
export function isPalette(rgba: Uint8Array, width: number, height: number): boolean {
  const n = width * height;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const key =
      ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>>
      0;
    seen.add(key);
    if (seen.size > 256) return false;
  }
  return true;
}
