// Larian LSF (LSOF) binary resource reader and LOCA localization reader.
// Pure ES module: no DOM, no Node APIs. Ported from LSLib (MIT): LSFReader.cs, LSFCommon.cs, Localization.cs.
//
// parseLSF(bytes)       -> { version, engineVersion, regions: { [regionName]: Node } }   (sync)
// parseLSFAsync(bytes)  -> Promise<same>  also handles zlib-compressed sections (DecompressionStream)
// parseLoca(bytes)      -> Map<handle, text>
// parseLocaEntries(bytes) -> [{ handle, version, text }]
// formatAttr(attr)      -> the value text Divine/LSLib writes into .lsx for that attribute
//
// Node = { id, attrs: { [name]: Attr }, children: Node[], key? }
//   children are in LSX order: LSLib groups a node's children by name (in order of first appearance of each
//   name), keeping file order within a group.
// Attr = { type, value, handle?, version?, arguments? }
//   ints/floats -> number (float = shortest decimal that round-trips the float32), bool -> true/false,
//   64-bit ints -> number when |v| <= 2^53-1, otherwise the exact decimal string,
//   strings -> string, vectors -> "x y z" (LSLib text), matrices -> row-major space-joined full-precision floats
//   (LSX itself prints them with 2 decimals, see formatAttr), guid -> lowercase LSLib (byte-swapped) text,
//   TranslatedString -> value = handle, plus handle/version, TranslatedFSString -> same plus arguments,
//   ScratchBuffer -> Uint8Array (LSX shows base64).

export const AttrType = {
  None: 0, Byte: 1, Short: 2, UShort: 3, Int: 4, UInt: 5, Float: 6, Double: 7,
  IVec2: 8, IVec3: 9, IVec4: 10, Vec2: 11, Vec3: 12, Vec4: 13,
  Mat2: 14, Mat3: 15, Mat3x4: 16, Mat4x3: 17, Mat4: 18, Bool: 19,
  String: 20, Path: 21, FixedString: 22, LSString: 23, ULongLong: 24, ScratchBuffer: 25,
  Long: 26, Int8: 27, TranslatedString: 28, WString: 29, LSWString: 30, UUID: 31, Int64: 32,
  TranslatedFSString: 33,
};

/** LSX type names (LSLib AttributeTypeMaps.IdToType), index = type id. */
export const AttrTypeNames = [
  'None', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'float', 'double',
  'ivec2', 'ivec3', 'ivec4', 'fvec2', 'fvec3', 'fvec4',
  'mat2x2', 'mat3x3', 'mat3x4', 'mat4x3', 'mat4x4', 'bool',
  'string', 'path', 'FixedString', 'LSString', 'uint64', 'ScratchBuffer',
  'old_int64', 'int8', 'TranslatedString', 'WString', 'LSWString', 'guid', 'int64', 'TranslatedFSString',
];

// [columns, rows] for vector/matrix types (LSLib GetColumns/GetRows)
const SHAPE = {
  8: [2, 1], 9: [3, 1], 10: [4, 1], 11: [2, 1], 12: [3, 1], 13: [4, 1],
  14: [2, 2], 15: [3, 3], 16: [4, 3], 17: [3, 4], 18: [4, 4],
};

const utf8 = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ strings */

function decodeStr(u8, start, end) {
  const len = end - start;
  if (len <= 0) return '';
  if (len < 128) {
    let ascii = true;
    for (let i = start; i < end; i++) if (u8[i] & 0x80) { ascii = false; break; }
    if (ascii) return String.fromCharCode.apply(null, u8.subarray(start, end));
  }
  return utf8.decode(u8.subarray(start, end));
}

/* ------------------------------------------------------------------ number formatting (.NET Core style) */

