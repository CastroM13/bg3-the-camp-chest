// Compare lib/dds.js + lib/bcdecode.js against Pillow on real BG3 DDS files.
//   node test/dds-test.mjs [--scale k]     (k multiplies the per-group sample counts, default 1)
// Needs `python` with Pillow on PATH; test/dds_ref.py decodes DDS bytes piped over stdin.
// Mip levels are checked by wrapping each tested mip in a synthetic single-level DDS for Pillow.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDDS } from '../lib/dds.js';
import { decodeBC } from '../lib/bcdecode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../../extract/assets');
const ROOTS = [path.join(ASSETS, 'Generated'), path.join(ASSETS, 'Public/Game/GUI/Assets/Tooltips/ItemIcons')];
const scaleArg = process.argv.indexOf('--scale');
const SCALE = scaleArg > 0 ? Number(process.argv[scaleArg + 1]) : 1;

// samples per group; group = "<icon|tex> <format> <srgb?>"
const COUNTS = {
  'tex BC1': 10, 'tex BC3': 8, 'tex BC4': 8, 'tex BC5': 8, 'tex BC7': 12,
  'icon BC7': 6, 'icon BC7 srgb': 6, 'icon BC3': 6,
};
// channels compared per format (BC4 is grey in Pillow, BC5's B depends on Pillow version)
const CHANNELS = { BC1: [0, 1, 2, 3], BC2: [0, 1, 2, 3], BC3: [0, 1, 2, 3], BC4: [0], BC5: [0, 1], BC7: [0, 1, 2, 3] };

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.dds$/i.test(e.name) ? [path.join(d, e.name)] : []);

// ---- pick files --------------------------------------------------------------------------------
const groups = {};
for (const root of ROOTS) {
  const isIcon = root.includes('ItemIcons');
  for (const f of walk(root).sort()) {
    const hdr = parseDDS(fs.readFileSync(f));
    const g = `${isIcon ? 'icon' : 'tex'} ${hdr.format}${isIcon && hdr.srgb ? ' srgb' : ''}`;
    (groups[g] ??= []).push(f);
  }
}
const picked = [];
for (const [g, files] of Object.entries(groups)) {
  const n = Math.min(files.length, Math.round((COUNTS[g] ?? 4) * SCALE));
  for (let i = 0; i < n; i++) picked.push({ group: g, file: files[Math.floor((i + 0.5) * files.length / n)] });
}

// ---- build Pillow jobs: the file itself + a few mip levels as synthetic DDS -------------------
function singleMipDDS(bytes, dds, mip) {
  const hdrLen = dds.fourCC === 'DX10' ? 148 : 128;
  const out = new Uint8Array(hdrLen + mip.data.length);
  out.set(bytes.subarray(0, hdrLen));
  out.set(mip.data, hdrLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, dv.getUint32(8, true) & ~0x20000, true); // clear DDSD_MIPMAPCOUNT
  dv.setUint32(12, mip.height, true);
  dv.setUint32(16, mip.width, true);
  dv.setUint32(20, mip.data.length, true);
  dv.setUint32(28, 1, true);
  return out;
}

