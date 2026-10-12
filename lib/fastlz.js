// FastLZ decompression (levels 1 and 2), used by Granite virtual-texture tiles ("lz77"/"fastlz0.1.0").
// Format per FastLZ by Ariya Hidayat (MIT).
export function fastlzDecompress(src, outSize) {
  const dst = new Uint8Array(outSize);
  const level = (src[0] >> 5) + 1;
  let ip = 0, op = 0;
  let ctrl = src[ip++] & 31;
  const n = src.length;
  for (;;) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      let dist;
      if (level === 1) {
        if (len === 6) len += src[ip++];
        dist = ofs + src[ip++] + 1;
      } else {
        if (len === 6) { let c; do { c = src[ip++]; len += c; } while (c === 255); }
        const c = src[ip++];
        if (c === 255 && ofs === (31 << 8)) { ofs = (src[ip++] << 8) | src[ip++]; dist = ofs + 8191 + 1; }
        else dist = ofs + c + 1;
      }
      len += 3;
      let r = op - dist;
      if (r < 0) throw new Error('fastlz: bad distance');
      for (let k = 0; k < len; k++) dst[op++] = dst[r++];
    } else {
      const lit = ctrl + 1;
      dst.set(src.subarray(ip, ip + lit), op);
      ip += lit; op += lit;
    }
    if (ip >= n) break;
    ctrl = src[ip++];
  }
  return op === outSize ? dst : dst.subarray(0, op);
}