// .NET Core 3.0+ ToString() of float/double: shortest round-trip digits, "G" layout where scientific notation is
// used when the decimal exponent exceeds max(digitCount, 7 for float / 15 for double) or the value is < 1e-4.
function netLayout(neg, digits, exp10, minPrec) {
  // value = 0.d1d2d3... * 10^digPos
  const digPos = exp10 + 1;
  const nd = digits.length;
  let s;
  if (digPos > Math.max(nd, minPrec) || digPos < -3) {
    const e = digPos - 1;
    s = digits[0] + (nd > 1 ? '.' + digits.slice(1) : '') + 'E' + (e < 0 ? '-' : '+') + (Math.abs(e) < 10 ? '0' : '') + Math.abs(e);
  } else if (digPos <= 0) {
    s = '0.' + '0'.repeat(-digPos) + digits;
  } else if (digPos >= nd) {
    s = digits + '0'.repeat(digPos - nd);
  } else {
    s = digits.slice(0, digPos) + '.' + digits.slice(digPos);
  }
  return neg ? '-' + s : s;
}

function splitExp(str) {
  // str from toExponential: "-d.ddde+x"
  let neg = false, i = 0;
  if (str[0] === '-') { neg = true; i = 1; }
  const e = str.indexOf('e');
  let digits = str.slice(i, e).replace('.', '');
  let k = digits.length; while (k > 1 && digits[k - 1] === '0') k--;
  digits = digits.slice(0, k);
  return [neg, digits, +str.slice(e + 1)];
}

/** Shortest decimal string (JS syntax) that round-trips the float32 value f. */
function shortestF32(f) {
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  if (Number.isInteger(f) && Math.abs(f) < 1e7) return String(f);
  if (!Number.isFinite(f)) return String(f);
  // round-tripping is monotonic in the digit count: binary search the smallest p in 1..9
  let lo = 1, hi = 9, best = null; // invariant: hi digits round-trip; best = toPrecision(hi) once computed
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = f.toPrecision(mid);
    if (Math.fround(+s) === f) { hi = mid; best = s; } else lo = mid + 1;
  }
  return tieToEven(f, hi, best ?? f.toPrecision(hi));
}

// Cache of float32 bit pattern -> .NET text. Game data repeats a lot of float values.
let f32Cache = new Map();
function f32Text(bits, f) {
  let s = f32Cache.get(bits);
  if (s === undefined) {
    if (f32Cache.size > 262144) f32Cache = new Map();
    s = formatFloat(f);
    f32Cache.set(bits, s);
  }
  return s;
}

// JS toPrecision rounds an exact decimal tie away from zero; .NET's shortest formatting picks the even digit
// (e.g. -3.45703125 -> .NET "-3.4570312", JS "-3.4570313").
function tieToEven(f, p, s) {
  const x = f.toExponential(p); // p+1 significant digits
  const e = x.indexOf('e');
  if (x[e - 1] !== '5' || +x !== f) return s; // not an exact tie
  const t = x.slice(0, e - 1) + x.slice(e); // truncated candidate (one unit smaller in magnitude)
  const lastDigit = x[e - 2] === '.' ? x[e - 3] : x[e - 2];
  if ((+lastDigit) % 2 === 0 && Math.fround(+t) === f) return String(+t);
  return s;
}

/** .NET text of a float32 value (as LSLib writes it into LSX). */
export function formatFloat(f) {
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  if (Number.isNaN(f)) return 'NaN';
  if (!Number.isFinite(f)) return f > 0 ? '∞' : '-∞';
  if (Number.isInteger(f) && Math.abs(f) < 1e7) return String(f);
  const [neg, digits, e] = splitExp((+shortestF32(f)).toExponential());
  return netLayout(neg, digits, e, 7);
}

/** .NET text of a double value. */
export function formatDouble(d) {
  if (d === 0) return Object.is(d, -0) ? '-0' : '0';
  if (Number.isNaN(d)) return 'NaN';
  if (!Number.isFinite(d)) return d > 0 ? '∞' : '-∞';
  const [neg, digits, e] = splitExp(d.toExponential());
  return netLayout(neg, digits, e, 15);
}

