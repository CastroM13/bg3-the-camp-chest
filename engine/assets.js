// On-demand asset builder: turns game files into the glTF / PNG files the app loads from vfs/.
// Port of the offline pipeline (build_items.py, build_dyes.py, build_bodyhide.py, build_heads.py, build_dressing.py).
import { Granny } from '../lib/granny.js';
import { decodeMesh } from '../lib/mesh.js';
import { TileSet } from '../lib/vt.js';
import { bc3Decode } from '../lib/bc.js';
import { parseDDS } from '../lib/dds.js';
import { decodeBC } from '../lib/bcdecode.js';
import { parseLSF } from '../lib/lsf.js';
import { decodeAnimation } from '../lib/anim.js';
import { walk } from '../lib/lsxtext.js';

const MAXTEX = 1024;
const COLOR_SLOTS = ['Cloth_Primary', 'Cloth_Secondary', 'Cloth_Tertiary', 'Accent_Color', 'Leather_Primary', 'Leather_Secondary',
  'Leather_Tertiary', 'Custom_1', 'Metal_Primary', 'Metal_Secondary', 'Metal_Tertiary', 'Custom_2'];
const VT_DIR = 'Generated/Public/VirtualTextures/';
const BODY = { M: 'Generated/Public/Shared/Assets/Characters/_Models/Humans/_Male/Resources/HUM_M_NKD_Body_A.GR2',
  F: 'Generated/Public/Shared/Assets/Characters/_Models/Humans/_Female/Resources/HUM_F_NKD_Body_A.GR2' };
const HEAD = { M: 'Generated/Public/Shared/Assets/Characters/_Anims/_SharedAssets/SHARED_CC_Mannequin/_Male/Resources/HUM_M_NKD_Head_Mannequin.GR2',
  F: 'Generated/Public/Shared/Assets/Characters/_Anims/_SharedAssets/SHARED_CC_Mannequin/_Female/Resources/HUM_F_NKD_Head_Mannequin.GR2' };

// sRGB <-> linear lookup tables
const S2L = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const L2S = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255); };

async function encodePNG(rgba, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

function hashKey(obj) {           // small stable string hash for shared texture names
  const s = JSON.stringify(obj);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761); }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 12);
}

function resample(rgba, w, h, W, H) {   // nearest neighbour (masks: keeps region ids crisp)
  if (w === W && h === H) return rgba;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, (y * h / H) | 0); for (let x = 0; x < W; x++) {
    const sx = Math.min(w - 1, (x * w / W) | 0); out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4); } }
  return out;
}

export class AssetBuilder {
  constructor(fs, index) {
    this.fs = fs; this.ix = index; this.B = index._banks;
    this.tilesets = new Map(); this.shaderDefaults = new Map(); this.files = new Map(); this.inflight = new Map();
    this.vtLocation = null;
  }

