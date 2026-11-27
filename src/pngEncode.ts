// PNG encoder: writes a bit-depth-8, non-interlaced PNG holding only the
// chunks IHDR, PLTE (type 3 only), tRNS, IDAT, IEND, with correct CRCs.
export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface PngToWrite {
  width: number;
  height: number;
  colorType: number;
  plte?: Uint8Array;
  trns?: Uint8Array;
  idat: Uint8Array;
}

export function encodePng(p: PngToWrite): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, p.width);
  dv.setUint32(4, p.height);
  ihdr[8] = 8;
  ihdr[9] = p.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(['IHDR', ihdr]);
  if (p.plte) chunks.push(['PLTE', p.plte]);
  if (p.trns) chunks.push(['tRNS', p.trns]);
  chunks.push(['IDAT', p.idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