// number whose shortest JS text is the float32's shortest text (e.g. 0.1 rather than 0.10000000149011612)
let f32NumCache = new Map();
function float32Value(dv, p) {
  const bits = dv.getUint32(p, true);
  let v = f32NumCache.get(bits);
  if (v === undefined) {
    const f = dv.getFloat32(p, true);
    v = Number.isFinite(f) ? +shortestF32(f) : f;
    if (f32NumCache.size > 262144) f32NumCache = new Map();
    f32NumCache.set(bits, v);
  }
  return v;
}

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));

function guidText(u8, o) {
  // System.Guid(bytes) layout (LE Data1/2/3) followed by LSLib's ByteSwapGuid (swap pairs in bytes 8..15)
  const h = HEX;
  return h[u8[o + 3]] + h[u8[o + 2]] + h[u8[o + 1]] + h[u8[o]] + '-' +
    h[u8[o + 5]] + h[u8[o + 4]] + '-' + h[u8[o + 7]] + h[u8[o + 6]] + '-' +
    h[u8[o + 9]] + h[u8[o + 8]] + '-' + h[u8[o + 11]] + h[u8[o + 10]] +
    h[u8[o + 13]] + h[u8[o + 12]] + h[u8[o + 15]] + h[u8[o + 14]];
}

function int64Value(big) {
  const n = Number(big);
  return Number.isSafeInteger(n) ? n : big.toString();
}

/* ------------------------------------------------------------------ decompression */

/** Decode one LZ4 block from src[s..sEnd) into dst at o (history in dst before o is usable). Returns new o. */
function lz4BlockInto(src, s, sEnd, dst, o) {
  const dEnd = dst.length;
  while (s < sEnd) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    if (lit) {
      if (o + lit > dEnd || s + lit > sEnd) throw new Error('LSF: corrupt LZ4 data (literal overrun)');
      dst.set(src.subarray(s, s + lit), o); s += lit; o += lit;
    }
    if (s >= sEnd) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    let r = o - off;
    if (off === 0 || r < 0 || o + len > dEnd) throw new Error('LSF: corrupt LZ4 data (bad match)');
    if (off >= len) { dst.copyWithin(o, r, r + len); o += len; }
    else { for (let k = 0; k < len; k++) dst[o++] = dst[r++]; }
  }
  return o;
}

function lz4Block(src, size) {
  const dst = new Uint8Array(size);
  const o = lz4BlockInto(src, 0, src.length, dst, 0);
  if (o !== size) throw new Error(`LSF: LZ4 block size mismatch (expected ${size}, got ${o})`);
  return dst;
}

/** LZ4 frame format (what LSLib's LZ4Stream writes for "chunked" LSF sections). */
function lz4Frame(src, size) {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.length < 7 || dv.getUint32(0, true) !== 0x184D2204) throw new Error('LSF: bad LZ4 frame magic');
  const flg = src[4];
  if ((flg >> 6) !== 1) throw new Error('LSF: unsupported LZ4 frame version');
  let s = 6; // FLG, BD
  if (flg & 0x08) s += 8; // content size
  if (flg & 0x01) s += 4; // dictionary id
  s += 1; // header checksum
  const blockChecksum = !!(flg & 0x10);
  const dst = new Uint8Array(size);
  let o = 0;
  while (s + 4 <= src.length) {
    const word = dv.getUint32(s, true); s += 4;
    if (word === 0) break; // end mark
    const bsize = word & 0x7FFFFFFF;
    if (s + bsize > src.length) throw new Error('LSF: truncated LZ4 frame');
    if (word & 0x80000000) {
      if (o + bsize > size) throw new Error('LSF: LZ4 frame larger than expected');
      dst.set(src.subarray(s, s + bsize), o); o += bsize;
    } else {
      o = lz4BlockInto(src, s, s + bsize, dst, o);
    }
    s += bsize;
    if (blockChecksum) s += 4;
  }
  if (o !== size) throw new Error(`LSF: LZ4 frame size mismatch (expected ${size}, got ${o})`);
  return dst;
}

