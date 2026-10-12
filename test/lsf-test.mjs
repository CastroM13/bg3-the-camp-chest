// Compares lib/lsf.js parseLSF() against Divine's LSX conversion of the same files.
// Usage: node test/lsf-test.mjs [--all] [--verbose]
//   default: Shared RootTemplates + a set of Content _merged.lsf banks of different kinds
//   --all:   every .lsx under BG3Catalog/lsx (slow; ~3200 files, 1.3 GB of XML)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLSF, formatAttr, AttrTypeNames } from '../lib/lsf.js';

const BASE = 'C:/Users/castro/Documents/BG3Catalog';
const EXTRACT = `${BASE}/extract`, LSX = `${BASE}/lsx`;
const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');

const DEFAULT = [
  'Shared/Public/Shared/RootTemplates/_merged',
  'Gustav/Public/GustavDev/Content/[PAK]_CharacterVisuals/_merged',
  'Gustav/Public/GustavDev/Content/Generated/[PAK]_GeneratedDialogTimelines/_merged',
  'Shared/Public/Shared/Content/Generated/[PAK]_TimelineScenes/_merged',
  'Shared/Public/Shared/Content/Assets/Characters/Humans/[PAK]_Male_Body/_merged',
  'Shared/Public/Shared/Content/Assets/Effects/Materials/[PAK]_Model/_merged',
  'Shared/Public/Shared/Content/Assets/Buildings/[PAK]_Generic/_merged',
  'Shared/Public/Shared/Content/Assets/Atmospheres/[PAK]_Atmospheres/_merged',
  'GustavX/Public/GustavX/Content/Assets/Characters/Creatures/Minotaur/[PAK]_Zombie_Body/_merged',
  'Gustav/Public/GustavDev/Content/Generated/HLOD/[PAK]_CTY_LowerCity_A/_merged',
];

/* ------------------------------------------------------------- tiny LSX parser */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
function xmlAttrs(s) {
  const o = {}; const re = /([\w:]+)="([^"]*)"/g; let m;
  while ((m = re.exec(s))) o[m[1]] = unesc(m[2]);
  return o;
}
function parseLSX(text) {
  const regions = [];
  const stack = [];
  let region = null;
  const re = /<(\/?)([\w?]+)([^>]*?)(\/?)>/g; let m;
  while ((m = re.exec(text))) {
    const [, close, tag, rest, selfClose] = m;
    if (tag === 'region') { if (!close) { region = { id: xmlAttrs(rest).id, node: null }; regions.push(region); } }
    else if (tag === 'node') {
      if (close) { stack.pop(); continue; }
      const a = xmlAttrs(rest);
      const n = { id: a.id, key: a.key, attrs: [], children: [] };
      if (stack.length) stack[stack.length - 1].children.push(n); else region.node = n;
      if (!selfClose) stack.push(n);
    } else if (tag === 'attribute' && !close) {
      stack[stack.length - 1].attrs.push(xmlAttrs(rest));
    }
  }
  return regions;
}

/* ------------------------------------------------------------- comparison */
const FLOATY = new Set(['float', 'double', 'fvec2', 'fvec3', 'fvec4']);
const MAT = new Set(['mat2x2', 'mat3x3', 'mat3x4', 'mat4x3', 'mat4x4']);

function cmpValue(typeName, attr, x, st) {
  if (typeName === 'TranslatedString') {
    if (attr.handle === x.handle && String(attr.version) === x.version) return 'exact';
    return null;
  }
  const mine = formatAttr(attr);
  if (mine === x.value) return 'exact';
  if (FLOATY.has(typeName)) {
    const a = mine.split(' ').map(Number), b = x.value.split(' ').map(Number);
    if (a.length === b.length && a.every((v, i) => Math.fround(v) === Math.fround(b[i]) || (typeName === 'double' && v === b[i]))) return 'numeric';
    return null;
  }
  if (MAT.has(typeName)) {
    const a = mine.trim().split(/\s+/).map(Number), b = x.value.trim().split(/\s+/).map(Number);
    if (a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.0051)) return 'numeric';
    return null;
  }
  return null;
}

function compareNode(a, b, path, st) {
  st.nodes++;
  if (a.id !== b.id) { st.diff(`${path}: node id ${a.id} != ${b.id}`); return; }
  if ((a.key ?? undefined) !== (b.key ?? undefined)) st.diff(`${path}: key ${a.key} != ${b.key}`);
  const names = Object.keys(a.attrs);
  if (names.length !== b.attrs.length) st.diff(`${path}: ${names.length} attrs vs ${b.attrs.length} in LSX`);
  for (let i = 0; i < Math.max(names.length, b.attrs.length); i++) {
    st.attrs++;
    const x = b.attrs[i], name = names[i];
    if (!x || name === undefined) { st.attrBad++; continue; }
    if (name !== x.id) { st.attrBad++; st.diff(`${path}: attr #${i} id ${name} != ${x.id}`); continue; }
    const attr = a.attrs[name];
    const tn = AttrTypeNames[attr.type];
    if (tn !== x.type) { st.attrBad++; st.diff(`${path}/@${name}: type ${tn} != ${x.type}`); continue; }
    const r = cmpValue(tn, attr, x, st);
    if (r === 'exact') st.exact++;
    else if (r === 'numeric') { st.numeric++; st.numericByType[tn] = (st.numericByType[tn] || 0) + 1; if (st.numericSamples.length < 6) st.numericSamples.push(`${tn}: lsf ${JSON.stringify(formatAttr(attr))} vs lsx ${JSON.stringify(x.value)} (${path}/@${name})`); }
    else { st.attrBad++; st.diff(`${path}/@${name} (${tn}): "${formatAttr(attr)}" != "${x.value}"`); }
  }
  if (a.children.length !== b.children.length) { st.diff(`${path}: ${a.children.length} children vs ${b.children.length}`); }
  const n = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) compareNode(a.children[i], b.children[i], `${path}/${a.children[i].id}[${i}]`, st);
}