  // ---------------------------------------------------------------- public: build a vfs path
  async build(path) {
    if (this.files.has(path)) return this.files.get(path);
    if (this.inflight.has(path)) { await this.inflight.get(path); return this.files.get(path); }
    const p = this.produce(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    await p;
    return this.files.get(path) || null;
  }
  put(path, bytes, type) { this.files.set(path, { bytes, type }); }

  async produce(path) {
    let m;
    if (path === 'data/items.json') return this.put(path, json(this.ix.items), 'application/json');
    if (path === 'data/dyes.json') return this.put(path, json(this.ix.dyes), 'application/json');
    if (path === 'dressing/dressing.json') return this.put(path, json(this.ix.dressing), 'application/json');
    if ((m = /^(weapons|armor|clothing)\/([^/]+)\/icon\.png$/.exec(path))) return this.icon(path, this.ix._assets[m[2]]?.icon);
    if ((m = /^dyes\/([^/]+)\.png$/.exec(path))) return this.icon(path, this.ix._dyeAssets[m[1]]?.icon);
    if ((m = /^(weapons|armor|clothing)\/([^/]+)\/(loot|worn|worn_f|rig_m|rig_f)\.(gltf|bin)$/.exec(path))) return this.itemModel(m[1], m[2], m[3]);
    if ((m = /^dressing\/(body|head)_(M|F)\.(gltf|bin)$/.exec(path))) return this.characterPart(m[1], m[2]);
    if ((m = /^dressing\/poses\/(M|F)\/([^/]+)\.(gltf|bin)$/.exec(path))) return this.pose(m[1], m[2]);
    // textures are produced alongside models; anything else is unknown
  }

  // ---------------------------------------------------------------- icons
  async icon(path, ddsPath) {
    if (!ddsPath) return;
    const img = this.decodeDDS(await this.fs.read(ddsPath), 512);
    this.put(path, await encodePNG(img.rgba, img.width, img.height), 'image/png');
  }

  decodeDDS(bytes, maxSide = MAXTEX) {
    const dds = parseDDS(bytes);
    let mip = dds.mips[0];
    for (const m of dds.mips) { if (Math.max(m.width, m.height) <= maxSide) { mip = m; break; } }
    return { width: mip.width, height: mip.height, rgba: decodeBC(dds.format, mip.data, mip.width, mip.height) };
  }

  // ---------------------------------------------------------------- virtual textures
  async tileset(gtex) {
    if (!this.vtLocation) {      // gtex -> tileset: dedicated page files carry the gtex name
      this.vtLocation = new Map();
      for (const p of this.fs.list((x) => x.startsWith(VT_DIR) && x.endsWith('.gtp'))) {
        const mm = /^(.*_[0-9a-f])_([0-9a-f]{32})\.gtp$/i.exec(p.slice(VT_DIR.length));
        if (mm) this.vtLocation.set(mm[2].toLowerCase(), `${VT_DIR}${mm[1]}.gts`);
      }
    }
    const candidates = this.vtLocation.has(gtex) ? [this.vtLocation.get(gtex)]
      : this.fs.list((x) => x.startsWith(VT_DIR) && x.endsWith('.gts'));   // mips-only textures: search every tileset
    for (const gts of candidates) {
      if (!this.tilesets.has(gts)) this.tilesets.set(gts, (async () => new TileSet(await this.fs.read(gts), (name) => this.fs.read(VT_DIR + name)))());
      const set = await this.tilesets.get(gts);
      if (set.textures.some((t) => t.name.toLowerCase() === gtex)) return set;
    }
    return null;
  }

  async vtLayers(gtex) {
    const set = await this.tileset(gtex.toLowerCase());
    if (!set) return null;
    const tex = set.textures.find((t) => t.name.toLowerCase() === gtex.toLowerCase());
    let level = 0;
    while (Math.max(tex.width, tex.height) >> level > MAXTEX && level + 1 < set.levels.length) level++;
    const out = [];
    for (let layer = 0; layer < set.layers.length && layer < 3; layer++) {
      const img = await set.extract(gtex, layer, level);
      out.push(img ? { width: img.width, height: img.height, rgba: bc3Decode(img.data, img.width, img.height) } : null);
    }
    return out;
  }

  // ---------------------------------------------------------------- materials -> textures
  async defaultsFor(shaderPath) {
    if (!shaderPath) return {};
    if (!this.shaderDefaults.has(shaderPath)) this.shaderDefaults.set(shaderPath, (async () => {
      const out = {};
      if (!this.fs.has(shaderPath)) return out;
      const lsf = await parseLSF(await this.fs.read(shaderPath));
      for (const root of Object.values(lsf.regions)) for (const n of walk(root)) {
        const pn = n.attrs?.ParameterName?.value, v = n.attrs?.Value;
        if (pn && v && typeof v.value === 'string' && v.value.trim().split(/\s+/).length === 3) out[pn] = v.value;
      }
      return out;
    })());
    return this.shaderDefaults.get(shaderPath);
  }

  async colorsFor(mat, equipment) {
    const c = { ...(await this.defaultsFor(mat.SourceFile)), ...mat.Vector };
    if (equipment) {
      for (const pid of [equipment.ColorPreset, ...equipment.GroupPresets]) if (pid && this.B.MaterialPresetBank[pid]) Object.assign(c, this.B.MaterialPresetBank[pid].Vector);
      Object.assign(c, equipment.VectorOverrides);
    }
    const out = {};
    for (const k of COLOR_SLOTS) if (c[k] != null) out[k] = String(c[k]).trim().split(/\s+/).slice(0, 3).map(Number);
    return out;
  }

  async materialTextures(mid, equipment) {
    const mat = this.B.MaterialBank[mid];
    if (!mat) return null;
    const colors = await this.colorsFor(mat, equipment);
    const tag = (mat.Name || mid).replace(/[^A-Za-z0-9_]+/g, '_');
    const mkey = hashKey([mid]), ckey = hashKey([mid, colors]);
    const names = { baseColor: `${tag}_${ckey}_baseColor.png`, normal: `${tag}_${mkey}_normal.png`, orm: `${tag}_${mkey}_orm.png`,
      rawAlbedo: `raw/${tag}_${mkey}_albedo.png`, rawMask: `raw/${tag}_${mkey}_mask.png` };
    const metaKey = `meta/${ckey}`;
    if (this.files.has(metaKey)) return this.files.get(metaKey).meta;
    const work = (async () => {
      let alb = null, nrm = null, phy = null, msk = null;
      for (const p of mat.VirtualTexture.filter((x) => x.Enabled)) {
        const g = this.B.VirtualTextureBank[p.ID]?.GTexFileName;
        if (!g) continue;
        const layers = await this.vtLayers(g);
        if (layers) [alb, nrm, phy] = [layers[0] || alb, layers[1] || nrm, layers[2] || phy];
      }
      for (const p of mat.Texture2D.filter((x) => x.Enabled && x.ParameterName)) {
        const src = this.B.TextureBank[p.ID]?.SourceFile;
        if (!src || !this.fs.has(src)) continue;
        try {
          if (['basecolor', 'Body_color_texture'].includes(p.ParameterName) && !alb) alb = this.decodeDDS(await this.fs.read(src));
          else if (p.ParameterName === 'normalmap' && !nrm) nrm = this.decodeDDS(await this.fs.read(src));
          else if (p.ParameterName === 'physicalmap' && !phy) phy = this.decodeDDS(await this.fs.read(src));
          else if (p.ParameterName === 'MSKColor') msk = this.decodeDDS(await this.fs.read(src));
        } catch (e) { /* unsupported texture: leave the slot empty */ }
      }
      const out = {};
      const rel = (n) => '../../textures/' + n;
      if (alb) {
        const { width: w, height: h, rgba } = alb;
        if (!this.files.has('textures/' + names.rawAlbedo)) this.put('textures/' + names.rawAlbedo, await encodePNG(rgba, w, h), 'image/png');
        out.rawAlbedo = rel(names.rawAlbedo);
        const base = new Uint8Array(rgba);
        if (msk && Object.keys(colors).length) {
          const m = resample(msk.rgba, msk.width, msk.height, w, h);
          if (!this.files.has('textures/' + names.rawMask)) this.put('textures/' + names.rawMask, await encodePNG(m, w, h), 'image/png');
          out.rawMask = rel(names.rawMask);
          const pal = COLOR_SLOTS.map((s) => colors[s] || [1, 1, 1]);
          for (let i = 0; i < w * h; i++) {
            const r = m[i * 4], g = m[i * 4 + 1], b = m[i * 4 + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (!mx || (mx - mn) / mx <= 0.25) continue;
            const dom = r >= g && r >= b ? 0 : g >= b ? 1 : 2;
            const ch = [r, g, b];
            const nb = ch[(dom + 1) % 3] / mx > 0.25, pb = ch[(dom + 2) % 3] / mx > 0.25;
            const sub = nb && !pb ? 0 : !nb && !pb ? 1 : !nb && pb ? 2 : 3;
            const slot = [0, 2, 1][dom] * 4 + sub, wgt = mx / 255, col = pal[slot];
            for (let k = 0; k < 3; k++) base[i * 4 + k] = L2S(S2L[rgba[i * 4 + k]] * (1 - wgt + wgt * col[k]));
          }
        }
        this.put('textures/' + names.baseColor, await encodePNG(base, w, h), 'image/png');
        out.baseColor = rel(names.baseColor);
        let minA = 255; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < minA) minA = rgba[i];
        out.hasAlpha = minA < 252;
      }
      if (nrm) {
        const { width: w, height: h, rgba } = nrm, o = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const x = rgba[i * 4 + 3] / 127.5 - 1, y = rgba[i * 4 + 1] / 127.5 - 1, z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
          o[i * 4] = (x * .5 + .5) * 255 + .5; o[i * 4 + 1] = (y * .5 + .5) * 255 + .5; o[i * 4 + 2] = (z * .5 + .5) * 255 + .5; o[i * 4 + 3] = 255;
        }
        if (!this.files.has('textures/' + names.normal)) this.put('textures/' + names.normal, await encodePNG(o, w, h), 'image/png');
        out.normal = rel(names.normal);
      }
      if (phy) {
        const { width: w, height: h, rgba } = phy, o = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { o[i * 4] = rgba[i * 4 + 2]; o[i * 4 + 1] = rgba[i * 4 + 1]; o[i * 4 + 2] = rgba[i * 4]; o[i * 4 + 3] = 255; }
        if (!this.files.has('textures/' + names.orm)) this.put('textures/' + names.orm, await encodePNG(o, w, h), 'image/png');
        out.orm = rel(names.orm);
      }
      // live re-dye data (material's own colours, no item preset)
      if (out.rawMask && out.rawAlbedo) {
        const base = await this.colorsFor(mat, null);
        out.dye = { albedo: out.rawAlbedo, mask: out.rawMask, base: Object.fromEntries(COLOR_SLOTS.map((k) => [k, base[k] || [1, 1, 1]])) };
      }
      return out;
    })();
    const meta = await work;
    this.files.set(metaKey, { meta });
    return meta;
  }

