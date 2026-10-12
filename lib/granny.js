// Granny 2 (.GR2) reader for Baldur's Gate 3 models: sections (BitKnit2-compressed), pointer fixups and the
// self-describing type tree. Layout follows libbg3 (https://github.com/eiz/libbg3, MIT, Mackenzie Straight).
import { bitknit2Decompress } from './bitknit2.js';

// 64-bit little-endian Granny magics (libbg3's, and the one BG3 ships with)
const MAGICS = new Set(['141f636f5e499be5:c4edbe90a9eb131e', 'ee8ac26fe14a2fe5:af55d7904cb4d21e']);
const DT = { end: 0, inline: 1, reference: 2, refToArray: 3, arrayOfRefs: 4, variantRef: 5, refToVariantArray: 7,
  string: 8, transform: 9, float: 10, int8: 11, uint8: 12, binormalInt8: 13, normalUint8: 14, int16: 15, uint16: 16,
  binormalInt16: 17, normalUint16: 18, int32: 19, uint32: 20, half: 21, emptyRef: 22 };
const SCALAR_SIZE = { 10: 4, 11: 1, 12: 1, 13: 1, 14: 1, 15: 2, 16: 2, 17: 2, 18: 2, 19: 4, 20: 4, 21: 2 };
const utf8 = new TextDecoder('utf-8');