async function inflateZlib(src) {
  if (typeof DecompressionStream === 'undefined') throw new Error('LSF: zlib section but DecompressionStream is unavailable');
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ LSF header / sections */

const METHOD_NAMES = ['none', 'zlib', 'LZ4', 'zstd'];

function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseLSF: expected a Uint8Array');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || dv.getUint32(0, true) !== 0x464F534C) throw new Error('LSF: not an LSOF file (bad signature)');
  const version = dv.getUint32(4, true);
  if (version < 4 || version > 7) throw new Error(`LSF: unsupported LSOF version ${version} (supported: 4-7, BG3 uses 7)`);
  let p = 8, engineVersion;
  if (version >= 5) { engineVersion = dv.getBigInt64(p, true); p += 8; } else { engineVersion = BigInt(dv.getInt32(p, true)); p += 4; }
  const u = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const m = {};
  m.stringsU = u(); m.stringsD = u();
  if (version >= 6) { m.keysU = u(); m.keysD = u(); } else { m.keysU = 0; m.keysD = 0; }
  m.nodesU = u(); m.nodesD = u(); m.attrsU = u(); m.attrsD = u(); m.valuesU = u(); m.valuesD = u();
  m.flags = bytes[p]; p += 4; // flags u8, unknown u8, unknown u16
  m.format = u();
  const method = m.flags & 0x0F;
  if (method > 3) throw new Error(`LSF: unknown compression method ${method}`);
  return { dv, version, engineVersion, meta: m, method, dataStart: p };
}

/** Slices (raw, still compressed) the five sections in on-disk order. */
function sliceSections(bytes, h) {
  const m = h.meta;
  let p = h.dataStart;
  const out = {};
  const take = (name, uSize, dSize, chunked) => {
    if (dSize === 0 && uSize === 0) { out[name] = { data: new Uint8Array(0), raw: true }; return; }
    const raw = dSize === 0 || h.method === 0;
    const n = raw ? uSize : dSize;
    if (p + n > bytes.length) throw new Error(`LSF: truncated file (${name} section)`);
    out[name] = { data: bytes.subarray(p, p + n), raw, uSize, chunked };
    p += n;
  };
  take('strings', m.stringsU, m.stringsD, false);
  take('nodes', m.nodesU, m.nodesD, true);
  take('attrs', m.attrsU, m.attrsD, true);
  take('values', m.valuesU, m.valuesD, true);
  if (m.format === 1) take('keys', m.keysU, m.keysD, true);
  return out;
}

function decompressSync(sec, h) {
  if (sec.raw) return sec.data;
  const chunked = sec.chunked && h.version >= 2;
  switch (h.method) {
    case 2: return chunked ? lz4Frame(sec.data, sec.uSize) : lz4Block(sec.data, sec.uSize);
    case 1: throw new Error('LSF: section is zlib-compressed; use parseLSFAsync()');
    default: throw new Error(`LSF: unsupported compression method ${METHOD_NAMES[h.method]}`);
  }
}

async function decompressAsync(sec, h) {
  if (!sec.raw && h.method === 1) {
    const out = await inflateZlib(sec.data);
    if (out.length !== sec.uSize) throw new Error(`LSF: zlib size mismatch (expected ${sec.uSize}, got ${out.length})`);
    return out;
  }
  return decompressSync(sec, h);
}

/* ------------------------------------------------------------------ core */

function u8dv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

function readNames(s) {
  const dv = u8dv(s);
  const names = [];
  let p = 0;
  const nHash = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < nHash; i++) {
    const n = dv.getUint16(p, true); p += 2;
    const chain = new Array(n);
    for (let j = 0; j < n; j++) {
      const len = dv.getUint16(p, true); p += 2;
      chain[j] = decodeStr(s, p, p + len); p += len;
    }
    names.push(chain);
  }
  return names;
}

function nameAt(names, packed) {
  const chain = names[packed >>> 16];
  const s = chain && chain[packed & 0xFFFF];
  if (s === undefined) throw new Error(`LSF: bad name reference ${packed >>> 16}/${packed & 0xFFFF}`);
  return s;
}