  // ---------------------------------------------------------------- models
  async granny(gr2) {
    if (!this.fs.has(gr2)) return null;
    const g = new Granny(await this.fs.read(gr2));
    return { g, root: g.root() };
  }

  async itemModel(folder, stat, kind) {
    const a = this.ix._assets[stat];
    if (!a) return;
    const visuals = kind === 'loot' ? (a.loot ? [a.loot] : []) : (kind === 'worn' || kind === 'rig_m') ? a.wornM : a.wornF;
    const rig = kind.startsWith('rig');
    const parts = [];
    for (const vid of visuals) {
      const v = this.B.VisualBank[vid];
      if (!v) continue;
      const gr = await this.granny(v.SourceFile);
      if (!gr) continue;
      const meshes = new Map((gr.root.Meshes || []).map((m) => [m.Name, m]));
      const objs = v.Objects.filter((o) => o.LOD === '0');
      for (const o of objs.length ? objs : v.Objects) {
        const meshName = (o.ObjectID || '').split('.')[1];
        const mat = this.B.MaterialBank[o.MaterialID];
        if (/Cloth_?[Mm]esh$/.test(meshName || '') && !mat) continue;   // cloth simulation proxy
        const mobj = meshes.get(meshName);
        if (!mobj) continue;
        const mesh = decodeMesh(gr.g, mobj);
        if (!mesh.boneNames?.length && mobj.BoneBindings?.length) mesh.boneNames = mobj.BoneBindings.map((bb) => bb.BoneName);   // rigid meshes
        const tex = mat ? await this.materialTextures(o.MaterialID, kind === 'loot' ? a.equipment : a.equipment) : null;
        const shader = mat?.SourceFile || '';
        parts.push({ mesh, mat: { name: (mat?.Name || 'material').replace(/[^A-Za-z0-9_]+/g, '_'), textures: tex || {}, dye: tex?.dye || null,
          alphaMask: /AlphaTest/.test(shader), doubleSided: /_2S|AlphaTest/.test(shader) },
        skeleton: rig ? gr.root.Skeletons?.[0] : null });
      }
    }
    const base = `${folder}/${stat}/${kind}`;
    const { gltf, bin } = writeGLTF(parts, `${kind}.bin`, { rig });
    this.put(`${base}.gltf`, json(gltf), 'model/gltf+json');
    this.put(`${base}.bin`, bin, 'application/octet-stream');
  }

