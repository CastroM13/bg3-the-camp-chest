// One virtual file system over the user's BG3 .pak archives (read-only, in the browser).
import { Pak } from '../lib/pak.js';

// Archives the catalogue needs. Hotfix/patch archives are opened last so their files override.
const PAKS = ['Shared', 'Gustav', 'GustavX', 'Models', 'Materials', 'Textures', 'Gustav_Textures', 'VirtualTextures', 'Game'];

export class GameFS {
  /** @param {FileSystemDirectoryHandle} dataDir the game's Data folder */
  constructor(dataDir) { this.dataDir = dataDir; this.paks = new Map(); this.index = new Map(); }

  async file(name, dir = this.dataDir) { return (await dir.getFileHandle(name)).getFile(); }

  async open(onProgress = () => {}) {
    const names = [];
    for await (const [name, h] of this.dataDir.entries()) if (h.kind === 'file') names.push(name);
    const patches = names.filter((n) => /^Patch\d+.*\.pak$/i.test(n) && !/_\d+\.pak$/i.test(n)).sort();
    const order = [...PAKS.map((p) => `${p}.pak`).filter((p) => names.includes(p)), ...patches];
    let i = 0;
    for (const file of order) {
      const base = file.replace(/\.pak$/i, '');
      const pak = await new Pak((part) => this.file(part ? `${base}_${part}.pak` : file)).open();
      this.paks.set(base, pak);
      for (const path of pak.files.keys()) this.index.set(path.toLowerCase(), { pak, path });
      onProgress(++i / (order.length + 1), base);
    }
    // English text lives in Localization/English.pak
    try {
      const loc = await this.dataDir.getDirectoryHandle('Localization');
      const pak = await new Pak((part) => this.file(part ? `English_${part}.pak` : 'English.pak', loc)).open();
      this.paks.set('English', pak);
      for (const path of pak.files.keys()) this.index.set(path.toLowerCase(), { pak, path });
    } catch { /* no English localization: names fall back to ids */ }
    onProgress(1, 'done');
    // a cheap "game version" fingerprint for caches: sizes + dates of the main archives
    const fp = [];
    for (const p of ['Gustav.pak', 'GustavX.pak', 'Shared.pak', ...patches]) {
      try { const f = await this.file(p); fp.push(`${p}:${f.size}:${f.lastModified}`); } catch { /* optional */ }
    }
    this.version = fp.join('|');
    return this;
  }

  has(path) { return this.index.has(path.toLowerCase()); }
  realPath(path) { return this.index.get(path.toLowerCase())?.path || null; }
  async read(path) {
    const e = this.index.get(path.toLowerCase());
    if (!e) throw new Error(`missing game file: ${path}`);
    return e.pak.read(e.path);
  }
  async readText(path) { return new TextDecoder('utf-8').decode(await this.read(path)); }

  /** paths matching a predicate (on the original-case path), in archive order */
  list(pred) {
    const out = [];
    for (const { path } of this.index.values()) if (pred(path)) out.push(path);
    return out;
  }
}