function newStats() {
  const st = { nodes: 0, attrs: 0, exact: 0, numeric: 0, attrBad: 0, diffs: 0, numericByType: {}, numericSamples: [], firstDiffs: [] };
  st.diff = (msg) => { st.diffs++; if (st.firstDiffs.length < 10) st.firstDiffs.push(msg); };
  return st;
}

function testFile(rel, total) {
  const lsfPath = `${EXTRACT}/${rel}.lsf`, lsxPath = `${LSX}/${rel}.lsx`;
  const bytes = new Uint8Array(readFileSync(lsfPath));
  const t0 = performance.now();
  const res = parseLSF(bytes);
  const ms = performance.now() - t0;
  const lsx = parseLSX(readFileSync(lsxPath, 'utf8'));
  const st = newStats();
  const mineRegions = Object.keys(res.regions);
  const lsxRegions = lsx.map((r) => r.id);
  if (mineRegions.join() !== lsxRegions.join()) st.diff(`regions ${mineRegions} != ${lsxRegions}`);
  for (const r of lsx) if (res.regions[r.id]) compareNode(res.regions[r.id], r.node, r.id, st);
  for (const k of ['nodes', 'attrs', 'exact', 'numeric', 'attrBad', 'diffs']) total[k] += st[k];
  for (const [k, v] of Object.entries(st.numericByType)) total.numericByType[k] = (total.numericByType[k] || 0) + v;
  for (const s of st.numericSamples) if (total.numericSamples.length < 6) total.numericSamples.push(s);
  total.files++; total.bytes += bytes.length; total.ms += ms;
  const ok = st.diffs === 0;
  if (!ok) total.badFiles++;
  if (verbose || !ok || !args.has('--all')) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${rel}  ${(bytes.length / 1e6).toFixed(2)} MB  ${ms.toFixed(0)} ms  nodes=${st.nodes} attrs=${st.attrs} exact=${st.exact} numeric=${st.numeric} bad=${st.attrBad} diffs=${st.diffs}`);
    for (const d of st.firstDiffs) console.log('     ' + d);
  }
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.lsx')) out.push(relative(LSX, p).replace(/\\/g, '/').replace(/\.lsx$/i, ''));
  }
  return out;
}

const list = args.has('--all') ? walk(LSX, []) : DEFAULT;
const total = { files: 0, badFiles: 0, bytes: 0, ms: 0, nodes: 0, attrs: 0, exact: 0, numeric: 0, attrBad: 0, diffs: 0, numericByType: {}, numericSamples: [] };
for (const rel of list) {
  if (!existsSync(`${EXTRACT}/${rel}.lsf`)) { console.log(`SKIP ${rel} (no .lsf)`); continue; }
  try { testFile(rel, total); } catch (e) { total.badFiles++; total.files++; console.log(`ERR  ${rel}: ${e.stack}`); }
}

// LSF files Divine did not convert (KeysAndAdjacency format): must at least parse.
const extraOk = [];
for (const rel of ['Shared/Mods/Shared/EquipmentSettings/VisualAttachmentMappings',
  'Materials/Public/Shared/Assets/Materials/Base/Base_2S_VT']) {
  const p = `${EXTRACT}/${rel}.lsf`;
  if (!existsSync(p)) continue;
  try {
    const r = parseLSF(new Uint8Array(readFileSync(p)));
    let n = 0, keyed = 0; const cnt = (x) => { n++; if (x.key) keyed++; x.children.forEach(cnt); };
    Object.values(r.regions).forEach(cnt);
    extraOk.push(`${rel}: regions=${Object.keys(r.regions)} nodes=${n} keyed=${keyed}`);
  } catch (e) { total.badFiles++; extraOk.push(`${rel}: ERROR ${e.message}`); }
}

console.log('\n==== summary ====');
console.log(`files: ${total.files}, files with differences: ${total.badFiles}`);
console.log(`nodes compared: ${total.nodes}, attributes compared: ${total.attrs}`);
const good = total.exact + total.numeric;
console.log(`attribute match: ${good}/${total.attrs} = ${(100 * good / Math.max(1, total.attrs)).toFixed(4)}%  (exact text ${total.exact}, numeric-only ${total.numeric}, mismatched ${total.attrBad})`);
console.log(`numeric-only matches by type: ${JSON.stringify(total.numericByType)}`);
for (const s of total.numericSamples) console.log('   e.g. ' + s);
console.log(`total differences reported: ${total.diffs}`);
console.log(`parse throughput (all files): ${(total.bytes / 1e6 / (total.ms / 1000)).toFixed(1)} MB/s`);
for (const s of extraOk) console.log('no-LSX file: ' + s);
process.exitCode = total.badFiles ? 1 : 0;