  async characterPart(part, b) {
    const gr = await this.granny(part === 'body' ? BODY[b] : HEAD[b]);
    const parts = [];
    for (const m of gr?.root.Meshes || []) {
      if (/_LOD\d+$/.test(m.Name)) continue;
      const mesh = decodeMesh(gr.g, m);
      if (!mesh.joints) continue;
      parts.push({ mesh, mat: { name: 'Mannequin', textures: {}, color: [0.42, 0.39, 0.36] }, skeleton: gr.root.Skeletons?.[0], region: part === 'body' });
    }
    const { gltf, bin } = writeGLTF(parts, `${part}_${b}.bin`, { rig: true });
    this.put(`dressing/${part}_${b}.gltf`, json(gltf), 'model/gltf+json');
    this.put(`dressing/${part}_${b}.bin`, bin, 'application/octet-stream');
  }

  async pose(b, id) {
    const src = this.ix._poseAssets[`${b}/${id}`];
    if (!src) return;
    const gr = await this.granny(src);
    const anim = decodeAnimation(gr.g, gr.root, {});
    const { gltf, bin } = writeAnimationGLTF(anim, `${id}.bin`);
    this.put(`dressing/poses/${b}/${id}.gltf`, json(gltf), 'model/gltf+json');
    this.put(`dressing/poses/${b}/${id}.bin`, bin, 'application/octet-stream');
  }
}

