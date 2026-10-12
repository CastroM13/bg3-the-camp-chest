// End-to-end engine test in Node against a local install: node test/engine-test.mjs "<BG3 Data dir>" [outDir]
// Builds the index and a handful of assets, writing them to outDir (local only; never commit the output).
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileBlob } from './nodeblob.mjs';

// Node has no OffscreenCanvas: write raw RGBA with a tiny header instead of PNG
globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.w = w; this.h = h; }
  getContext() { return { putImageData: (img) => { this.img = img; } }; }
  async convertToBlob() { const d = this.img.data; return { arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) }; } };
globalThis.ImageData ??= class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };

const { GameFS } = await import('../engine/gamefs.js');
const { buildIndex } = await import('../engine/index.js');
const { AssetBuilder } = await import('../engine/assets.js');

function dirHandle(path) {
  return {
    kind: 'directory', name: path.split(/[\/]/).pop(),
    async *entries() { for (const n of readdirSync(path)) yield [n, { kind: statSync(join(path, n)).isDirectory() ? 'directory' : 'file' }]; },
    async getFileHandle(n) { const p = join(path, n); statSync(p); return { getFile: async () => Object.assign(fileBlob(p), { lastModified: statSync(p).mtimeMs }) }; },
    async getDirectoryHandle(n) { return dirHandle(join(path, n)); },
  };
}

const DATA = process.argv[2] || 'C:/Program Files (x86)/Steam/steamapps/common/Baldurs Gate 3/Data';
const OUT = process.argv[3];
let t = performance.now();
const fs = await new GameFS(dirHandle(DATA)).open();
console.log('open', Math.round(performance.now() - t), 'ms', fs.index.size, 'files');
t = performance.now();
const ix = await buildIndex(fs, (f, l) => process.stdout.write(`\r${(f * 100).toFixed(0)}% ${l}                    `));
console.log('\nindex', ix._stats, 'json', (JSON.stringify(ix).length / 1e6).toFixed(1), 'MB');
const b = new AssetBuilder(fs, ix);
const want = process.argv.slice(4).length ? process.argv.slice(4) : ['weapons/WPN_Longsword/loot.gltf', 'weapons/WPN_Longsword/icon.png',
  'armor/ARM_Leather_Body/worn.gltf', 'armor/ARM_Leather_Body/rig_f.gltf', 'dressing/body_M.gltf', 'dressing/head_F.gltf',
  'dressing/poses/M/idle.gltf', 'dyes/OBJ_Dye_Black.png'];
for (const p of want) {
  t = performance.now();
  const f = await b.build(p);
  console.log(p, f ? `${f.bytes.byteLength} B ${f.type}` : 'MISSING', Math.round(performance.now() - t), 'ms');
  if (f && p.endsWith('.gltf')) {
    const g = JSON.parse(new TextDecoder().decode(f.bytes));
    console.log('   meshes', g.meshes?.length, 'materials', g.materials?.map((m) => m.name + (m.extras ? '*' : '')).join(','), 'images', g.images?.length, 'skins', g.skins?.length, 'anims', g.animations?.[0]?.channels.length);
  }
}
if (OUT) for (const [p, f] of b.files) if (f.bytes) { mkdirSync(dirname(join(OUT, p)), { recursive: true }); writeFileSync(join(OUT, p), f.bytes); }
