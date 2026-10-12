// LZ4 block decompression (no frame format). Used by .pak file lists and LZ4-compressed entries.
export function lz4DecompressBlock(src, outSize) {
  const dst = new Uint8Array(outSize);
  let i = 0, o = 0;
  const n = src.length;
  while (i < n) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(i, i + lit), o);
    i += lit; o += lit;
    if (i >= n) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[i++]; len += b; } while (b === 255); }
    len += 4;
    let s = o - off;
    if (off >= len) { dst.copyWithin(o, s, s + len); o += len; }
    else { for (let k = 0; k < len; k++) dst[o++] = dst[s++]; }
  }
  return o === outSize ? dst : dst.subarray(0, o);
}