function half(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export class Granny {
  constructor(bytes) {
    this.bytes = bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = `${dv.getBigUint64(0, true).toString(16).padStart(16, '0')}:${dv.getBigUint64(8, true).toString(16).padStart(16, '0')}`;
    if (!MAGICS.has(magic)) throw new Error(`not a 64-bit LE Granny file (${magic})`);
    const H = 32;
    this.version = dv.getUint32(H, true);
    if (this.version !== 7) throw new Error(`unsupported Granny version ${this.version}`);
    const sectionTable = dv.getUint32(H + 12, true), numSections = dv.getUint32(H + 16, true);
    this.rootType = { s: dv.getUint32(H + 20, true), o: dv.getUint32(H + 24, true) };
    this.rootObj = { s: dv.getUint32(H + 28, true), o: dv.getUint32(H + 32, true) };
    const headers = [];
    for (let i = 0; i < numSections; i++) {
      const b = 32 + sectionTable + i * 44;
      const r = (k) => dv.getUint32(b + k * 4, true);
      headers.push({ compression: r(0), offset: r(1), compressedLen: r(2), uncompressedLen: r(3), fixupsOffset: r(7), numFixups: r(8) });
    }
    this.sections = headers.map((h) => {
      const src = bytes.subarray(h.offset, h.offset + h.compressedLen);
      if (h.compression === 0) return new Uint8Array(src);          // copy: we may read it as typed arrays later
      if (h.compression === 4) return bitknit2Decompress(src, h.uncompressedLen);
      throw new Error(`unsupported Granny compression ${h.compression}`);
    });
    this.views = this.sections.map((s) => new DataView(s.buffer, s.byteOffset, s.byteLength));
    // pointer fixups: (section, offset) of a pointer -> (target section, target offset)
    this.ptrs = this.sections.map(() => new Map());
    headers.forEach((h, i) => {
      let fx;
      if (h.compression === 4 && h.numFixups) {
        const clen = dv.getUint32(h.fixupsOffset, true);
        fx = bitknit2Decompress(bytes.subarray(h.fixupsOffset + 4, h.fixupsOffset + 4 + clen), h.numFixups * 12);
      } else fx = bytes.subarray(h.fixupsOffset, h.fixupsOffset + h.numFixups * 12);
      const fv = new DataView(fx.buffer, fx.byteOffset, fx.byteLength);
      for (let k = 0; k < h.numFixups; k++) {
        this.ptrs[i].set(fv.getUint32(k * 12, true), { s: fv.getUint32(k * 12 + 4, true), o: fv.getUint32(k * 12 + 8, true) });
      }
    });
    this.cache = new Map();
  }

  ptr(loc) { return this.ptrs[loc.s].get(loc.o) || null; }
  u32(loc, d = 0) { return this.views[loc.s].getUint32(loc.o + d, true); }
  i32(loc, d = 0) { return this.views[loc.s].getInt32(loc.o + d, true); }
  cstr(loc) {
    if (!loc) return null;
    const s = this.sections[loc.s];
    let e = loc.o; while (e < s.length && s[e]) e++;
    return utf8.decode(s.subarray(loc.o, e));
  }

  /** member list of a struct type */
  members(typeLoc) {
    const key = `t${typeLoc.s}:${typeLoc.o}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const out = [];
    for (let i = 0; ; i++) {
      const at = { s: typeLoc.s, o: typeLoc.o + i * 44 };
      const type = this.u32(at);
      if (type === DT.end) break;
      out.push({ type, name: this.cstr(this.ptr({ s: at.s, o: at.o + 4 })), ref: this.ptr({ s: at.s, o: at.o + 12 }), count: this.u32(at, 20) });
    }
    this.cache.set(key, out);
    return out;
  }

  sizeOf(typeLoc) {
    const key = `z${typeLoc.s}:${typeLoc.o}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let size = 0;
    for (const m of this.members(typeLoc)) size += this.memberSize(m);
    this.cache.set(key, size);
    return size;
  }

  memberSize(m) {
    const n = Math.max(1, m.count);
    switch (m.type) {
      case DT.inline: return this.sizeOf(m.ref) * n;
      case DT.reference: case DT.string: case DT.emptyRef: return 8 * n;
      case DT.refToArray: case DT.arrayOfRefs: return 12 * n;
      case DT.variantRef: return 16 * n;
      case DT.refToVariantArray: return 20 * n;
      case DT.transform: return 68 * n;
      default: return (SCALAR_SIZE[m.type] || 0) * n;
    }
  }

  readScalar(type, loc) {
    const v = this.views[loc.s], o = loc.o;
    switch (type) {
      case DT.float: return v.getFloat32(o, true);
      case DT.int8: case DT.binormalInt8: return v.getInt8(o);
      case DT.uint8: case DT.normalUint8: return v.getUint8(o);
      case DT.int16: case DT.binormalInt16: return v.getInt16(o, true);
      case DT.uint16: case DT.normalUint16: return v.getUint16(o, true);
      case DT.int32: return v.getInt32(o, true);
      case DT.uint32: return v.getUint32(o, true);
      case DT.half: return half(v.getUint16(o, true));
      default: return null;
    }
  }

  /** Read a struct instance into a plain object. Arrays of structs become arrays of objects. */
  read(typeLoc, loc, depth = 0) {
    if (!typeLoc || !loc) return null;
    const key = `o${typeLoc.s}:${typeLoc.o}@${loc.s}:${loc.o}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const obj = {};
    this.cache.set(key, obj);
    let off = 0;
    for (const m of this.members(typeLoc)) {
      const at = { s: loc.s, o: loc.o + off };
      const n = m.count;
      const one = (a) => this.readMember(m, a, depth);
      if (n > 0 && (SCALAR_SIZE[m.type] || m.type === DT.inline)) {
        const step = m.type === DT.inline ? this.sizeOf(m.ref) : SCALAR_SIZE[m.type];
        obj[m.name] = Array.from({ length: n }, (_, i) => one({ s: at.s, o: at.o + i * step }));
      } else obj[m.name] = one(at);
      off += this.memberSize(m);
    }
    return obj;
  }

  readMember(m, at, depth) {
    switch (m.type) {
      case DT.inline: return this.read(m.ref, at, depth + 1);
      case DT.reference: return this.read(m.ref, this.ptr(at), depth + 1);
      case DT.string: return this.cstr(this.ptr(at));
      case DT.emptyRef: return null;
      case DT.refToArray: {
        const count = this.i32(at), p = this.ptr({ s: at.s, o: at.o + 4 });
        if (!p || !count) return [];
        const step = this.sizeOf(m.ref);
        return Array.from({ length: count }, (_, i) => this.read(m.ref, { s: p.s, o: p.o + i * step }, depth + 1));
      }
      case DT.arrayOfRefs: {
        const count = this.i32(at), p = this.ptr({ s: at.s, o: at.o + 4 });
        if (!p || !count) return [];
        return Array.from({ length: count }, (_, i) => this.read(m.ref, this.ptr({ s: p.s, o: p.o + i * 8 }), depth + 1));
      }
      case DT.variantRef: {
        const t = this.ptr(at), p = this.ptr({ s: at.s, o: at.o + 8 });
        return t && p ? this.read(t, p, depth + 1) : null;
      }
      case DT.refToVariantArray: {
        const t = this.ptr(at), count = this.i32(at, 8), p = this.ptr({ s: at.s, o: at.o + 12 });
        if (!t || !p || !count) return { type: t, count: 0, loc: p, items: [] };
        // keep raw location so large vertex arrays can be decoded without per-vertex objects
        return { type: t, count, loc: p, stride: this.sizeOf(t), members: this.members(t) };
      }
      case DT.transform: {
        const v = this.views[at.s], o = at.o, f = (k) => v.getFloat32(o + 4 + k * 4, true);
        return { flags: v.getUint32(o, true), translation: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5), f(6)],
          scaleShear: [f(7), f(8), f(9), f(10), f(11), f(12), f(13), f(14), f(15)] };
      }
      default: return this.readScalar(m.type, at);
    }
  }

  root() { return this.read(this.rootType, this.rootObj); }
}

export { DT };
