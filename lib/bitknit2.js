// BitKnit2 decompressor (Granny 2.11 section compression used by Baldur's Gate 3 .GR2 models).
// JavaScript port of rans.h from pybg3 (https://github.com/eiz/pybg3), Copyright (C) 2024 Mackenzie
// Straight, MIT License. See THIRD_PARTY_NOTICES.md. Format notes: libbg3/docs/bitknit2.txt.
const MAGIC = 0x75B1;

class Model {
  // deferred_adaptive_model<uint16_t, 1024, vocab, minProbable, 15, 10>
  constructor(vocab, minProbable) {
    this.vocab = vocab;
    const FB = 15, total = 1 << FB, interval = 1024;
    this.incr = Math.floor((total - vocab) / interval);
    this.lastIncr = 1 + total - vocab - this.incr * interval;
    this.sums = new Uint16Array(vocab + 1);
    this.acc = new Uint16Array(vocab).fill(1);
    this.lookup = new Uint16Array(1 << 10);
    this.counter = 0;
    const eq = vocab - minProbable;
    for (let i = 0; i < eq; i++) this.sums[i] = Math.floor((total - minProbable) * i / eq);
    for (let i = eq; i <= vocab; i++) this.sums[i] = total - vocab + i;
    this.finish();
  }
  finish() {
    const shift = 5;               // 15 - 10
    let code = 0, sym = 0, next = this.sums[1];
    const lim = 1 << 15, sums = this.sums, lookup = this.lookup;
    while (code < lim) {
      if (code < next) { lookup[code >> shift] = sym; code += 1 << shift; }
      else { sym++; next = sums[sym + 1]; }
    }
  }
  find(code) {
    let sym = this.lookup[code >> 5];
    const sums = this.sums;
    while (code >= sums[sym + 1]) sym++;
    return sym;
  }
  observe(symbol) {
    this.acc[symbol] = (this.acc[symbol] + this.incr) & 0xFFFF;
    this.counter = (this.counter + 1) % 1024;
    if (this.counter === 0) {
      this.acc[symbol] = (this.acc[symbol] + this.lastIncr) & 0xFFFF;
      let sum = 0;
      const sums = this.sums, acc = this.acc;
      for (let i = 1; i <= this.vocab; i++) {
        sum += acc[i - 1];
        // C does (uint32 sum - sums[i]) / 2 in unsigned 32-bit math and truncates to 16 bits,
        // which works out to floor division of the signed difference.
        const d = sum - sums[i];
        sums[i] = (sums[i] + Math.floor(d / 2)) & 0xFFFF;
        acc[i - 1] = 1;
      }
      this.finish();
    }
  }
}

/**
 * Decompress one BitKnit2 stream.
 * @param {Uint8Array} src compressed bytes (starts with the 0x75B1 magic word)
 * @param {number} outLen  uncompressed length
 */
export function bitknit2Decompress(src, outLen) {
  const dst = new Uint8Array(outLen);
  if (outLen === 0) return dst;
  // the stream is little-endian 16-bit words
  const nWords = src.length >> 1;
  const words = new Uint16Array(nWords);
  for (let i = 0; i < nWords; i++) words[i] = src[2 * i] | (src[2 * i + 1] << 8);
  let sp = 0;
  const pop = () => { if (sp >= nWords) throw new Error('bitknit2: unexpected end of stream'); return words[sp++]; };
  if (words[0] !== MAGIC) throw new Error('bitknit2: bad magic');
  sp = 1;

  const cmdModels = [0, 1, 2, 3].map(() => new Model(300, 36));
  const cacheModels = [0, 1, 2, 3].map(() => new Model(40, 0));
  const offsetModel = new Model(21, 0);
  const cache = new Uint32Array(8).fill(1);
  let order = 0x76543210 >>> 0;
  let delta = 1;
  // two interleaved rANS states (32-bit, refilled 16 bits at a time)
  let s1 = 0, s2 = 0;

  const refill = (s) => (s < 0x10000 ? ((s * 65536) + pop()) >>> 0 : s);
  const popBits = (n) => {      // pops from s1 then swaps states
    const v = s1 & ((1 << n) - 1);
    let s = s1 >>> n;
    s = refill(s);
    s1 = s2; s2 = s;
    return v;
  };
  const popModel = (m) => {
    const code = s1 & 0x7FFF;
    const sym = m.find(code);
    const freq = m.sums[sym + 1] - m.sums[sym];
    let s = ((s1 >>> 15) * freq + code - m.sums[sym]) >>> 0;
    s = refill(s);
    m.observe(sym);
    s1 = s2; s2 = s;
    return sym;
  };
  const cacheHit = (index) => {
    const slot = (order >>> (index * 4)) & 15;
    const mask = index === 7 ? 0xFFFFFFFF : ((16 << (index * 4)) - 1) >>> 0;
    const rotated = (((order << 4) | slot) & mask) >>> 0;
    order = ((order & ~mask) | rotated) >>> 0;
    return cache[slot];
  };
  const cacheInsert = (value) => {
    cache[order >>> 28] = cache[(order >>> 24) & 15];
    cache[(order >>> 24) & 15] = value;
  };

  let o = 0;
  while (o < outLen) {
    if (sp >= nWords) throw new Error('bitknit2: truncated');
    const boundary = Math.min(outLen, (Math.floor(o / 0x10000) * 0x10000) + 0x10000);
    if (words[sp] === 0) {            // raw quantum
      sp++;
      const len = Math.min((nWords - sp) * 2, boundary - o);
      dst.set(src.subarray(sp * 2, sp * 2 + len), o);
      o += len; sp += len >> 1;
      continue;
    }
    // initial state ("tying the knot")
    const i0 = pop(), i1 = pop();
    let merged = ((i0 << 16) | i1) >>> 0;
    const split = merged & 15;
    merged = refill(merged >>> 4);
    s1 = refill(merged >>> split);
    s2 = (((merged << 16) >>> 0) | pop()) >>> 0;
    s2 = (s2 & (((2 ** (16 + split)) - 1) >>> 0)) >>> 0;
    s2 = (s2 | (2 ** (16 + split))) >>> 0;

    if (o === 0) dst[o++] = popBits(8);
    while (o < boundary) {
      const mi = o & 3;
      const cmd = popModel(cmdModels[mi]);
      if (cmd < 256) {
        dst[o] = (cmd + dst[o - delta]) & 0xFF;
        o++;
        continue;
      }
      let len;
      if (cmd < 288) len = cmd - 254;
      else {
        const ll = cmd - 287;
        len = (1 << ll) + popBits(ll) + 32;
      }
      let off;
      const ref = popModel(cacheModels[mi]);
      if (ref < 8) off = cacheHit(ref);
      else {
        const ol = popModel(offsetModel);
        let bits = popBits(ol % 16);
        if (ol >= 16) bits = ((bits * 65536) + pop()) >>> 0;
        off = ((32 * 2 ** ol) + bits * 32 - 32 + (ref - 7)) >>> 0;
        cacheInsert(off);
      }
      if (off > o) throw new Error('bitknit2: invalid copy offset');
      if (len > outLen - o) throw new Error('bitknit2: invalid copy length');
      delta = off;
      for (let k = 0; k < len; k++, o++) dst[o] = dst[o - off];
    }
    if (s1 !== 0x10000 || s2 !== 0x10000) throw new Error('bitknit2: stream corrupted');
  }
  return dst;
}
