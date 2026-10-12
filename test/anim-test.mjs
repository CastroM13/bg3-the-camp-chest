// Compare lib/anim.js against LSLib (Divine) glTF exports of the same GR2 animations
// (output/dressing/poses/{M,F}/*.glb, conformed to HUM_M_Base / HUM_F_Base; idle.glb = *_IDLE_Still_Peace_01).
// node test/anim-test.mjs [maxPosesPerBody]   (default: every pose that has a .glb, plus the idle)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { Pak } from '../lib/pak.js';
import { Granny } from '../lib/granny.js';
import { decodeAnimation } from '../lib/anim.js';
import { partOpener } from '../../web/test/nodeblob.mjs';

const DATA = 'C:/Program Files (x86)/Steam/steamapps/common/Baldurs Gate 3/Data';
const CAT = 'C:/Users/castro/Documents/BG3Catalog';
const maxPer = +process.argv[2] || Infinity;

// which pak holds each file (listings: tab-separated, first column = path). Only the main human rigs' folders count:
// the same file names also exist elsewhere (e.g. _MaleStrong/HUM_MS_Rig/HUM_F_Rig_DFLT_PM_Dancing_Disco_01.GR2).
// The pose files live in GustavX.pak; the idles live in Models.pak (Public/Shared/...), so that listing is read too.
const where = new Map();
for (const pakName of ['GustavX', 'Shared', 'Models']) {
  if (!existsSync(`${CAT}/lists/${pakName}.txt`)) continue;
  for (const line of readFileSync(`${CAT}/lists/${pakName}.txt`, 'utf8').split(/\r?\n/)) {
    const p = line.split('\t')[0];
    if (/\.GR2$/i.test(p) && /\/Humans\/(_Male\/HUM_M|_Female\/HUM_F)_Rig\/HUM_[MF]_Rig_DFLT_(PM_|IDLE_Still_Peace_01)/.test(p)) where.set(p.split('/').pop(), { pakName, path: p });
  }
}
const paks = {};
const openPak = async (name) => paks[name] || (paks[name] = await new Pak(partOpener(DATA, `${name}.pak`)).open());

function readGlb(file) {
  const b = readFileSync(file);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bl = b.readUInt32LE(20 + jl);
  const bin = b.subarray(28 + jl, 28 + jl + bl);
  const acc = (i) => {
    const A = j.accessors[i], bv = j.bufferViews[A.bufferView];
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type];
    if (A.componentType !== 5126) throw new Error('non-float accessor');
    const o = (bv.byteOffset || 0) + (A.byteOffset || 0), stride = bv.byteStride || n * 4;
    const out = new Float32Array(A.count * n);
    for (let k = 0; k < A.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = bin.readFloatLE(o + k * stride + c * 4);
    return out;
  };
  const a = j.animations[0];
  return a.channels.map((c) => {
    const s = a.samplers[c.sampler];
    return { node: j.nodes[c.target.node].name, path: c.target.path, interp: s.interpolation, times: acc(s.input), values: acc(s.output) };
  });
}

// sign-insensitive quaternion error: max abs component difference after aligning signs
function qdist(a, i, b, k) {
  const d = a[i] * b[k] + a[i + 1] * b[k + 1] + a[i + 2] * b[k + 2] + a[i + 3] * b[k + 3];
  const s = d < 0 ? -1 : 1;
  let e = 0;
  for (let c = 0; c < 4; c++) e = Math.max(e, Math.abs(a[i + c] - s * b[k + c]));
  return e;
}
// angle between the rotations (normalised first: BG3's float curves store slightly non-unit quaternions, kept as-is)
function qangle(a, i, b, k) {
  const na = Math.hypot(a[i], a[i + 1], a[i + 2], a[i + 3]), nb = Math.hypot(b[k], b[k + 1], b[k + 2], b[k + 3]);
  const d = Math.abs(a[i] * b[k] + a[i + 1] * b[k + 1] + a[i + 2] * b[k + 2] + a[i + 3] * b[k + 3]) / (na * nb);
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
}

const T = { files: 0, channels: 0, keys: 0, rot: 0, rotDeg: 0, tr: 0, sc: 0, time: 0, mRot: 0, mTr: 0, mSc: 0,
  missing: 0, countMismatch: 0, interp: new Set(), formats: {}, skipped: [] };
const worst = { rot: '', tr: '', sc: '' };

