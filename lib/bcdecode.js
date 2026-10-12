// Block-compressed texture decoders (BC1/BC2/BC3/BC4/BC5/BC7) + simple uncompressed formats -> RGBA8.
// Pure ES module: no DOM / Node APIs, safe in a Web Worker.
//
// decodeBC(format, data, width, height) -> Uint8Array (width*height*4, RGBA8)
//   format: 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC5' | 'BC7' | 'RGBA8' | 'BGRA8' | 'RGBX8' | 'BGRX8'
//   BC4 -> R replicated to RGB, A=255.  BC5 -> R,G, B=0, A=255.
//   Rounding follows Pillow's BcnDecode.c (integer truncation for BC1-5, standard BC7 weights).
//   BC7 partition / anchor tables were checked byte-for-byte against the tables in Pillow's binary.

// ---------------------------------------------------------------------------------------------
// BC7 tables
// ---------------------------------------------------------------------------------------------
const P2 =
  '00110011001100110001000100010001011101110111011100010011001101110000000100010011001101110111111100010011011111110000000100110111' +
  '00000000000100110011011111111111000000010111111100000000000101110001011111111111000000001111111100001111111111110000000000001111' +
  '00001000111011110111000100000000000000001000111001110011000100000011000100000000000010001100111000000000100011000111001100110001' +
  '00110001000100000000100010001100011001100110011000110110011011000001011111101000000011111111000001110001100011100011100110011100' +
  '01010101010101010000111100001111010110100101101000110011110011000011110000111100010101011010101001101001011010010101101010100101' +
  '01110011110011100001001111001000001100100100110000111011110111000110100110010110001111001100001101100110100110010000011001100000' +
  '01001110010000000010011100100000000000100111001000000100111001000110110010010011001101101100100101100011100111000011100111000110' +
  '01101100110010010110001100111001011111101000000100011000111001110000111100110011001100111111000000100010111011100100010001110111';
const P3 =
  '00110011022122220001001122112221000020012211221102220022001101110000000011221122001100110022002200220022111111110011001122112211' +
  '00000000111122220000111111112222000011112222222200120012001200120112011201120112012201220122012200110112112212220011200122002220' +
  '00010011011211220111001120012200000011221122112200220022002211110111011102220222000100012221222100000011012201220000110022102210' +
  '01220122001100000012001211222222011012211221011000000110122112210022110211020022011001102002222200110122012200110000200022112221' +
  '00000002112212220222002200120011001100120022022201200120012001200000111122220000012012012012012001202012120101200011220011220011' +
  '00111122220000110101010122222222000000002121212100221122002211220022001100220011022012210220122101012222222201010000212121212121' +
  '01010101010122220222011102220111000211120002111200002112211221120222011101110222000211121112000201100110011022220000000021122112' +
  '01100110222222220022001100110022002211221122002200000000000021120002000100020001022212220222122201012222222222220111201122012220';
const A2 = [15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,2,8,2,2,8,8,15,2,8,2,2,8,8,2,2,15,15,6,8,2,8,15,15,2,8,2,2,2,15,15,6,6,2,6,8,15,15,2,2,15,15,15,15,15,2,2,15];
const A3A = [3,3,15,15,8,3,15,15,8,8,6,6,6,5,3,3,3,3,8,15,3,3,6,10,5,8,8,6,8,5,15,15,8,15,3,5,6,10,8,15,15,3,15,5,15,15,15,15,3,15,5,5,5,8,5,10,5,10,8,13,15,12,3,3];
const A3B = [15,8,8,3,15,15,3,8,15,15,15,15,15,15,15,8,15,8,15,3,15,8,15,8,3,15,6,10,15,15,10,8,15,3,15,10,10,8,9,10,6,15,8,15,3,6,6,8,15,3,15,15,15,15,15,15,15,15,15,15,3,15,15,8];

