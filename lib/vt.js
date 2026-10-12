// Granite virtual textures (.gts tile sets + .gtp page files) as used by Baldur's Gate 3.
// Layout and logic follow LSLib's VirtualTextures (https://github.com/Norbyte/lslib, MIT, Norbyte).
import { lz4DecompressBlock } from './lz4.js';
import { fastlzDecompress } from './fastlz.js';
import { bc3Copy } from './bc.js';

const utf16 = new TextDecoder('utf-16le');
const ascii = (u8) => { let e = 0; while (e < u8.length && u8[e]) e++; return String.fromCharCode(...u8.subarray(0, e)); };

export class TileSet {
  /** @param {Uint8Array} gts whole .gts file  @param {(fileName:string)=>Promise<Uint8Array>} readPage */
  constructor(gts, readPage) {
    this.readPage = readPage;
    const dv = new DataView(gts.buffer, gts.byteOffset, gts.byteLength);
    const u32 = (o) => dv.getUint32(o, true), u64 = (o) => Number(dv.getBigUint64(o, true));
    if (u32(0) !== 0x47505247) throw new Error('not a GTS file');
    const H = {
      numLayers: u32(28), layersOffset: u64(32), numLevels: u32(40), levelsOffset: u64(44),
      tileWidth: dv.getInt32(52, true), tileHeight: dv.getInt32(56, true), tileBorder: dv.getInt32(60, true),
      numFlat: u32(68), flatOffset: u64(72), numPacked: u32(88), packedOffset: u64(92),
      pageSize: u32(128), numPageFiles: u32(132), pageFileOffset: u64(136),
      fourccSize: u32(144), fourccOffset: u64(148), numParam: u32(156), paramOffset: u64(160),
    };
    this.H = H;
    this.layers = Array.from({ length: H.numLayers }, (_, i) => ({ dataType: u32(H.layersOffset + i * 8) }));
    this.levels = Array.from({ length: H.numLevels }, (_, i) => {
      const o = H.levelsOffset + i * 16;
      const w = u32(o), h = u32(o + 4), off = u64(o + 8);
      return { width: w, height: h, tiles: new Uint32Array(gts.slice(off, off + w * h * H.numLayers * 4).buffer) };
    });
    this.params = new Map();
    for (let i = 0; i < H.numParam; i++) {
      const o = H.paramOffset + i * 20;
      const id = u32(o), codec = u32(o + 4), info = u64(o + 12);
      if (codec === 9) this.params.set(id, { codec, c1: ascii(gts.subarray(info + 2, info + 18)), c2: ascii(gts.subarray(info + 18, info + 34)) });
      else this.params.set(id, { codec });
    }
    this.pageFiles = Array.from({ length: H.numPageFiles }, (_, i) => {
      const o = H.pageFileOffset + i * 536;
      const buf = gts.subarray(o, o + 512);
      let e = 0; while (e < 512 && (buf[e] || buf[e + 1])) e += 2;
      return { name: utf16.decode(buf.subarray(0, e)), numPages: u32(o + 512) };
    });
    const flat = gts.slice(H.flatOffset, H.flatOffset + H.numFlat * 12);
    this.flat = new DataView(flat.buffer);
    this.textures = parseTextures(gts, H.fourccOffset, H.fourccSize);
    this.pages = new Map();
  }

  async page(index) {
    if (!this.pages.has(index)) {
      this.pages.set(index, (async () => {
        const bytes = await this.readPage(this.pageFiles[index].name);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const chunkOffsets = [];
        const n = Math.floor(bytes.length / this.H.pageSize);
        for (let p = 0; p < n; p++) {
          const base = p === 0 ? 24 : p * this.H.pageSize;
          const cnt = dv.getUint32(base, true);
          chunkOffsets.push(Array.from({ length: cnt }, (_, k) => dv.getUint32(base + 4 + k * 4, true)));
        }
        return { bytes, dv, chunkOffsets };
      })());
    }
    return this.pages.get(index);
  }

  tileInfo(level, layer, x, y) {
    const L = this.levels[level];
    const idx = L.tiles[layer + this.H.numLayers * (x + y * L.width)];
    if (idx & 0x80000000) return null;
    const o = idx * 12;
    return { pageFile: this.flat.getUint16(o, true), page: this.flat.getUint16(o + 2, true), chunk: this.flat.getUint16(o + 4, true) };
  }

