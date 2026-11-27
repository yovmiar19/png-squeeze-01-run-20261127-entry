// PNG scanline filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) and candidate
// generation: five fixed filters plus per-row MinSum (smallest sum of absolute
// signed filtered bytes). Candidates are ranked by a fast zlib level-6 proxy.

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function filterRow(
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
  filter: number,
  out: Uint8Array,
): void {
  out[0] = filter;
  const len = row.length;
  if (filter === 0) {
    out.set(row, 1);
    return;
  }
  for (let x = 0; x < len; x++) {
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = a;
    else if (filter === 2) pred = b;
    else if (filter === 3) pred = (a + b) >> 1;
    else pred = paethPredictor(a, b, c);
    out[x + 1] = (row[x] - pred) & 255;
  }
}

/** Filter a whole image with one fixed filter per row list. */
export function filterImage(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  rowFilters: Uint8Array,
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const prev = new Uint8Array(stride);
  const rowBuf = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    filterRow(row, prev, bpp, rowFilters[y], rowBuf);
    out.set(rowBuf, y * (stride + 1));
    prev.set(row);
  }
  return out;
}

/** Score one filtered row under one filter: sum of |signed byte|. */
function rowCost(row: Uint8Array, prev: Uint8Array, bpp: number, filter: number): number {
  let sum = 0;
  const len = row.length;
  for (let x = 0; x < len; x++) {
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = a;
    else if (filter === 2) pred = b;
    else if (filter === 3) pred = (a + b) >> 1;
    else if (filter === 4) pred = paethPredictor(a, b, c);
    const v = (row[x] - pred) & 255;
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/** Per-row filter choice minimising the signed-absolute sum. */
export function minSumFilters(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const stride = width * bpp;
  const choice = new Uint8Array(height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = rowCost(row, prev, bpp, f);
      if (c < bestCost) {
        bestCost = c;
        best = f;
      }
    }
    choice[y] = best;
    prev.set(row);
  }
  return choice;
}

/** Candidate row-filter assignments: fixed None, fixed Up, and MinSum.
 * Fixed Sub/Average/Paeth never won the level-6 ranking on the practice
 * set (the per-row brute search dominates them: it can pick any filter per
 * row), so they are not tried — each costs a full proxy deflate. */
export function candidateFilters(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array[] {
  const cands: Uint8Array[] = [];
  for (const f of [0, 2]) cands.push(new Uint8Array(height).fill(f));
  cands.push(minSumFilters(data, width, height, bpp));
  return cands;
}


/**
 * Brute-force per-row filter choice (oxipng style): for each row, try all 5
 * filters and keep the one whose zlib size is smallest when compressed
 * together with the previous few filtered rows. `deflate` is the caller's
 * zlib proxy (level 6) so this module stays free of the zlib import.
 */
export function bruteFilters(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  deflate: (buf: Uint8Array) => number,
  windowRows = 4,
): Uint8Array {
  const stride = width * bpp;
  const choice = new Uint8Array(height);
  const prev = new Uint8Array(stride);
  const rowBuf = new Uint8Array(stride + 1);
  // Rolling window of previously chosen filtered rows (filter byte included).
  const window: Uint8Array[] = [];
  const scratch = new Uint8Array((windowRows + 1) * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    let bestFilter = 0;
    let bestSize = Infinity;
    const winLen = window.length;
    for (let f = 0; f < 5; f++) {
      filterRow(row, prev, bpp, f, rowBuf);
      let at = 0;
      for (let w = 0; w < winLen; w++) {
        scratch.set(window[w], at);
        at += stride + 1;
      }
      scratch.set(rowBuf, at);
      const size = deflate(scratch.subarray(0, at + stride + 1));
      if (size < bestSize) {
        bestSize = size;
        bestFilter = f;
      }
    }
    choice[y] = bestFilter;
    filterRow(row, prev, bpp, bestFilter, rowBuf);
    window.push(rowBuf.slice());
    if (window.length > windowRows) window.shift();
    prev.set(row);
  }
  return choice;
}
