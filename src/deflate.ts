// Custom DEFLATE (zopfli-lite) written from the DEFLATE spec (RFC 1951) and
// general LZ77/Huffman knowledge: lazy matching over hash chains, dynamic
// Huffman with length-limited codes (package-merge), block splitting, and a
// zlib wrapper (RFC 1950). Deterministic: all cutoffs are by amount of work.

// ---- DEFLATE constants (RFC 1951) ----
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
  13,
];
const CLCL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export function lengthSymbol(len: number): number {
  if (len === 258) return 285;
  for (let s = 0; s < 29; s++) {
    if (len >= LENGTH_BASE[s] && len < (s + 1 < 29 ? LENGTH_BASE[s + 1] : 259)) return 257 + s;
  }
  return 285;
}

export function distSymbol(dist: number): number {
  for (let s = 0; s < 30; s++) {
    if (dist >= DIST_BASE[s] && dist < (s + 1 < 30 ? DIST_BASE[s + 1] : 32769)) return s;
  }
  return 29;
}

// ---- Bit writer (LSB-first, as DEFLATE requires) ----
export class BitWriter {
  bytes: number[] = [];
  private bitBuf = 0;
  private bitLen = 0;

  writeBits(value: number, count: number): void {
    this.bitBuf |= value << this.bitLen;
    this.bitLen += count;
    while (this.bitLen >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitLen -= 8;
    }
  }

  /** Write a Huffman code (stored MSB-first in `code`) bit-reversed. */
  writeCode(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >> i) & 1);
    this.writeBits(rev, len);
  }

  align(): void {
    if (this.bitLen > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitLen = 0;
    }
  }
}

/** Canonical Huffman codes from code lengths. */
export function codesFromLengths(lengths: Uint8Array): Uint32Array {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const blCount = new Uint16Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (len > 0) codes[i] = nextCode[len]++;
  }
  return codes;
}

// ---- Length-limited Huffman via package-merge ----
// Moffat-Turpin package-merge: lists[0] is the leaves sorted by frequency;
// each further level packages the previous level's list into pairs and
// merges with the leaves, keeping the 2n-2 lightest items. After maxBits
// levels, a symbol's code length is the number of final-list nodes whose
// symbol set contains it.
export function huffmanLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  const leaves = syms
    .map((s) => ({ freq: freq[s], syms: [s] }))
    .sort((a, b) => a.freq - b.freq || a.syms[0] - b.syms[0]);
  const limit = 2 * leaves.length - 2;
  let prev: Array<{ freq: number; syms: number[] }> = leaves;
  // Run maxBits-1 packaging levels: a symbol's length is its count in the
  // final list, which is at most (levels + 1) = maxBits. (Verified
  // empirically: maxBits levels can yield maxBits+1.)
  for (let level = 1; level <= maxBits - 1; level++) {
    const packaged: Array<{ freq: number; syms: number[] }> = [];
    for (let j = 0; j + 1 < prev.length; j += 2) {
      packaged.push({
        freq: prev[j].freq + prev[j + 1].freq,
        syms: prev[j].syms.concat(prev[j + 1].syms),
      });
    }
    const merged: Array<{ freq: number; syms: number[] }> = [];
    let a = 0;
    let b = 0;
    while (merged.length < limit && (a < packaged.length || b < leaves.length)) {
      if (b >= leaves.length || (a < packaged.length && packaged[a].freq <= leaves[b].freq)) {
        merged.push(packaged[a++]);
      } else {
        merged.push(leaves[b++]);
      }
    }
    prev = merged;
  }
  for (const node of prev) {
    for (const s of node.syms) lengths[s]++;
  }
  // Safety net: any length still over maxBits (should not happen) falls back
  // to a complete equal-ish code: a symbols at L-1, the rest at L, with
  // L = ceil(log2(n)), a = 2^L - n; shortest lengths to highest frequencies.
  let maxLen = 0;
  for (const s of syms) if (lengths[s] > maxLen) maxLen = lengths[s];
  if (maxLen > maxBits) {
    const n = syms.length;
    const L = Math.ceil(Math.log2(n));
    const a = 2 ** L - n;
    const byFreq = [...syms].sort((x, y) => freq[y] - freq[x] || x - y);
    for (let k = 0; k < byFreq.length; k++) lengths[byFreq[k]] = k < a ? L - 1 : L;
  }
  for (const s of syms) if (lengths[s] === 0) lengths[s] = maxBits;
  return lengths;
}