// ------------------------------------------------------------------ glTF writers
const json = (o) => new TextEncoder().encode(JSON.stringify(o));

class GLTFBuilder {
  constructor() {
    this.g = { asset: { version: '2.0', generator: 'Camp Chest (in-browser)' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
      materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
      accessors: [], bufferViews: [], buffers: [] };
    this.chunks = []; this.len = 0; this.imgIndex = new Map();
  }
  view(bytes, target) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.len += pad; }
    const bv = { buffer: 0, byteOffset: this.len, byteLength: bytes.byteLength };
    if (target) bv.target = target;
    this.g.bufferViews.push(bv);
    this.chunks.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)); this.len += bytes.byteLength;
    return this.g.bufferViews.length - 1;
  }
  acc(arr, componentType, count, type, target, minmax) {
    const a = { bufferView: this.view(arr, target), componentType, count, type };
    if (minmax) Object.assign(a, minmax);
    this.g.accessors.push(a);
    return this.g.accessors.length - 1;
  }
  tex(uri) {
    if (!this.imgIndex.has(uri)) { this.g.images.push({ uri }); this.g.textures.push({ sampler: 0, source: this.g.images.length - 1 }); this.imgIndex.set(uri, this.g.textures.length - 1); }
    return { index: this.imgIndex.get(uri) };
  }
  finish(binName) {
    const bin = new Uint8Array(this.len);
    let o = 0; for (const c of this.chunks) { bin.set(c, o); o += c.byteLength; }
    this.g.buffers.push({ uri: binName, byteLength: this.len });
    for (const k of ['textures', 'images', 'materials', 'meshes', 'samplers']) if (!this.g[k].length) delete this.g[k];
    if (!this.g.accessors.length) { delete this.g.accessors; delete this.g.bufferViews; }
    return { gltf: this.g, bin };
  }
}

function minmax3(p) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < mn[k]) mn[k] = p[i + k]; if (p[i + k] > mx[k]) mx[k] = p[i + k]; }
  return { min: mn, max: mx };
}