// SUBSET[(ns-1)*1024 + part*16 + i] = subset of pixel i; ANCHOR likewise = 1 if pixel i is an anchor.
const SUBSET = new Uint8Array(3 * 1024);
const ANCHOR = new Uint8Array(3 * 1024);
for (let p = 0; p < 64; p++) {
  for (let i = 0; i < 16; i++) {
    SUBSET[1024 + p * 16 + i] = P2.charCodeAt(p * 16 + i) - 48;
    SUBSET[2048 + p * 16 + i] = P3.charCodeAt(p * 16 + i) - 48;
  }
  ANCHOR[p * 16] = 1;
  ANCHOR[1024 + p * 16] = 1; ANCHOR[1024 + p * 16 + A2[p]] = 1;
  ANCHOR[2048 + p * 16] = 1; ANCHOR[2048 + p * 16 + A3A[p]] = 1; ANCHOR[2048 + p * 16 + A3B[p]] = 1;
}

// per mode: NS, PB, RB, ISB, CB, AB, EPB, SPB, IB, IB2
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];
// WEIGHTS[bits] (bits 2..4), as flat arrays
const W2 = [0, 21, 43, 64], W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const WEIGHTS = [null, null, new Uint8Array(W2), new Uint8Array(W3), new Uint8Array(W4)];

// ---------------------------------------------------------------------------------------------
// shared scratch (module-level; decoders are synchronous so this is safe per worker)
// ---------------------------------------------------------------------------------------------
const W = new Uint32Array(5);        // BC7 block words (+1 pad)
const EP = new Int32Array(6 * 4);     // BC7 endpoints [endpoint*4 + ch]
const PAL = new Uint8Array(16);       // BC1 palette (4 x RGBA)
const APAL = new Uint8Array(8);       // BC3/4/5 alpha palette
const BLK = new Uint8Array(64);       // one decoded 4x4 block (RGBA)
const BLK32 = new Uint32Array(BLK.buffer);

function bits7(pos, n) {
  const idx = pos >>> 5, sh = pos & 31;
  let v = W[idx] >>> sh;
  if (sh + n > 32) v |= W[idx + 1] << (32 - sh);
  return v & ((1 << n) - 1);
}

function decodeBC7Block(src, o, dst) {
  W[0] = src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24);
  W[1] = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
  W[2] = src[o + 8] | (src[o + 9] << 8) | (src[o + 10] << 16) | (src[o + 11] << 24);
  W[3] = src[o + 12] | (src[o + 13] << 8) | (src[o + 14] << 16) | (src[o + 15] << 24);
  W[4] = 0;
  const b0 = src[o];
  if (b0 === 0) { dst.fill(0); return; } // reserved mode 8
  let mode = 0;
  while (!((b0 >> mode) & 1)) mode++;
  const m = MODES[mode];
  const ns = m[0], cb = m[4], ab = m[5], epb = m[6], spb = m[7], ib = m[8], ib2 = m[9];
  let pos = mode + 1;
  const part = m[1] ? bits7(pos, m[1]) : 0; pos += m[1];
  const rot = m[2] ? bits7(pos, 2) : 0; pos += m[2];
  const isb = m[3] ? bits7(pos, 1) : 0; pos += m[3];
  const nep = ns * 2;
  for (let c = 0; c < 3; c++) for (let e = 0; e < nep; e++) { EP[e * 4 + c] = bits7(pos, cb); pos += cb; }
  if (ab) for (let e = 0; e < nep; e++) { EP[e * 4 + 3] = bits7(pos, ab); pos += ab; }
  let cbits = cb, abits = ab;
  if (epb) {
    for (let e = 0; e < nep; e++) {
      const p = bits7(pos, 1); pos++;
      for (let c = 0; c < 4; c++) EP[e * 4 + c] = (EP[e * 4 + c] << 1) | p;
    }
    cbits++; if (ab) abits++;
  } else if (spb) {
    for (let s = 0; s < ns; s++) {
      const p = bits7(pos, 1); pos++;
      for (let c = 0; c < 4; c++) {
        EP[s * 8 + c] = (EP[s * 8 + c] << 1) | p;
        EP[s * 8 + 4 + c] = (EP[s * 8 + 4 + c] << 1) | p;
      }
    }
    cbits++; if (ab) abits++;
  }
  for (let e = 0; e < nep; e++) {
    for (let c = 0; c < 3; c++) { const v = EP[e * 4 + c] << (8 - cbits); EP[e * 4 + c] = v | (v >> cbits); }
    if (ab) { const v = EP[e * 4 + 3] << (8 - abits); EP[e * 4 + 3] = v | (v >> abits); }
    else EP[e * 4 + 3] = 255;
  }
  const tb = (ns - 1) * 1024 + part * 16;
  let ipos = pos, ipos2 = pos + 16 * ib - ns; // secondary indices follow primary (only for 1-subset modes)
  const wc = WEIGHTS[isb ? ib2 : ib], wa = WEIGHTS[ib2 ? (isb ? ib : ib2) : ib];
  for (let i = 0; i < 16; i++) {
    const s = SUBSET[tb + i];
    const n1 = ib - ANCHOR[tb + i];
    const i1 = bits7(ipos, n1); ipos += n1;
    let ci = i1, ai = i1;
    if (ib2) {
      const n2 = ib2 - (i === 0 ? 1 : 0);
      const i2 = bits7(ipos2, n2); ipos2 += n2;
      if (isb) { ci = i2; ai = i1; } else { ci = i1; ai = i2; }
    }
    const e0 = s * 8, e1 = e0 + 4;
    const w = wc[ci], iw = 64 - w, x = wa[ai], ix = 64 - x;
    let r = (EP[e0] * iw + EP[e1] * w + 32) >> 6;
    let g = (EP[e0 + 1] * iw + EP[e1 + 1] * w + 32) >> 6;
    let b = (EP[e0 + 2] * iw + EP[e1 + 2] * w + 32) >> 6;
    let a = (EP[e0 + 3] * ix + EP[e1 + 3] * x + 32) >> 6;
    if (rot) {
      let t;
      if (rot === 1) { t = a; a = r; r = t; }
      else if (rot === 2) { t = a; a = g; g = t; }
      else { t = a; a = b; b = t; }
    }
    const d = i * 4;
    dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a;
  }
}