function build(h, sec) {
  const names = readNames(sec.strings);
  const adjacency = h.version >= 3 && h.meta.format === 1; // KeysAndAdjacency -> V3 node/attribute entries

  // nodes
  const nd = u8dv(sec.nodes);
  const nodeSize = adjacency ? 16 : 12;
  const nNodes = Math.floor(sec.nodes.length / nodeSize);
  const nParent = new Int32Array(nNodes), nFirst = new Int32Array(nNodes), nName = new Uint32Array(nNodes);
  for (let i = 0, p = 0; i < nNodes; i++, p += nodeSize) {
    nName[i] = nd.getUint32(p, true);
    if (adjacency) { nParent[i] = nd.getInt32(p + 4, true); nFirst[i] = nd.getInt32(p + 12, true); }
    else { nFirst[i] = nd.getInt32(p + 4, true); nParent[i] = nd.getInt32(p + 8, true); }
  }

  // attributes
  const ad = u8dv(sec.attrs);
  const attrSize = adjacency ? 16 : 12;
  const nAttrs = Math.floor(sec.attrs.length / attrSize);
  const aName = new Uint32Array(nAttrs), aType = new Uint8Array(nAttrs), aLen = new Uint32Array(nAttrs);
  const aOff = new Uint32Array(nAttrs), aNext = new Int32Array(nAttrs).fill(-1);
  if (adjacency) {
    for (let i = 0, p = 0; i < nAttrs; i++, p += 16) {
      aName[i] = ad.getUint32(p, true);
      const tl = ad.getUint32(p + 4, true);
      aType[i] = tl & 0x3F; aLen[i] = tl >>> 6;
      aNext[i] = ad.getInt32(p + 8, true);
      aOff[i] = ad.getUint32(p + 12, true);
    }
  } else {
    const lastByNode = new Map(); // nodeIndex -> last attribute index
    let off = 0;
    for (let i = 0, p = 0; i < nAttrs; i++, p += 12) {
      aName[i] = ad.getUint32(p, true);
      const tl = ad.getUint32(p + 4, true);
      aType[i] = tl & 0x3F; aLen[i] = tl >>> 6;
      const node = ad.getInt32(p + 8, true);
      aOff[i] = off; off += aLen[i];
      const prev = lastByNode.get(node);
      if (prev !== undefined) aNext[prev] = i;
      lastByNode.set(node, i);
    }
  }

  // keys
  const keys = sec.keys && sec.keys.length ? new Map() : null;
  if (keys) {
    const kd = u8dv(sec.keys);
    for (let p = 0; p + 8 <= sec.keys.length; p += 8) keys.set(kd.getUint32(p, true), nameAt(names, kd.getUint32(p + 4, true)));
  }

  const vals = sec.values, vdv = u8dv(vals);
  const ctx = { u8: vals, dv: vdv, p: 0, version: h.version };

  // node instances
  const nodes = new Array(nNodes);
  const regions = {};
  let multiChild = null;
  for (let i = 0; i < nNodes; i++) {
    const node = { id: nameAt(names, nName[i]), attrs: {}, children: [] };
    if (keys && keys.has(i)) node.key = keys.get(i);
    let a = nFirst[i], guard = 0;
    while (a !== -1) {
      if (a >= nAttrs || ++guard > nAttrs) throw new Error('LSF: bad attribute chain');
      ctx.p = aOff[a];
      if (ctx.p + aLen[a] > vals.length) throw new Error('LSF: attribute value out of range');
      node.attrs[nameAt(names, aName[a])] = readAttr(aType[a], aLen[a], ctx);
      a = aNext[a];
    }
    nodes[i] = node;
    const parent = nParent[i];
    if (parent === -1) regions[node.id] = node;
    else {
      if (parent < 0 || parent >= i) throw new Error('LSF: node parent index out of order');
      const pc = nodes[parent].children;
      if (pc.length === 1) (multiChild || (multiChild = [])).push(parent);
      pc.push(node);
    }
  }

  // LSLib stores children in Dictionary<name, List<Node>>: group by name, first-appearance order.
  if (multiChild) for (const idx of multiChild) {
    const ch = nodes[idx].children;
    let sorted = true;
    const seen = new Set();
    for (let j = 0; j < ch.length; j++) {
      const id = ch[j].id;
      if (j && id !== ch[j - 1].id) { if (seen.has(id)) { sorted = false; break; } }
      seen.add(id);
    }
    if (sorted) continue;
    const groups = new Map();
    for (const c of ch) { const g = groups.get(c.id); if (g) g.push(c); else groups.set(c.id, [c]); }
    let k = 0;
    for (const g of groups.values()) for (const c of g) ch[k++] = c;
  }

  return { version: h.version, engineVersion: h.engineVersion, regions };
}