export function writeGLTF(parts, binName, { rig }) {
  const b = new GLTFBuilder();
  const g = b.g;
  let armature = null; const boneNode = new Map(), ibm = new Map();
  const addSkeleton = (sk) => {
    if (!armature) { armature = g.nodes.length; g.nodes.push({ name: 'Armature', children: [], extras: { bg3Rig: true } }); g.scenes[0].nodes.push(armature); }
    const bones = sk?.Bones || [];
    const fresh = bones.map((bn, i) => [bn, i]).filter(([bn]) => !boneNode.has(bn.Name));
    for (const [bn] of fresh) {
      const t = bn.Transform;
      const node = { name: bn.Name, translation: t.translation, rotation: t.rotation };
      const sc = [t.scaleShear[0], t.scaleShear[4], t.scaleShear[8]];
      if (sc.some((s) => Math.abs(s - 1) > 1e-6)) node.scale = sc;
      boneNode.set(bn.Name, g.nodes.length); ibm.set(bn.Name, bn.InverseWorldTransform);
      g.nodes.push(node);
    }
    for (const [bn] of fresh) {
      const parent = bn.ParentIndex >= 0 ? bones[bn.ParentIndex]?.Name : null;
      const ni = boneNode.get(bn.Name);
      if (parent && boneNode.has(parent)) (g.nodes[boneNode.get(parent)].children ||= []).push(ni);
      else g.nodes[armature].children.push(ni);
    }
  };
  for (const { mesh, mat, skeleton, region } of parts) {
    const n = mesh.vertexCount;
    const attrs = {
      POSITION: b.acc(mesh.positions, 5126, n, 'VEC3', 34962, minmax3(mesh.positions)),
      NORMAL: b.acc(mesh.normals, 5126, n, 'VEC3', 34962),
      TEXCOORD_0: b.acc(mesh.uvs, 5126, n, 'VEC2', 34962),
    };
    if (mesh.tangents) attrs.TANGENT = b.acc(mesh.tangents, 5126, n, 'VEC4', 34962);
    if (region && mesh.colors) {
      const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = Math.round(mesh.colors[i * 4 + 1] * 255);
      attrs._REGION = b.acc(r, 5126, n, 'SCALAR', 34962);
    }
    const idx = b.acc(mesh.indices, 5125, mesh.indices.length, 'SCALAR', 34963);
    const gm = { name: mat.name, pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 1 }, doubleSided: !!mat.doubleSided };
    const t = mat.textures || {};
    if (t.baseColor) gm.pbrMetallicRoughness.baseColorTexture = b.tex(t.baseColor);
    if (t.orm) { gm.pbrMetallicRoughness.metallicRoughnessTexture = b.tex(t.orm); gm.occlusionTexture = b.tex(t.orm); }
    else Object.assign(gm.pbrMetallicRoughness, { metallicFactor: 0, roughnessFactor: 0.7 });
    if (mat.color) gm.pbrMetallicRoughness.baseColorFactor = [...mat.color, 1];
    if (t.normal) gm.normalTexture = b.tex(t.normal);
    if (mat.alphaMask && t.hasAlpha) { gm.alphaMode = 'MASK'; gm.alphaCutoff = 0.5; }
    if (mat.dye) gm.extras = { bg3Dye: mat.dye };
    g.materials.push(gm);
    const node = { name: mesh.name };
    if (rig && skeleton && mesh.boneNames?.length && !mesh.joints) {
      // rigid mesh bound to one bone (most helmets): skin every vertex fully to that bone
      mesh.joints = new Uint16Array(n * 4); mesh.weights = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) mesh.weights[i * 4] = 1;
    }
    if (rig && skeleton && mesh.joints && mesh.boneNames?.length) {
      addSkeleton(skeleton);
      if (mesh.boneNames.every((nm) => boneNode.has(nm))) {
        attrs.JOINTS_0 = b.acc(mesh.joints, 5123, n, 'VEC4', 34962);
        attrs.WEIGHTS_0 = b.acc(mesh.weights, 5126, n, 'VEC4', 34962);
        const m = new Float32Array(mesh.boneNames.length * 16);
        mesh.boneNames.forEach((nm, i) => m.set(ibm.get(nm), i * 16));
        (g.skins ||= []).push({ joints: mesh.boneNames.map((nm) => boneNode.get(nm)), inverseBindMatrices: b.acc(m, 5126, mesh.boneNames.length, 'MAT4') });
        node.skin = g.skins.length - 1;
      }
    }
    g.meshes.push({ name: mesh.name, primitives: [{ attributes: attrs, indices: idx, material: g.materials.length - 1 }] });
    node.mesh = g.meshes.length - 1;
    g.nodes.push(node);
    if (node.skin != null) g.nodes[armature].children.push(g.nodes.length - 1);
    else g.scenes[0].nodes.push(g.nodes.length - 1);
  }
  return b.finish(binName);
}

export function writeAnimationGLTF(anim, binName) {
  const b = new GLTFBuilder();
  const g = b.g;
  const channels = [], samplers = [];
  for (const tr of anim.tracks) {
    const ni = g.nodes.length;
    g.nodes.push({ name: tr.bone });
    g.scenes[0].nodes.push(ni);
    const add = (path, values, type) => {
      if (!values || !values.length) return;
      const tIn = b.acc(tr.times, 5126, tr.times.length, 'SCALAR', undefined, { min: [tr.times[0]], max: [tr.times[tr.times.length - 1]] });
      const tOut = b.acc(values, 5126, tr.times.length, type);
      samplers.push({ input: tIn, output: tOut, interpolation: 'STEP' });   // Granny control points as keys, like LSLib's export
      channels.push({ sampler: samplers.length - 1, target: { node: ni, path } });
    };
    add('rotation', tr.rotations, 'VEC4');
    add('translation', tr.translations, 'VEC3');
    add('scale', tr.scales, 'VEC3');
  }
  g.animations = [{ name: anim.name || 'pose', channels, samplers }];
  return b.finish(binName);
}
