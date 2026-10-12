// BG3's shipped .lsf files are all uncompressed (flags 0; the .pak entry itself is LZ4-compressed). This test
// re-packs a real LSF with compressed sections, the way LSLib writes them, to exercise the other code paths:
//   LZ4: strings section = raw LZ4 block, the other sections = LZ4 frame (independent and linked blocks)
//   zlib: every section zlib-wrapped deflate (needs parseLSFAsync)
// Usage: node test/lsf-compress-test.mjs [file.lsf]
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { parseLSF, parseLSFAsync } from '../lib/lsf.js';

const file = process.argv[2] || 'C:/Users/castro/Documents/BG3Catalog/extract/Shared/Public/Shared/Content/Assets/Atmospheres/[PAK]_Atmospheres/_merged.lsf';
const src = new Uint8Array(readFileSync(file));

// Greedy hash-chain-free LZ4 block compressor (test only). `hist` = bytes before `start` usable for matches.
function lz4Compress(buf, start, end, histStart) {
  const out = [];
  const table = new Map();
  let anchor = start, i = start;
  const emit = (litEnd, matchLen, off) => {
    const lit = litEnd - anchor;
    const ml = matchLen ? matchLen - 4 : 0;
    out.push(((lit >= 15 ? 15 : lit) << 4) | (matchLen ? (ml >= 15 ? 15 : ml) : 0));
    if (lit >= 15) { let n = lit - 15; while (n >= 255) { out.push(255); n -= 255; } out.push(n); }
    for (let k = anchor; k < litEnd; k++) out.push(buf[k]);
    if (matchLen) {
      out.push(off & 255, off >> 8);
      if (ml >= 15) { let n = ml - 15; while (n >= 255) { out.push(255); n -= 255; } out.push(n); }
    }
  };
  for (let k = histStart; k + 4 <= start; k++) table.set(buf[k] | buf[k + 1] << 8 | buf[k + 2] << 16 | buf[k + 3] << 24, k);
  while (i + 12 < end) {
    const key = buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24;
    const cand = table.get(key);
    table.set(key, i);
    if (cand !== undefined && i - cand < 65536 && cand >= histStart) {
      let len = 4;
      while (i + len < end - 5 && buf[cand + len] === buf[i + len]) len++;
      emit(i, len, i - cand);
      i += len; anchor = i;
    } else i++;
  }
  emit(end, 0, 0);
  return Uint8Array.from(out);
}

function lz4Frame(data, linked) {
  const BLOCK = 65536;
  const parts = [Uint8Array.of(0x04, 0x22, 0x4D, 0x18, linked ? 0x40 : 0x60, 0x40, 0x00)];
  for (let s = 0; s < data.length; s += BLOCK) {
    const e = Math.min(data.length, s + BLOCK);
    const c = lz4Compress(data, s, e, linked ? Math.max(0, s - 65536) : s);
    const raw = c.length >= e - s;
    const hdr = new Uint8Array(4);
    new DataView(hdr.buffer).setUint32(0, raw ? ((e - s) | 0x80000000) >>> 0 : c.length, true);
    parts.push(hdr, raw ? data.subarray(s, e) : c);
  }
  parts.push(new Uint8Array(4));
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function repack(bytes, method, compress) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== 7) throw new Error('expects LSOF v7');
  const m = (i) => dv.getUint32(16 + 4 * i, true);
  // v6+ metadata order: strings(U,D) keys(U,D) nodes(U,D) attrs(U,D) values(U,D); on-disk order strings,nodes,attrs,values,keys
  const sizes = { strings: m(0), keys: m(2), nodes: m(4), attrs: m(6), values: m(8) };
  const fmt = dv.getUint32(60, true);
  let p = 64;
  const order = ['strings', 'nodes', 'attrs', 'values', ...(fmt === 1 ? ['keys'] : [])];
  const raw = {};
  for (const k of order) { raw[k] = bytes.subarray(p, p + sizes[k]); p += sizes[k]; }
  const comp = {};
  for (const k of order) comp[k] = sizes[k] ? compress(raw[k], k) : new Uint8Array(0);
  const head = bytes.slice(0, 64);
  const hv = new DataView(head.buffer);
  const slot = { strings: 0, keys: 2, nodes: 4, attrs: 6, values: 8 };
  for (const k of order) hv.setUint32(16 + 4 * (slot[k] + 1), comp[k].length, true);
  head[56] = method | 0x20;
  return concat([head, ...order.map((k) => comp[k])]);
}

const ref = parseLSF(src);
let fail = 0;
const check = (name, res, packed) => {
  const ok = isDeepStrictEqual(res, ref);
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${(packed.length / 1e6).toFixed(2)} MB packed vs ${(src.length / 1e6).toFixed(2)} MB`);
};

const lz4Independent = repack(src, 2, (d, k) => k === 'strings' ? lz4Compress(d, 0, d.length, 0) : lz4Frame(d, false));
check('LZ4 (block strings + independent frame blocks)', parseLSF(lz4Independent), lz4Independent);
const lz4Linked = repack(src, 2, (d, k) => k === 'strings' ? lz4Compress(d, 0, d.length, 0) : lz4Frame(d, true));
check('LZ4 (linked frame blocks)', parseLSF(lz4Linked), lz4Linked);
const zl = repack(src, 1, (d) => deflateSync(d));
check('zlib via parseLSFAsync', await parseLSFAsync(zl), zl);
try { parseLSF(zl); fail++; console.log('FAIL sync parseLSF accepted zlib'); }
catch (e) { console.log(`OK   sync parseLSF on zlib rejects: ${e.message}`); }
const zs = zl.slice(); zs[56] = 3;
try { parseLSF(zs); fail++; console.log('FAIL zstd accepted'); } catch (e) { console.log(`OK   zstd rejects: ${e.message}`); }
process.exitCode = fail ? 1 : 0;
