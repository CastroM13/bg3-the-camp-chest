// BC3 (DXT5) block image helpers: stitch blocks and decode to RGBA8.
export function bc3Decode(data, width, height) {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const col = new Uint8Array(16), alpha = new Uint8Array(8);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * 16;
    // alpha
    const a0 = data[o], a1 = data[o + 1];
    alpha[0] = a0; alpha[1] = a1;
    if (a0 > a1) for (let i = 1; i < 7; i++) alpha[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
    else { for (let i = 1; i < 5; i++) alpha[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0; alpha[6] = 0; alpha[7] = 255; }
    let abits = 0n;
    for (let i = 0; i < 6; i++) abits |= BigInt(data[o + 2 + i]) << BigInt(8 * i);
    // color (always 4-color mode in BC3)
    const c0 = data[o + 8] | (data[o + 9] << 8), c1 = data[o + 10] | (data[o + 11] << 8);
    const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
    const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;
    col.set([r0, g0, b0, 0, r1, g1, b1, 0, (2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 0, (r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 0]);
    const cbits = data[o + 12] | (data[o + 13] << 8) | (data[o + 14] << 16) | (data[o + 15] << 24);
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py;
      if (x >= width || y >= height) continue;
      const i = py * 4 + px, d = (y * width + x) * 4;
      const ci = (cbits >>> (2 * i)) & 3;
      out[d] = col[ci * 4] + 0.5; out[d + 1] = col[ci * 4 + 1] + 0.5; out[d + 2] = col[ci * 4 + 2] + 0.5;
      out[d + 3] = alpha[Number((abits >> BigInt(3 * i)) & 7n)];
    }
  }
  return out;
}

/** Copy a rectangle of 4x4 blocks between BC3 images (sizes in pixels, multiples of 4). */
export function bc3Copy(src, srcW, dst, dstW, sx, sy, dx, dy, w, h) {
  const sbw = srcW / 4, dbw = dstW / 4;
  for (let y = 0; y < h; y += 4) {
    const so = (((sy + y) / 4) * sbw + sx / 4) * 16, d0 = (((dy + y) / 4) * dbw + dx / 4) * 16;
    dst.set(src.subarray(so, so + (w / 4) * 16), d0);
  }
}