function readFixedStr(ctx, len) {
  // len includes the null terminator; trailing nulls are dropped (LSLib ReadString)
  const u8 = ctx.u8, s = ctx.p;
  if (len === 0) return '';
  let e = s + len - 1;
  if (u8[e] !== 0) throw new Error('LSF: string is not null-terminated');
  while (e > s && u8[e - 1] === 0) e--;
  ctx.p = s + len;
  return decodeStr(u8, s, e);
}

function readLenStr(ctx) {
  const len = ctx.dv.getInt32(ctx.p, true); ctx.p += 4;
  return readFixedStr(ctx, len);
}

function readTranslatedFS(ctx) {
  const version = ctx.dv.getUint16(ctx.p, true); ctx.p += 2;
  const handle = readLenStr(ctx);
  const n = ctx.dv.getInt32(ctx.p, true); ctx.p += 4;
  const args = [];
  for (let i = 0; i < n; i++) {
    const key = readLenStr(ctx);
    const string = readTranslatedFS(ctx);
    const value = readLenStr(ctx);
    args.push({ key, string, value });
  }
  return { handle, version, arguments: args };
}

function readAttr(type, len, ctx) {
  const dv = ctx.dv, p = ctx.p;
  switch (type) {
    case 0: return { type, value: null };
    case 1: return { type, value: ctx.u8[p] };
    case 2: return { type, value: dv.getInt16(p, true) };
    case 3: return { type, value: dv.getUint16(p, true) };
    case 4: return { type, value: dv.getInt32(p, true) };
    case 5: return { type, value: dv.getUint32(p, true) };
    case 6: return { type, value: float32Value(dv, p) };
    case 7: return { type, value: dv.getFloat64(p, true) };
    case 8: case 9: case 10: {
      const n = SHAPE[type][0], parts = new Array(n);
      for (let i = 0; i < n; i++) parts[i] = String(dv.getInt32(p + 4 * i, true));
      return { type, value: parts.join(' ') };
    }
    case 11: case 12: case 13: {
      const n = SHAPE[type][0], parts = new Array(n);
      for (let i = 0, q = p; i < n; i++, q += 4) parts[i] = f32Text(dv.getUint32(q, true), dv.getFloat32(q, true));
      return { type, value: parts.join(' ') };
    }
    case 14: case 15: case 16: case 17: case 18: {
      // stored column-major (for col, for row); value text is row-major like LSLib's Matrix.ToString
      const [cols, rows] = SHAPE[type], parts = new Array(cols * rows);
      for (let c = 0, q = p; c < cols; c++) for (let r = 0; r < rows; r++, q += 4) parts[r * cols + c] = shortestF32(dv.getFloat32(q, true));
      return { type, value: parts.join(' '), rows, cols };
    }
    case 19: return { type, value: ctx.u8[p] !== 0 };
    case 20: case 21: case 22: case 23: case 29: case 30: return { type, value: readFixedStr(ctx, len) };
    case 24: return { type, value: int64Value(dv.getBigUint64(p, true)) };
    case 25: return { type, value: ctx.u8.slice(p, p + len) };
    case 26: case 32: return { type, value: int64Value(dv.getBigInt64(p, true)) };
    case 27: return { type, value: dv.getInt8(p) };
    case 28: {
      const version = dv.getUint16(p, true); ctx.p = p + 2;
      const handle = readLenStr(ctx);
      return { type, value: handle, handle, version };
    }
    case 31: return { type, value: guidText(ctx.u8, p) };
    case 33: {
      const fs = readTranslatedFS(ctx);
      return { type, value: fs.handle, handle: fs.handle, version: fs.version, arguments: fs.arguments };
    }
    default: throw new Error(`LSF: unknown attribute type ${type}`);
  }
}