// ---- RLE of code lengths (repeat codes 16/17/18) ----
export interface RleResult {
  seq: number[]; // alternating code / extra-bits values
  freq: Uint32Array; // frequencies of CLCL symbols 0..18
}

export function rleCodeLengths(combined: Uint8Array): RleResult {
  const seq: number[] = [];
  const freq = new Uint32Array(19);
  let i = 0;
  while (i < combined.length) {
    const v = combined[i];
    let run = 1;
    while (i + run < combined.length && combined[i + run] === v) run++;
    let consumed = 0;
    if (v === 0) {
      while (run - consumed >= 11) {
        const take = Math.min(run - consumed, 138);
        seq.push(18, take - 11);
        freq[18]++;
        consumed += take;
      }
      if (run - consumed >= 3) {
        seq.push(17, run - consumed - 3);
        freq[17]++;
        consumed = run;
      }
      while (consumed < run) {
        seq.push(0);
        freq[0]++;
        consumed++;
      }
    } else {
      seq.push(v);
      freq[v]++;
      consumed = 1;
      while (run - consumed >= 3) {
        const take = Math.min(run - consumed, 6);
        seq.push(16, take - 3);
        freq[16]++;
        consumed += take;
      }
      while (consumed < run) {
        seq.push(v);
        freq[v]++;
        consumed++;
      }
    }
    i += run;
  }
  return { seq, freq };
}

// ---- LZ77 token stream ----
export interface Lz77 {
  sym: Int32Array; // literal byte (0-255) or match length (3-258)
  dist: Int32Array; // match distance (0 for literals)
  count: number;
}

function hash3(data: Uint8Array, pos: number): number {
  return ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & 0x7fff;
}

export interface ParseOptions {
  chainLimit: number;
  goodLength: number;
  niceLength: number;
}

/**
 * Lazy-matching LZ77 parse with hash chains. All limits are work-based
 * (deterministic).
 */
export function lz77Parse(data: Uint8Array, opts: ParseOptions): Lz77 {
  const n = data.length;
  const sym = new Int32Array(n);
  const dist = new Int32Array(n);
  let count = 0;
  const HASH_SIZE = 32768;
  const head = new Int32Array(HASH_SIZE);
  head.fill(-1);
  const prev = new Int32Array(n);
  prev.fill(-1);

  const insert = (pos: number): void => {
    if (pos + 2 >= n) return;
    const h = hash3(data, pos);
    prev[pos] = head[h];
    head[h] = pos;
  };

  const findMatch = (pos: number, maxLen: number): { len: number; dist: number } => {
    let bestLen = 0;
    let bestDist = 0;
    if (pos + 2 >= n) return { len: 0, dist: 0 };
    const h = hash3(data, pos);
    let cand = head[h];
    let chain = opts.chainLimit;
    const maxDist = Math.min(pos, 32768);
    const limit = Math.min(maxLen, n - pos);
    while (cand >= 0 && chain-- > 0) {
      if (pos - cand > maxDist) break;
      if (bestLen > 0 && data[cand + bestLen] !== data[pos + bestLen]) {
        cand = prev[cand];
        continue;
      }
      let len = 0;
      while (len < limit && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len >= opts.niceLength) break;
        if (len >= opts.goodLength) chain = Math.min(chain, 32);
      }
      cand = prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  };

  let i = 0;
  while (i < n) {
    let m1 = { len: 0, dist: 0 };
    if (i + 3 <= n) m1 = findMatch(i, 258);
    if (m1.len >= 3) {
      if (i + 1 + 3 <= n && m1.len < opts.niceLength) {
        insert(i);
        const m2 = findMatch(i + 1, 258);
        if (m2.len > m1.len) {
          sym[count] = data[i];
          dist[count] = 0;
          count++;
          i++;
          continue;
        }
      }
      sym[count] = m1.len;
      dist[count] = m1.dist;
      count++;
      const end = Math.min(i + m1.len, n);
      for (let j = i + 1; j < end; j++) insert(j);
      i = end;
    } else {
      sym[count] = data[i];
      dist[count] = 0;
      count++;
      insert(i);
      i++;
    }
  }
  return { sym, dist, count };
}