// ---------------------------------------------------------------------------------------------
// BC1-5
// ---------------------------------------------------------------------------------------------
function bc1Palette(src, o, forceFour) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  let r0 = (c0 & 0xf800) >> 8; r0 |= r0 >> 5;
  let g0 = (c0 & 0x7e0) >> 3; g0 |= g0 >> 6;
  let b0 = (c0 & 0x1f) << 3; b0 |= b0 >> 5;
  let r1 = (c1 & 0xf800) >> 8; r1 |= r1 >> 5;
  let g1 = (c1 & 0x7e0) >> 3; g1 |= g1 >> 6;
  let b1 = (c1 & 0x1f) << 3; b1 |= b1 >> 5;
  PAL[0] = r0; PAL[1] = g0; PAL[2] = b0; PAL[3] = 255;
  PAL[4] = r1; PAL[5] = g1; PAL[6] = b1; PAL[7] = 255;
  if (c0 > c1 || forceFour) {
    PAL[8] = ((2 * r0 + r1) / 3) | 0; PAL[9] = ((2 * g0 + g1) / 3) | 0; PAL[10] = ((2 * b0 + b1) / 3) | 0; PAL[11] = 255;
    PAL[12] = ((r0 + 2 * r1) / 3) | 0; PAL[13] = ((g0 + 2 * g1) / 3) | 0; PAL[14] = ((b0 + 2 * b1) / 3) | 0; PAL[15] = 255;
  } else {
    PAL[8] = (r0 + r1) >> 1; PAL[9] = (g0 + g1) >> 1; PAL[10] = (b0 + b1) >> 1; PAL[11] = 255;
    PAL[12] = 0; PAL[13] = 0; PAL[14] = 0; PAL[15] = 0;
  }
}

function bc1Block(src, o, dst, forceFour) {
  bc1Palette(src, o, forceFour);
  const idx = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const p = ((idx >>> (2 * i)) & 3) * 4, d = i * 4;
    dst[d] = PAL[p]; dst[d + 1] = PAL[p + 1]; dst[d + 2] = PAL[p + 2]; dst[d + 3] = PAL[p + 3];
  }
}