  async unpackTile(t) {
    const pf = await this.page(t.pageFile);
    const off = pf.chunkOffsets[t.page][t.chunk] + t.page * this.H.pageSize;
    const codec = pf.dv.getUint32(off, true), paramId = pf.dv.getUint32(off + 4, true), size = pf.dv.getUint32(off + 8, true);
    const tw = this.H.tileWidth, th = this.H.tileHeight;
    const outSize = 16 * Math.ceil(tw / 4) * Math.ceil(th / 4) + 16 * Math.ceil(tw / 8) * Math.ceil(th / 8);
    const data = pf.bytes.subarray(off + 12, off + 12 + size);
    if (codec === 0) {            // uniform colour: build a solid BC3 tile
      const [r, g, b, a] = data;
      const blk = uniformBC3(r, g, b, a), img = new Uint8Array(tw * th);
      for (let i = 0; i < img.length; i += 16) img.set(blk, i);
      return img;
    }
    const p = this.params.get(paramId);
    if (p.c1 === 'lz4') return lz4DecompressBlock(data, outSize);
    if (p.c1 === 'lz77') return fastlzDecompress(data, outSize);
    if (p.c1 === 'raw') return data.slice(0, outSize);
    throw new Error(`unsupported tile compression ${p.c1}/${p.c2}`);
  }

  /** Extract one layer of a named texture as a BC3 image at the given mip level (falls back to coarser levels). */
  async extract(name, layer, level = 0) {
    const tex = this.textures.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tex) return null;
    const tlW = this.H.tileWidth - this.H.tileBorder * 2, tlH = this.H.tileHeight - this.H.tileBorder * 2;
    for (let lvl = level; lvl < this.levels.length; lvl++) {
      const lv = 1 << lvl;
      const tX = tex.x / tlW | 0, tY = tex.y / tlH | 0, tW = tex.width / tlW | 0, tH = tex.height / tlH | 0;
      const ceilDiv = (a) => Math.floor(a / lv) + (a % lv > 0 ? 1 : 0);
      const minX = ceilDiv(tX), minY = ceilDiv(tY), maxX = ceilDiv(tX + tW) - 1, maxY = ceilDiv(tY + tH) - 1;
      let ok = maxX >= minX && maxY >= minY;
      for (let y = minY; ok && y <= maxY; y++) for (let x = minX; ok && x <= maxX; x++) if (!this.tileInfo(lvl, layer, x, y)) ok = false;
      if (!ok) continue;
      const w = (maxX - minX + 1) * tlW, h = (maxY - minY + 1) * tlH;
      const out = new Uint8Array((w / 4) * (h / 4) * 16);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const tile = await this.unpackTile(this.tileInfo(lvl, layer, x, y));
        bc3Copy(tile, this.H.tileWidth, out, w, this.H.tileBorder, this.H.tileBorder, (x - minX) * tlW, (y - minY) * tlH, tlW, tlH);
      }
      return { width: w, height: h, level: lvl, data: out };
    }
    return null;
  }
}

function uniformBC3(r, g, b, a) {
  const c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  return new Uint8Array([a, a, 0, 0, 0, 0, 0, 0, c & 255, c >> 8, c & 255, c >> 8, 0, 0, 0, 0]);
}

function parseTextures(gts, offset, size) {
  const dv = new DataView(gts.buffer, gts.byteOffset, gts.byteLength);
  const read = (start, end) => {
    const list = [];
    let p = start;
    while (p < end) {
      const cc = String.fromCharCode(gts[p], gts[p + 1], gts[p + 2], gts[p + 3]);
      const format = gts[p + 4], ext = gts[p + 5];
      let len = dv.getUint16(p + 6, true);
      p += 8;
      if (ext === 1) { len |= dv.getUint32(p, true) << 16; p += 4; }
      const el = { cc, format };
      if (format === 1) el.children = read(p, p + len);
      else if (format === 2) el.str = utf16.decode(gts.subarray(p, p + len - 2));
      else if (format === 3) el.u32 = dv.getUint32(p, true);
      p += len;
      if (p % 4) p += 4 - (p % 4);
      list.push(el);
    }
    return list;
  };
  const root = read(offset, offset + size)[0];
  const child = (n, cc) => n?.children?.find((c) => c.cc === cc);
  const txts = child(child(root, 'ATLS'), 'TXTS')?.children || [];
  return txts.map((t) => ({ name: child(t, 'NAME')?.str, width: child(t, 'WDTH')?.u32, height: child(t, 'HGHT')?.u32,
    x: child(t, 'XXXX')?.u32, y: child(t, 'YYYY')?.u32 }));
}