async function testOne(body, id, glbFile) {
  const grName = id === 'idle' ? `HUM_${body}_Rig_DFLT_IDLE_Still_Peace_01.GR2` : `HUM_${body}_Rig_DFLT_PM_${id}.GR2`;
  const loc = where.get(grName);
  if (!loc) { T.skipped.push(`${body}/${id}`); console.log(`  skip ${body}/${id}: ${grName} not in pak listings`); return; }
  const g = new Granny(await (await openPak(loc.pakName)).read(loc.path));
  const anim = decodeAnimation(g, g.root());
  const byBone = new Map(anim.tracks.map((t) => [t.bone, t]));
  for (const t of anim.tracks) for (const [k, c] of Object.entries(t.channels)) {
    const key = `${k}:${c.format}/deg${c.degree}`; T.formats[key] = (T.formats[key] || 0) + 1;
  }
  const glb = readGlb(glbFile);
  let fr = 0, ft = 0, fs = 0, keys = 0;
  for (const ch of glb) {
    T.interp.add(ch.interp);
    const tr = byBone.get(ch.node);
    if (!tr) { T.missing++; console.log(`  no decoded track for glb channel ${body}/${id} ${ch.node}.${ch.path}`); continue; }
    T.channels++;
    const mine = tr.channels[ch.path];
    if (mine.times.length !== ch.times.length) {
      T.countMismatch++; console.log(`  key count ${body}/${id} ${ch.node}.${ch.path}: ours ${mine.times.length}, glb ${ch.times.length}`); continue;
    }
    const merged = ch.path === 'rotation' ? tr.rotations : ch.path === 'translation' ? tr.translations : tr.scales;
    for (let k = 0; k < ch.times.length; k++) {
      keys++;
      T.time = Math.max(T.time, Math.abs(mine.times[k] - ch.times[k]));
      const mi = tr.times.indexOf(ch.times[k]);           // merged timeline must contain the key with the same value
      if (ch.path === 'rotation') {
        const e = qdist(mine.values, k * 4, ch.values, k * 4);
        if (e > T.rot) { T.rot = e; worst.rot = `${body}/${id} ${ch.node} t=${ch.times[k]}`; }
        T.rotDeg = Math.max(T.rotDeg, qangle(mine.values, k * 4, ch.values, k * 4));
        T.qnorm = Math.max(T.qnorm || 0, Math.abs(Math.hypot(...mine.values.subarray(k * 4, k * 4 + 4)) - 1));
        fr = Math.max(fr, e);
        T.mRot = Math.max(T.mRot, mi >= 0 ? qdist(merged, mi * 4, ch.values, k * 4) : Infinity);
      } else {
        let e = 0, em = 0;
        for (let c = 0; c < 3; c++) {
          e = Math.max(e, Math.abs(mine.values[k * 3 + c] - ch.values[k * 3 + c]));
          em = Math.max(em, mi >= 0 ? Math.abs(merged[mi * 3 + c] - ch.values[k * 3 + c]) : Infinity);
        }
        if (ch.path === 'translation') {
          if (e > T.tr) { T.tr = e; worst.tr = `${body}/${id} ${ch.node} t=${ch.times[k]}`; }
          ft = Math.max(ft, e); T.mTr = Math.max(T.mTr, em);
        } else {
          if (e > T.sc) { T.sc = e; worst.sc = `${body}/${id} ${ch.node} t=${ch.times[k]}`; }
          fs = Math.max(fs, e); T.mSc = Math.max(T.mSc, em);
        }
      }
    }
  }
  T.keys += keys; T.files++;
  const maxKeys = Math.max(...anim.tracks.map((t) => t.times.length));
  console.log(`  ${body}/${id.padEnd(22)} tracks ${String(anim.tracks.length).padStart(3)}  maxKeys ${String(maxKeys).padStart(3)}  ` +
    `keys ${String(keys).padStart(5)}  rot ${fr.toExponential(2)}  tr ${ft.toExponential(2)}  sc ${fs.toExponential(2)}`);
}

for (const body of ['M', 'F']) {
  const dir = `${CAT}/output/dressing/poses/${body}`;
  const ids = readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)).filter((x) => x !== 'idle');
  console.log(`${body}: ${ids.length} pose glbs`);
  for (const id of ids.slice(0, maxPer)) await testOne(body, id, `${dir}/${id}.glb`);
  if (existsSync(`${dir}/idle.glb`)) await testOne(body, 'idle', `${dir}/idle.glb`);
}

console.log('\ncurve formats (channel:format/degree -> tracks):', T.formats);
console.log('glb sampler interpolation:', [...T.interp].join(','));
console.log(`files ${T.files}, skipped ${T.skipped.length} ${T.skipped.join(' ')}`);
console.log(`channels compared ${T.channels}, keys ${T.keys}, glb channels without decoded track ${T.missing}, key-count mismatches ${T.countMismatch}`);
console.log(`max |time| error ${T.time}`);
console.log(`max rotation error (sign-insensitive, per component) ${T.rot} (= ${T.rotDeg.toFixed(6)} deg)  worst: ${worst.rot}`);
console.log(`max | |q| - 1 | of decoded rotation keys ${T.qnorm}`);
console.log(`max translation error ${T.tr}  worst: ${worst.tr}`);
console.log(`max scale error ${T.sc}  worst: ${worst.sc}`);
console.log(`merged-timeline errors at glb key times: rot ${T.mRot}  tr ${T.mTr}  sc ${T.mSc}`);
const ok = T.files >= 22 && T.countMismatch === 0 && T.missing === 0 && T.time < 1e-6 &&
  Math.max(T.rot, T.tr, T.sc, T.mRot, T.mTr, T.mSc) < 1e-5;
console.log(ok ? 'PASS' : 'FAIL');
process.exitCode = ok ? 0 : 1;