// ---- Dynamic block writer ----

export function blockFrequencies(lz: Lz77, from: number, to: number): {
  litFreq: Uint32Array;
  distFreq: Uint32Array;
} {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let k = from; k < to; k++) {
    if (lz.dist[k] === 0) {
      litFreq[lz.sym[k]]++;
    } else {
      litFreq[lengthSymbol(lz.sym[k])]++;
      distFreq[distSymbol(lz.dist[k])]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

/** Write one dynamic-Huffman block for tokens [from, to). */
export function writeDynamicBlock(
  bw: BitWriter,
  lz: Lz77,
  from: number,
  to: number,
  isFinal: boolean,
): void {
  const { litFreq, distFreq } = blockFrequencies(lz, from, to);
  const litLengths = huffmanLengths(litFreq, 15);
  let distLengths = huffmanLengths(distFreq, 15);
  let distUsed = 0;
  for (let i = 0; i < 30; i++) if (distFreq[i] > 0) distUsed++;
  if (distUsed === 0) {
    distLengths = new Uint8Array(30);
    distLengths[0] = 1;
  }
  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  const combined = new Uint8Array(hlit + hdist);
  combined.set(litLengths.subarray(0, hlit), 0);
  combined.set(distLengths.subarray(0, hdist), hlit);
  const { seq, freq: clFreq } = rleCodeLengths(combined);
  const clLengths = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLengths[CLCL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = codesFromLengths(clLengths);
  const litCodes = codesFromLengths(litLengths);
  const distCodes = codesFromLengths(distLengths);

  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2); // BTYPE 10 = dynamic Huffman
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.writeBits(clLengths[CLCL_ORDER[k]], 3);
  for (let k = 0; k < seq.length; k++) {
    const s = seq[k];
    bw.writeCode(clCodes[s], clLengths[s]);
    if (s === 16) bw.writeBits(seq[++k], 2);
    else if (s === 17) bw.writeBits(seq[++k], 3);
    else if (s === 18) bw.writeBits(seq[++k], 7);
  }
  for (let k = from; k < to; k++) {
    if (lz.dist[k] === 0) {
      const s = lz.sym[k];
      bw.writeCode(litCodes[s], litLengths[s]);
    } else {
      const len = lz.sym[k];
      const ls = lengthSymbol(len);
      bw.writeCode(litCodes[ls], litLengths[ls]);
      if (LENGTH_EXTRA[ls - 257] > 0) bw.writeBits(len - LENGTH_BASE[ls - 257], LENGTH_EXTRA[ls - 257]);
      const ds = distSymbol(lz.dist[k]);
      bw.writeCode(distCodes[ds], distLengths[ds]);
      if (DIST_EXTRA[ds] > 0) bw.writeBits(lz.dist[k] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.writeCode(litCodes[256], litLengths[256]);
}

// ---- Optimal parse (DP shortest path) ----
// Lengths at which the length code (and its extra bits) can change, plus the
// maximum. Considering only these lengths per position keeps the DP fast
// while covering every distinct length cost.
const LENGTH_OPTIONS = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];

export interface MatchCache {
  len: Int32Array;
  dist: Int32Array;
}

/**
 * Find the longest match at EVERY position (not just token boundaries) and
 * cache it. No jump shortcut: filling positions inside a long match from
 * that match under-reports their true longest match and measurably hurts
 * the DP, so every position is searched.
 */
export function buildMatchCache(
  data: Uint8Array,
  opts: ParseOptions,
): MatchCache {
  const n = data.length;
  const lenArr = new Int32Array(n);
  const distArr = new Int32Array(n);
  const HASH_SIZE = 32768;
  const head = new Int32Array(HASH_SIZE);
  head.fill(-1);
  const prev = new Int32Array(n);
  prev.fill(-1);

  const findMatch = (pos: number, maxLen: number): { len: number; dist: number } => {
    let bestLen = 0;
    let bestDist = 0;
    if (pos + 2 >= n) return { len: 0, dist: 0 };
    const h = hash3(data, pos);
    let cand = head[h];
    let chain = opts.chainLimit;
    const maxDist = Math.min(pos, 32768);
    const limit = Math.min(maxLen, n - pos);
    while (cand >= 0 && chain-- > 0) {
      if (pos - cand > maxDist) break;
      if (bestLen > 0 && data[cand + bestLen] !== data[pos + bestLen]) {
        cand = prev[cand];
        continue;
      }
      let len = 0;
      while (len < limit && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len >= opts.niceLength) break;
        if (len >= opts.goodLength) chain = Math.min(chain, 32);
      }
      cand = prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  };

  for (let i = 0; i < n; i++) {
    const m = i + 3 <= n ? findMatch(i, 258) : { len: 0, dist: 0 };
    lenArr[i] = m.len;
    distArr[i] = m.dist;
    if (i + 2 < n) {
      const h = hash3(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { len: lenArr, dist: distArr };
}

/**
 * DP shortest path over the match cache with a fixed Huffman cost model.
 * Returns the token stream minimising sum of code lengths + extra bits.
 */
export function optimalParse(
  data: Uint8Array,
  cache: MatchCache,
  litLengths: Uint8Array,
  distLengths: Uint8Array,
): Lz77 {
  const n = data.length;
  const dp = new Float64Array(n + 1);
  dp.fill(Infinity);
  dp[0] = 0;
  const choice = new Int32Array(n + 1); // token length ending at this position (0 = literal)
  const cacheLen = cache.len;
  const cacheDist = cache.dist;
  // Cost of a match of length L, excluding the distance part:
  // lit/len code length + length extra bits, for every L.
  const lenCost = new Float64Array(259);
  for (let L = 3; L <= 258; L++) {
    const ls = lengthSymbol(L);
    lenCost[L] = litLengths[ls] + LENGTH_EXTRA[ls - 257];
  }
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    if (base === Infinity) continue;
    // Literal.
    const lc = litLengths[data[i]];
    if (base + lc < dp[i + 1]) {
      dp[i + 1] = base + lc;
      choice[i + 1] = 0;
    }
    // Matches: only lengths where the length code can change, plus the max.
    const ml = cacheLen[i];
    if (ml >= 3) {
      const ds = distSymbol(cacheDist[i]);
      const dc = distLengths[ds] + DIST_EXTRA[ds];
      for (let o = 0; o < LENGTH_OPTIONS.length; o++) {
        const L = LENGTH_OPTIONS[o];
        if (L > ml) break;
        const c = lenCost[L] + dc;
        if (base + c < dp[i + L]) {
          dp[i + L] = base + c;
          choice[i + L] = L;
        }
      }
      if (ml !== 258 && ml > 3) {
        const c = lenCost[ml] + dc;
        if (base + c < dp[i + ml]) {
          dp[i + ml] = base + c;
          choice[i + ml] = ml;
        }
      }
    }
  }
  // Backtrack.
  const sym: number[] = [];
  const dist: number[] = [];
  let pos = n;
  while (pos > 0) {
    const L = choice[pos];
    if (L === 0) {
      sym.push(data[pos - 1]);
      dist.push(0);
      pos--;
    } else {
      sym.push(L);
      dist.push(cache.dist[pos - L]);
      pos -= L;
    }
  }
  sym.reverse();
  dist.reverse();
  return { sym: Int32Array.from(sym), dist: Int32Array.from(dist), count: sym.length };
}

/**
 * Full optimal-parse deflate: lazy parse for the initial cost model, then
 * `iterations` rounds of (DP parse -> recompute Huffman lengths), and encode
 * the final token stream with dynamic Huffman blocks.
 */
export function deflateOptimal(
  data: Uint8Array,
  opts: ParseOptions & { iterations: number; blockTokens: number; cacheChainLimit?: number },
): Uint8Array {
  const lz0 = lz77Parse(data, opts);
  const { litFreq, distFreq } = blockFrequencies(lz0, 0, lz0.count);
  let litLengths = huffmanLengths(litFreq, 15);
  let distLengths = huffmanLengths(distFreq, 15);
  // The match cache is the expensive part: bound its chain by data size.
  const cacheChain =
    opts.cacheChainLimit ?? (data.length > 2_000_000 ? 256 : 1024);
  const cache = buildMatchCache(data, { ...opts, chainLimit: cacheChain });
  let lz: Lz77 = lz0;
  for (let it = 0; it < opts.iterations; it++) {
    lz = optimalParse(data, cache, litLengths, distLengths);
    const f = blockFrequencies(lz, 0, lz.count);
    litLengths = huffmanLengths(f.litFreq, 15);
    distLengths = huffmanLengths(f.distFreq, 15);
  }
  const bw = new BitWriter();
  const total = lz.count;
  if (opts.blockTokens > 0 && total > opts.blockTokens) {
    let from = 0;
    while (from < total) {
      const to = Math.min(total, from + opts.blockTokens);
      writeDynamicBlock(bw, lz, from, to, to === total);
      from = to;
    }
  } else {
    writeDynamicBlock(bw, lz, 0, total, true);
  }
  bw.align();
  const adler = adler32(data);
  const out = new Uint8Array(2 + bw.bytes.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(bw.bytes, 2);
  out[2 + bw.bytes.length] = (adler >>> 24) & 0xff;
  out[2 + bw.bytes.length + 1] = (adler >>> 16) & 0xff;
  out[2 + bw.bytes.length + 2] = (adler >>> 8) & 0xff;
  out[2 + bw.bytes.length + 3] = adler & 0xff;
  return out;
}

// ---- Adler-32 (zlib checksum) ----
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export interface DeflateOptions {
  chainLimit: number;
  goodLength: number;
  niceLength: number;
  /** Max tokens per block (0 = single block). */
  blockTokens: number;
}

/**
 * Deflate `data` into a complete zlib stream (header 0x78 0xDA, dynamic
 * blocks, Adler-32). Returns the stream bytes.
 */
export function deflateZlib(data: Uint8Array, opts: DeflateOptions): Uint8Array {
  const lz = lz77Parse(data, opts);
  const bw = new BitWriter();
  const total = lz.count;
  if (opts.blockTokens > 0 && total > opts.blockTokens) {
    let from = 0;
    while (from < total) {
      const to = Math.min(total, from + opts.blockTokens);
      writeDynamicBlock(bw, lz, from, to, to === total);
      from = to;
    }
  } else {
    writeDynamicBlock(bw, lz, 0, total, true);
  }
  bw.align();
  const adler = adler32(data);
  const out = new Uint8Array(2 + bw.bytes.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(bw.bytes, 2);
  out[2 + bw.bytes.length] = (adler >>> 24) & 0xff;
  out[2 + bw.bytes.length + 1] = (adler >>> 16) & 0xff;
  out[2 + bw.bytes.length + 2] = (adler >>> 8) & 0xff;
  out[2 + bw.bytes.length + 3] = adler & 0xff;
  return out;
}