// BC3-style 8-byte alpha block -> channel ch of dst
function alphaBlock(src, o, dst, ch) {
  const a0 = src[o], a1 = src[o + 1];
  APAL[0] = a0; APAL[1] = a1;
  if (a0 > a1) {
    for (let k = 1; k < 7; k++) APAL[k + 1] = (((7 - k) * a0 + k * a1) / 7) | 0;
  } else {
    for (let k = 1; k < 5; k++) APAL[k + 1] = (((5 - k) * a0 + k * a1) / 5) | 0;
    APAL[6] = 0; APAL[7] = 255;
  }
  // 48 bits of 3-bit indices, split into two 24-bit halves (no BigInt)
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16);
  const hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  for (let i = 0; i < 8; i++) dst[i * 4 + ch] = APAL[(lo >> (3 * i)) & 7];
  for (let i = 0; i < 8; i++) dst[(i + 8) * 4 + ch] = APAL[(hi >> (3 * i)) & 7];
}

// ---------------------------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------------------------
const BLOCK_BYTES = { BC1: 8, BC2: 16, BC3: 16, BC4: 8, BC5: 16, BC7: 16 };

/** Number of bytes a (width x height) surface of `format` occupies. */
export function surfaceSize(format, width, height) {
  const bb = BLOCK_BYTES[format];
  if (bb) return Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * bb;
  return width * height * 4;
}

export function decodeBC(format, data, width, height) {
  const out = new Uint8Array(width * height * 4);
  if (format === 'RGBA8' || format === 'BGRA8' || format === 'RGBX8' || format === 'BGRX8') {
    const n = width * height * 4;
    if (data.length < n) throw new Error(`decodeBC: ${format} data too short (${data.length} < ${n})`);
    const bgr = format[0] === 'B', noA = format[3] === 'X';
    for (let i = 0; i < n; i += 4) {
      out[i] = data[bgr ? i + 2 : i]; out[i + 1] = data[i + 1]; out[i + 2] = data[bgr ? i : i + 2];
      out[i + 3] = noA ? 255 : data[i + 3];
    }
    return out;
  }
  const bb = BLOCK_BYTES[format];
  if (!bb) throw new Error(`decodeBC: unsupported format ${format}`);
  const bw = (width + 3) >> 2, bh = (height + 3) >> 2;
  if (data.length < bw * bh * bb) throw new Error(`decodeBC: ${format} data too short (${data.length} < ${bw * bh * bb})`);
  const blk = BLK;
  if (format === 'BC4') for (let i = 0; i < 16; i++) blk[i * 4 + 3] = 255;
  if (format === 'BC5') for (let i = 0; i < 16; i++) { blk[i * 4 + 2] = 0; blk[i * 4 + 3] = 255; }
  const out32 = new Uint32Array(out.buffer), blk32 = BLK32;
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += bb) {
      switch (format) {
        case 'BC7': decodeBC7Block(data, o, blk); break;
        case 'BC1': bc1Block(data, o, blk, false); break;
        case 'BC3': bc1Block(data, o + 8, blk, true); alphaBlock(data, o, blk, 3); break;
        case 'BC2': {
          bc1Block(data, o + 8, blk, true);
          for (let i = 0; i < 16; i++) { const a = (data[o + (i >> 1)] >> ((i & 1) * 4)) & 15; blk[i * 4 + 3] = a | (a << 4); }
          break;
        }
        case 'BC4':
          alphaBlock(data, o, blk, 0);
          for (let i = 0; i < 64; i += 4) blk[i + 1] = blk[i + 2] = blk[i];
          break;
        case 'BC5': alphaBlock(data, o, blk, 0); alphaBlock(data, o + 8, blk, 1); break;
      }
      // copy block into image (clipping partial edge blocks)
      const x0 = bx * 4, y0 = by * 4;
      const cw = Math.min(4, width - x0), ch = Math.min(4, height - y0);
      for (let py = 0; py < ch; py++) {
        const d = (y0 + py) * width + x0, s = py * 4;
        for (let k = 0; k < cw; k++) out32[d + k] = blk32[s + k];
      }
    }
  }
  return out;
}