function pillowDecode(blobs) {
  const parts = [];
  for (const b of blobs) { const l = Buffer.alloc(4); l.writeUInt32LE(b.length); parts.push(l, Buffer.from(b.buffer, b.byteOffset, b.length)); }
  const r = spawnSync('python', ['-I', path.join(HERE, 'dds_ref.py')], { input: Buffer.concat(parts), maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('dds_ref.py failed: ' + r.stderr.toString());
  const out = r.stdout, res = [];
  let o = 0;
  for (let i = 0; i < blobs.length; i++) {
    const ml = out.readUInt32LE(o); o += 4;
    const meta = JSON.parse(out.subarray(o, o + ml).toString()); o += ml;
    if (!meta.error) { const n = meta.w * meta.h * 4; meta.px = out.subarray(o, o + n); o += n; }
    res.push(meta);
  }
  return res;
}

function compare(fmt, ours, ref) {
  let max = 0, nBad = 0;
  const chs = CHANNELS[fmt] ?? [0, 1, 2, 3];
  for (let p = 0; p < ours.length; p += 4) {
    for (const c of chs) {
      const d = Math.abs(ours[p + c] - ref[p + c]);
      if (d > max) max = d;
      if (d > 1) nBad++;
    }
  }
  return { max, nBad };
}

// BC7 mode histogram of tested blocks
const bc7Modes = new Array(9).fill(0);
function countModes(data) {
  for (let o = 0; o < data.length; o += 16) { const b = data[o]; bc7Modes[b ? 31 - Math.clz32(b & -b) : 8]++; }
}

// ---- run ----------------------------------------------------------------------------------------
const results = {}; // key -> { files, surfaces, max, nBad, pixels }
let failures = 0, totalSurfaces = 0;
const BATCH = 6;
for (let i = 0; i < picked.length; i += BATCH) {
  const batch = picked.slice(i, i + BATCH);
  const jobs = [];
  for (const { group, file } of batch) {
    const bytes = fs.readFileSync(file);
    const dds = parseDDS(bytes);
    // expected mip chain sizes
    let w = dds.width, h = dds.height;
    for (const m of dds.mips) {
      if (m.width !== w || m.height !== h) throw new Error(`${file}: bad mip size ${m.width}x${m.height}`);
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    jobs.push({ group, file, dds, level: 0, blob: bytes });
    const n = dds.mips.length;
    const levels = new Set([1, Math.floor(n / 2), n - 3, n - 2, n - 1].filter((l) => l > 0 && l < n));
    for (const l of levels) jobs.push({ group, file, dds, level: l, blob: singleMipDDS(bytes, dds, dds.mips[l]) });
  }
  const refs = pillowDecode(jobs.map((j) => j.blob));
  jobs.forEach((j, k) => {
    const ref = refs[k], mip = j.dds.mips[j.level];
    const r = (results[j.group] ??= { files: new Set(), surfaces: 0, mipSurfaces: 0, max: 0, nBad: 0, pixels: 0, refMode: '' });
    r.files.add(j.file);
    totalSurfaces++;
    if (ref.error) { console.log(`PILLOW ERROR ${j.file} L${j.level}: ${ref.error}`); failures++; return; }
    if (ref.w !== mip.width || ref.h !== mip.height) { console.log(`SIZE MISMATCH ${j.file} L${j.level}`); failures++; return; }
    const ours = decodeBC(j.dds.format, mip.data, mip.width, mip.height);
    if (j.dds.format === 'BC7') countModes(mip.data);
    // invariants of our own output
    if (j.dds.format === 'BC4') for (let p = 0; p < ours.length; p += 4) if (ours[p + 1] !== ours[p] || ours[p + 2] !== ours[p] || ours[p + 3] !== 255) { failures++; console.log('BC4 invariant'); break; }
    if (j.dds.format === 'BC5') for (let p = 0; p < ours.length; p += 4) if (ours[p + 2] !== 0 || ours[p + 3] !== 255) { failures++; console.log('BC5 invariant'); break; }
    const c = compare(j.dds.format, ours, ref.px);
    r.surfaces++; if (j.level) r.mipSurfaces++;
    r.max = Math.max(r.max, c.max); r.nBad += c.nBad; r.pixels += mip.width * mip.height; r.refMode = ref.mode;
    if (c.max > 1) { failures++; console.log(`MISMATCH ${path.relative(ASSETS, j.file)} L${j.level} ${mip.width}x${mip.height}: max ${c.max}, ${c.nBad} channels > 1`); }
  });
}

console.log('\n| group | files | surfaces (mips) | pixels | Pillow mode | channels | max diff | >1 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [g, r] of Object.entries(results)) {
  const fmt = g.split(' ')[1];
  console.log(`| ${g} | ${r.files.size} | ${r.surfaces} (${r.mipSurfaces}) | ${(r.pixels / 1e6).toFixed(1)}M | ${r.refMode} | ${(CHANNELS[fmt] ?? []).map((c) => 'RGBA'[c]).join('')} | ${r.max} | ${r.nBad} |`);
}
console.log(`\nBC7 block modes seen: ${bc7Modes.map((n, m) => `m${m}=${n}`).join(' ')}`);

// ---- speed ------------------------------------------------------------------------------------
console.log('\nSpeed (mip 0, best of 5, includes allocation):');
for (const fmt of ['BC7', 'BC1', 'BC3', 'BC4', 'BC5']) {
  const cand = picked.map((p) => p.file).map((f) => ({ f, d: parseDDS(fs.readFileSync(f)) }))
    .filter((x) => x.d.format === fmt).sort((a, b) => b.d.width * b.d.height - a.d.width * a.d.height);
  const x = cand.find((c) => c.d.width === 2048 && c.d.height === 2048) ?? cand[0];
  if (!x) continue;
  const m = x.d.mips[0];
  decodeBC(fmt, m.data, m.width, m.height); // warm-up
  let best = Infinity;
  for (let k = 0; k < 5; k++) { const t = performance.now(); decodeBC(fmt, m.data, m.width, m.height); best = Math.min(best, performance.now() - t); }
  let chain = performance.now();
  for (const mm of x.d.mips) decodeBC(fmt, mm.data, mm.width, mm.height);
  chain = performance.now() - chain;
  console.log(`  ${fmt} ${m.width}x${m.height}: ${best.toFixed(1)} ms (${(m.width * m.height / best / 1e3).toFixed(0)} MPix/s); full mip chain ${chain.toFixed(1)} ms`);
}

console.log(`\n${picked.length} files, ${totalSurfaces} surfaces compared, ${failures} failures`);
process.exit(failures ? 1 : 0);
