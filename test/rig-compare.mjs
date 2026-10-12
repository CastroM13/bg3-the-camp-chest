// Compares engine-built rig glTFs against the old offline build: node test/rig-compare.mjs <Data dir> <old output dir> [slotGroup] [limit]
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileBlob } from './nodeblob.mjs';
globalThis.OffscreenCanvas ??= class { constructor() {} getContext() { return { putImageData: () => {} }; } async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(0) }; } };
globalThis.ImageData ??= class { constructor(d, w, h) { this.data = d; } };
const { GameFS } = await import('../engine/gamefs.js');
const { buildIndex } = await import('../engine/index.js');
const { AssetBuilder } = await import('../engine/assets.js');
const dirHandle = (path) => ({ kind: 'directory', name: path,
  async *entries() { for (const n of readdirSync(path)) yield [n, { kind: statSync(join(path, n)).isDirectory() ? 'directory' : 'file' }]; },
  async getFileHandle(n) { const p = join(path, n); statSync(p); return { getFile: async () => Object.assign(fileBlob(p), { lastModified: 0 }) }; },
  async getDirectoryHandle(n) { return dirHandle(join(path, n)); } });
const [DATA, OLD, group = 'Helmet', limit = '400', kind = 'rig_m'] = process.argv.slice(2);
const modelKey = kind === 'rig_f' ? 'rigF' : 'rigM';
const fs = await new GameFS(dirHandle(DATA)).open();
const ix = await buildIndex(fs);
const b = new AssetBuilder(fs, ix);
b.materialTextures = async () => ({});   // geometry and skinning only
const acc = (g, bin, i) => { const a = g.accessors[i], v = g.bufferViews[a.bufferView]; const n = { VEC3: 3, VEC4: 4, MAT4: 16, VEC2: 2, SCALAR: 1 }[a.type];
  return a.componentType === 5126 ? new Float32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset + (a.byteOffset || 0), bin.byteOffset + v.byteOffset + (a.byteOffset || 0) + a.count * n * 4)) : null; };
let bad = 0, n = 0;
for (const it of ix.items.items.filter((x) => (group === 'ALL' || x.slotGroup === group) && x.models[modelKey]).slice(0, +limit)) {
  const dir = it.models[modelKey].replace('../vfs/', '').split('/').slice(0, -1).join('/');
  const oldPath = join(OLD, dir, kind + '.gltf');
  if (!existsSync(oldPath)) continue;
  const og = JSON.parse(readFileSync(oldPath, 'utf8')), ob = readFileSync(join(OLD, dir, og.buffers[0].uri));
  await b.build(`${dir}/${kind}.gltf`);
  const ng = JSON.parse(new TextDecoder().decode(b.files.get(`${dir}/${kind}.gltf`).bytes)), nb = b.files.get(`${dir}/${kind}.bin`).bytes;
  n++;
  const diffs = [];
  if (og.meshes.length !== ng.meshes.length) diffs.push(`meshes ${og.meshes.length}/${ng.meshes.length}`);
  for (let m = 0; m < Math.min(og.meshes.length, ng.meshes.length); m++) {
    const oa = og.accessors[og.meshes[m].primitives[0].attributes.POSITION], na = ng.accessors[ng.meshes[m].primitives[0].attributes.POSITION];
    const d = Math.max(...oa.min.map((v, k) => Math.abs(v - na.min[k])), ...oa.max.map((v, k) => Math.abs(v - na.max[k])));
    if (d > 1e-3) diffs.push(`mesh ${og.meshes[m].name} pos bounds differ by ${d.toFixed(3)}`);
    const os = og.nodes.find((x) => x.mesh === m)?.skin, ns = ng.nodes.find((x) => x.mesh === m)?.skin;
    if ((os == null) !== (ns == null)) { diffs.push(`mesh ${og.meshes[m].name} skinned old=${os != null} new=${ns != null}`); continue; }
    if (os == null) continue;
    const oj = og.skins[os].joints.map((j) => og.nodes[j].name), nj = ng.skins[ns].joints.map((j) => ng.nodes[j].name);
    if (oj.join() !== nj.join()) diffs.push(`joints differ ${oj.length}/${nj.length}`);
    const oi = acc(og, ob, og.skins[os].inverseBindMatrices), ni = acc(ng, nb, ng.skins[ns].inverseBindMatrices);
    let md = 0; for (let k = 0; k < Math.min(oi.length, ni.length); k++) md = Math.max(md, Math.abs(oi[k] - ni[k]));
    if (md > 1e-3) diffs.push(`ibm differ ${md.toFixed(3)}`);
    for (const nm of oj) { const o = og.nodes.find((x) => x.name === nm), q = ng.nodes.find((x) => x.name === nm);
      const dt = Math.max(...o.translation.map((v, k) => Math.abs(v - q.translation[k])));
      if (dt > 1e-3) { diffs.push(`bone ${nm} t differs ${dt.toFixed(3)}`); break; } }
  }
  if (diffs.length) { bad++; console.log(it.id, '|', diffs.slice(0, 4).join('; '), '| new meshes', ng.meshes.map((m) => m.name).join(',')); }
}
console.log(`${bad}/${n} differ`);