/**
 * Parse an LSF (LSOF) resource synchronously. Handles uncompressed and LZ4 (block + frame) sections, which is
 * everything BG3 ships. zlib sections need parseLSFAsync(); zstd is rejected.
 * @param {Uint8Array} bytes
 */
export function parseLSF(bytes) {
  const h = readHeader(bytes);
  const raw = sliceSections(bytes, h);
  const sec = {};
  for (const k in raw) sec[k] = decompressSync(raw[k], h);
  return build(h, sec);
}

/** Same as parseLSF, but also supports zlib-compressed sections (via DecompressionStream('deflate')). */
export async function parseLSFAsync(bytes) {
  const h = readHeader(bytes);
  const raw = sliceSections(bytes, h);
  const sec = {};
  for (const k in raw) sec[k] = await decompressAsync(raw[k], h);
  return build(h, sec);
}

/* ------------------------------------------------------------------ LSX value text */

function base64(u8) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '', i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    s += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  if (i < u8.length) {
    const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8);
    s += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < u8.length ? A[(n >> 6) & 63] : '=') + '=';
  }
  return s;
}

function netFixed2(v) {
  // .NET "{0,5:0.00}" (round half away from zero, right-aligned to width 5)
  const s = (v < 0 || Object.is(v, -0) ? '-' : '') + Math.abs(Math.fround(v)).toFixed(2); // toFixed rounds the exact float value
  return s.padStart(5, ' ');
}

/** The value= text LSLib writes into .lsx for this attribute (TranslatedString: the handle). */
export function formatAttr(attr) {
  const { type, value } = attr;
  switch (type) {
    case 6: return formatFloat(value);
    case 7: return formatDouble(value);
    case 19: return value ? 'True' : 'False';
    case 25: return base64(value);
    case 14: case 15: case 16: case 17: case 18: {
      const v = value.split(' ').map(Number);
      let s = '';
      for (let r = 0; r < attr.rows; r++) {
        for (let c = 0; c < attr.cols; c++) s += netFixed2(v[r * attr.cols + c]) + ' ';
        s += '\r\n';
      }
      return s;
    }
    case 20: case 21: case 22: case 23: case 29: case 30: return value.replace(/\x1f/g, '');
    default: return value === null ? '' : String(value);
  }
}

/* ------------------------------------------------------------------ LOCA */

/** @returns {{handle:string, version:number, text:string}[]} */
export function parseLocaEntries(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseLoca: expected a Uint8Array');
  const dv = u8dv(bytes);
  if (bytes.length < 12 || dv.getUint32(0, true) !== 0x41434F4C) throw new Error('LOCA: bad signature');
  const n = dv.getUint32(4, true);
  let t = dv.getUint32(8, true);
  if (12 + n * 70 > bytes.length || t > bytes.length) throw new Error('LOCA: truncated file');
  const out = new Array(n);
  for (let i = 0, p = 12; i < n; i++, p += 70) {
    let e = p; while (e < p + 64 && bytes[e]) e++;
    const handle = decodeStr(bytes, p, e);
    const version = dv.getUint16(p + 64, true);
    const len = dv.getUint32(p + 66, true);
    if (len === 0 || t + len > bytes.length) throw new Error('LOCA: text out of range');
    out[i] = { handle, version, text: utf8.decode(bytes.subarray(t, t + len - 1)) };
    t += len;
  }
  return out;
}

/** @returns {Map<string,string>} handle -> text (a later duplicate handle wins) */
export function parseLoca(bytes) {
  const m = new Map();
  for (const e of parseLocaEntries(bytes)) m.set(e.handle, e.text);
  return m;
}
