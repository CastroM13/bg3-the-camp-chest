// Baldur's Gate 3 .pak (LSPK v18) reader that works on browser File/Blob objects (or anything with
// slice(start, end).arrayBuffer()). Multi-part archives: entry.part > 0 lives in "<Name>_<part>.pak".
import { lz4DecompressBlock } from './lz4.js';

const ENTRY_SIZE = 272;
const dec = new TextDecoder('utf-8');

export class Pak {
  /** @param {(part:number)=>Blob|Promise<Blob>} getPart  part 0 = the main .pak */
  constructor(getPart) { this.getPart = getPart; this.files = new Map(); this.parts = []; }

  async open() {
    const main = await this.getPart(0);
    const h = new DataView(await main.slice(0, 40).arrayBuffer());
    const magic = String.fromCharCode(h.getUint8(0), h.getUint8(1), h.getUint8(2), h.getUint8(3));
    if (magic !== 'LSPK') throw new Error('not an LSPK archive');
    this.version = h.getUint32(4, true);
    if (this.version !== 18) throw new Error(`unsupported .pak version ${this.version}`);
    const listOffset = Number(h.getBigUint64(8, true));
    this.numParts = h.getUint16(38, true);
    const lh = new DataView(await main.slice(listOffset, listOffset + 8).arrayBuffer());
    const num = lh.getUint32(0, true), csize = lh.getUint32(4, true);
    const comp = new Uint8Array(await main.slice(listOffset + 8, listOffset + 8 + csize).arrayBuffer());
    const list = lz4DecompressBlock(comp, num * ENTRY_SIZE);
    const dv = new DataView(list.buffer, list.byteOffset, list.byteLength);
    for (let k = 0; k < num; k++) {
      const b = k * ENTRY_SIZE;
      let end = b; while (end < b + 256 && list[end]) end++;
      const name = dec.decode(list.subarray(b, end));
      const offset = dv.getUint32(b + 256, true) + dv.getUint16(b + 260, true) * 2 ** 32;
      const part = list[b + 262], flags = list[b + 263];
      const sizeOnDisk = dv.getUint32(b + 264, true), size = dv.getUint32(b + 268, true);
      this.files.set(name, { name, offset, part, flags, sizeOnDisk, size });
    }
    this.parts[0] = main;
    return this;
  }

  has(name) { return this.files.has(name); }

  async read(name) {
    const e = this.files.get(name);
    if (!e) throw new Error(`not in archive: ${name}`);
    const blob = this.parts[e.part] || (this.parts[e.part] = await this.getPart(e.part));
    const raw = new Uint8Array(await blob.slice(e.offset, e.offset + e.sizeOnDisk).arrayBuffer());
    const method = e.flags & 0x0F;
    if (method === 0) return raw;
    if (method === 2) return lz4DecompressBlock(raw, e.size);
    throw new Error(`unsupported compression ${method} for ${name}`);
  }
}
