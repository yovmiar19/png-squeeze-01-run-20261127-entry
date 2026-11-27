// PNG decoder: reads a bit-depth-8, non-interlaced PNG (colour types 0/2/3/4/6)
// and returns pixels as RGBA. Written from the PNG format spec, not from any
// reference implementation.
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Buffer): DecodedPng {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idatParts: Buffer[] = [];
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!channels || width <= 0 || height <= 0) throw new Error('unsupported PNG');
  const raw = inflateSync(Buffer.concat(idatParts));
  const bpp = channels;
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) {
        v = (v + a) & 255;
      } else if (f === 2) {
        v = (v + b) & 255;
      } else if (f === 3) {
        v = (v + ((a + b) >> 1)) & 255;
      } else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      out[x] = v;
    }
    const dst = y * width * 4;
    if (colorType === 6) {
      rgba.set(out, dst);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        rgba[dst + x * 4] = out[x * 3];
        rgba[dst + x * 4 + 1] = out[x * 3 + 1];
        rgba[dst + x * 4 + 2] = out[x * 3 + 2];
        rgba[dst + x * 4 + 3] = 255;
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const g = out[x];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const g = out[x * 2];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = out[x * 2 + 1];
      }
    } else if (colorType === 3) {
      for (let x = 0; x < width; x++) {
        const idx = out[x];
        const p = idx * 3;
        rgba[dst + x * 4] = plte![p];
        rgba[dst + x * 4 + 1] = plte![p + 1];
        rgba[dst + x * 4 + 2] = plte![p + 2];
        rgba[dst + x * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = out;
  }
  return { width, height, rgba };
}
