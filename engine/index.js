// Builds the item index (what the offline Python pipeline did) straight from the game archives:
// stats -> RootTemplates -> visual/material/texture banks -> items, dyes, body-hide regions, Dressing Room data.
import { parseLSF, parseLoca } from '../lib/lsf.js';
import { parseLSXText, walk, val, kids, kid } from '../lib/lsxtext.js';

const MODULE_ORDER = ['Shared', 'SharedDev', 'Gustav', 'GustavDev', 'Honour', 'GustavX', 'HonourX'];
const modRank = (p) => { const m = /Public\/([^/]+)\//.exec(p); const i = m ? MODULE_ORDER.indexOf(m[1]) : -1; return i < 0 ? 99 : i; };
const byModule = (a, b) => modRank(a) - modRank(b) || a.toLowerCase().localeCompare(b.toLowerCase());
export const BODY_HUM_M = '7d73f501-f65e-46af-a13b-2cacf3985d05';
export const BODY_HUM_F = '71180b76-5752-4a97-b71f-911a69197f58';
const COLOR_SLOTS = ['Cloth_Primary', 'Cloth_Secondary', 'Cloth_Tertiary', 'Accent_Color', 'Leather_Primary', 'Leather_Secondary',
  'Leather_Tertiary', 'Custom_1', 'Metal_Primary', 'Metal_Secondary', 'Metal_Tertiary', 'Custom_2'];

// ------------------------------------------------------------------ stats
export function parseStatsText(text, into, module) {
  let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    let m;
    if ((m = /^new entry "(.+)"/.exec(line))) { cur = { _name: m[1], _module: module, _using: null, _type: null, data: {} }; into[m[1]] = cur; }
    else if (!cur) continue;
    else if ((m = /^type "(.+)"/.exec(line))) cur._type = m[1];
    else if ((m = /^using "(.+)"/.exec(line))) cur._using = m[1];
    else if ((m = /^data "([^"]*)"\s+"(.*)"\s*$/.exec(line))) cur.data[m[1]] = m[2];
  }
}

function resolveStats(raw) {
  const out = {};
  const resolve = (name, depth = 0) => {
    if (out[name]) return out[name];
    const e = raw[name];
    if (!e || depth > 30) return {};
    const d = e._using ? { ...resolve(e._using, depth + 1) } : {};
    Object.assign(d, e.data);
    d._type = e._type; d._module = e._module; d._using = e._using;
    out[name] = d;
    return d;
  };
  for (const n of Object.keys(raw)) resolve(n);
  return out;
}

// ------------------------------------------------------------------ text
function cleanMarkup(text) {
  if (!text) return '';
  let t = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s || '') {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function splitCommas(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { depth += (ch === '(') - (ch === ')'); if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim());
  return out;
}
const splitCamel = (s) => (s || '').replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
function humanizeParam(p) {
  p = p.trim();
  let m = /^DealDamage\((.*)\)$/.exec(p);
  if (m) {
    const args = splitCommas(m[1]);
    if (args.length >= 2) {
      let amt = args[0], mm;
      if ((mm = /^max\(\s*(\d+)\s*,\s*(\w+?)Modifier\s*\)$/.exec(amt))) amt = `your ${splitCamel(mm[2])} modifier (minimum ${mm[1]})`;
      if ((mm = /^(\w+?)Modifier$/.exec(amt))) amt = `your ${splitCamel(mm[1])} modifier`;
      return `${amt} ${args[1]} damage`;
    }
  }
  if ((m = /^Distance\(\s*([\d.]+)\s*\)$/.exec(p))) return `${+m[1]}m`;
  if ((m = /^RegainHitPoints\(\s*([^,)]+).*\)$/.exec(p))) return `${m[1]} hit points`;
  return p;
}
function localize(loca, handle, params) {
  if (!handle) return null;
  const h = handle.split(';')[0].trim();
  if (!loca.has(h)) return null;
  let text = loca.get(h);
  if (params) {
    const pl = splitTop(params).map(humanizeParam);
    text = text.replace(/\[(\d+)\]/g, (m0, i) => pl[+i - 1] ?? m0);
  }
  return cleanMarkup(text);
}
const num = (v) => { if (v == null || v === '') return null; const f = Number(v); return Number.isFinite(f) ? f : null; };
const humanizeId = (stat) => splitCamel(stat.replace(/^(WPN|ARM|OBJ)_/, '').replace('_Body', '').replace(/_/g, ' ')).trim();

const WEAPON_LABEL_FIX = { Warpicks: 'War Pick', Quarterstaffs: 'Quarterstaff' };
const ARMOUR_LABEL = { Padded: 'Padded Armour', Leather: 'Leather Armour', StuddedLeather: 'Studded Leather Armour', Hide: 'Hide Armour',
  ChainShirt: 'Chain Shirt', ScaleMail: 'Scale Mail', BreastPlate: 'Breastplate', HalfPlate: 'Half Plate Armour', RingMail: 'Ring Mail',
  ChainMail: 'Chain Mail', Splint: 'Splint Armour', Plate: 'Plate Armour' };
const SLOT_LABEL = { Breast: 'Clothing', Helmet: 'Helmet', Gloves: 'Gloves', Boots: 'Boots', Cloak: 'Cloak', Underwear: 'Underwear',
  VanityBody: 'Camp Clothes', VanityBoots: 'Camp Shoes', Amulet: 'Amulet', Ring: 'Ring' };
const SLOT_GROUPS = { Breast: 'Breast', Helmet: 'Helmet', Gloves: 'Gloves', Boots: 'Boots', Cloak: 'Cloak', Underwear: 'Underwear',
  Amulet: 'Amulet', Ring: 'Ring', 'Melee Offhand Weapon': 'Shield', MusicalInstrument: 'Instrument', VanityBody: 'Camp Clothes', VanityBoots: 'Camp Shoes' };
const ABILITIES = new Set(['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma']);
const BOOST_FIELDS = [['Boosts', 'Equipped'], ['DefaultBoosts', 'Always'], ['BoostsOnEquipMainHand', 'MainHand'], ['BoostsOnEquipOffHand', 'OffHand']];
const PASSIVE_FIELDS = ['PassivesOnEquip', 'PassivesMainHand', 'PassivesOffHand'];

function typeLabel(catType, st, isWeapon) {
  if (isWeapon) return WEAPON_LABEL_FIX[catType] || splitCamel(catType.endsWith('s') ? catType.slice(0, -1) : catType);
  if (st.Shield === 'Yes') return 'Shield';
  const slot = st.Slot || '', at = st.ArmorType || 'None';
  if (slot === 'Breast' && ARMOUR_LABEL[at]) return ARMOUR_LABEL[at];
  return SLOT_LABEL[slot] || splitCamel(slot) || null;
}
function typeValue(catType, st, isWeapon) {
  if (isWeapon) return catType;
  if (st.Shield === 'Yes') return 'Shield';
  const at = st.ArmorType || 'None';
  if (st.Slot === 'Breast' && at !== 'None') return at;
  return st.Slot || catType;
}

function boostText(raw, res) {
  let s = raw.trim(), cond = null, m;
  if ((m = /^IF\((.*)\):(.*)$/.exec(s))) { cond = m[1]; s = m[2].trim(); }
  if (!(m = /^(\w+)\((.*)\)$/.exec(s))) return raw;
  const fn = m[1], args = m[2].trim() ? m[2].split(',').map((a) => a.trim()) : [];
  let text = null;
  if (fn === 'UnlockSpell' && args.length) text = `Grants action: ${res.nameOf(args[0]) || splitCamel(args[0].replace(/^[A-Za-z]+_/, ''))}`;
  else if (fn === 'AC' && args.length) { const n = num(args[0]); text = `${n != null && n >= 0 ? '+' : ''}${args[0]} Armour Class`; }
  else if (fn === 'Ability' && args.length >= 2) text = `${args[1].startsWith('-') ? '' : '+'}${args[1]} ${args[0]}`;
  else if (fn === 'Skill' && args.length >= 2) text = `${args[1].startsWith('-') ? '' : '+'}${args[1]} ${splitCamel(args[0])}`;
  else if (fn === 'RollBonus' && args.length >= 2) {
    const target = args.length > 2 ? ` ${args[2]}` : '', v = args[1], sign = v.startsWith('-') ? '' : '+';
    text = args[0] === 'SavingThrow' ? `${sign}${v} to${target} saving throws` : `${sign}${v} to${target} ${splitCamel(args[0]).toLowerCase()} rolls`;
  } else if ((fn === 'Disadvantage' || fn === 'Advantage') && args.length) {
    if (args[0] === 'Skill' && args[1]) text = `${fn} on ${splitCamel(args[1])} checks`;
    else if (args[0] === 'SavingThrow' && args[1]) text = `${fn} on ${args[1]} saving throws`;
    else if (args[0] === 'Ability' && args[1]) text = `${fn} on ${args[1]} checks`;
    else text = `${fn} on ${splitCamel(args[0])}`;
  } else if (fn === 'Resistance' && args.length >= 2) text = `${splitCamel(args[1])} to ${args[0]} damage`;
  else if (fn === 'CharacterWeaponDamage' && args.length) text = `Weapon attacks deal an additional ${args.join(' ')} damage`;
  else if (fn === 'WeaponEnchantment' && args.length) text = `+${args[0]} weapon enchantment`;
  else if (fn === 'Proficiency' && args.length) text = `Proficiency: ${splitCamel(args[0])}`;
  if (text == null) return raw;
  if (cond) {
    const m2 = /^not HasPassive\('(\w+)'.*\)$/.exec(cond);
    text += m2 ? ` (unless you have ${res.nameOf(m2[1]) || splitCamel(m2[1])})` : ` (if ${cond})`;
  }
  return text;
}

// ------------------------------------------------------------------ LSF helpers
const attrsOf = (node) => { const o = {}; for (const [k, a] of Object.entries(node.attrs || {})) o[k] = a.value; return o; };

function parseEquipment(go) {
  const eq = kid(go, 'Equipment');
  if (!eq) return null;
  const out = { Visuals: {}, ColorPreset: null, GroupPresets: [], VectorOverrides: {} };
  const vs = kid(eq, 'Visuals');
  for (const o of kids(vs, 'Object')) out.Visuals[val(o, 'MapKey')] = kids(o, 'MapValue').map((mv) => val(mv, 'Object'));
  const mo = kid(kid(eq, 'VisualSet'), 'MaterialOverrides');
  if (mo) {
    const cp = kid(mo, 'ColorPreset');
    if (cp) out.ColorPreset = val(cp, 'MaterialPresetResource') || null;
    for (const o of kids(kid(mo, 'MaterialPresets'), 'Object')) if (val(o, 'MaterialPresetResource')) out.GroupPresets.push(val(o, 'MaterialPresetResource'));
    for (const p of kids(mo, 'Vector3Parameters')) if (val(p, 'Enabled') === true || val(p, 'Enabled') === 'True') out.VectorOverrides[val(p, 'Parameter')] = val(p, 'Value');
  }
  return out;
}

function bankResource(bank, node, file) {
  const a = attrsOf(node);
  const r = { Name: a.Name, SourceFile: a.SourceFile, _file: file };
  const en = (p) => p.Enabled === true || p.Enabled === 'True';
  if (bank === 'VisualBank') {
    r.Template = a.Template; r.Slot = a.Slot;
    r.Objects = kids(node, 'Objects').map((o) => ({ LOD: String(val(o, 'LOD')), MaterialID: val(o, 'MaterialID'), ObjectID: val(o, 'ObjectID') }));
    r.MaskSlots = kids(node, 'VertexColorMaskSlots').map((s) => val(s, 'Object')).filter(Boolean);
  } else if (bank === 'MaterialBank') {
    const ps = (id) => kids(node, id).map(attrsOf);
    r.Texture2D = ps('Texture2DParameters').map((p) => ({ ParameterName: p.ParameterName, ID: p.ID, Enabled: en(p) }));
    r.VirtualTexture = ps('VirtualTextureParameters').map((p) => ({ ParameterName: p.ParameterName, ID: p.ID, Enabled: en(p) }));
    r.Scalar = Object.fromEntries(ps('ScalarParameters').filter(en).map((p) => [p.ParameterName, p.Value]));
    r.Vector = Object.fromEntries([...ps('Vector3Parameters'), ...ps('Vector4Parameters')].filter(en).map((p) => [p.ParameterName, p.Value]));
  } else if (bank === 'TextureBank') { r.SRGB = a.SRGB; }
  else if (bank === 'VirtualTextureBank') { r.GTexFileName = a.GTexFileName; }
  else if (bank === 'MaterialPresetBank') {
    const pr = kid(node, 'Presets');
    r.Vector = Object.fromEntries(kids(pr, 'Vector3Parameters').map(attrsOf).filter((p) => p.Enabled === true || p.Enabled === 'True').map((p) => [p.Parameter, p.Value]));
  }
  return [a.ID, r];
}

// ------------------------------------------------------------------ main build
/**
 * @param {import('./gamefs.js').GameFS} fs
 * @param {(fraction:number, label:string)=>void} progress
 */
export async function buildIndex(fs, progress = () => {}) {
  const T0 = performance.now();
  const step = (f, l) => progress(f, l);

  // 1. localisation
  step(0.02, 'Reading English text');
  const locPath = fs.list((p) => /^Localization\/English\/english\.loca$/i.test(p))[0];
  const loca = locPath ? parseLoca(await fs.read(locPath)) : new Map();

  // 2. stats (resolved Weapon/Armor + raw for spells/passives/dyes)
  step(0.06, 'Reading item stats');
  const statFiles = fs.list((p) => /^Public\/[^/]+\/Stats\/Generated\/Data\/[^/]+\.txt$/i.test(p)).sort(byModule);
  const rawAll = {}, rawEquip = {};
  for (const p of statFiles) {
    const text = await fs.readText(p);
    const module = /Public\/([^/]+)\//.exec(p)[1];
    parseStatsText(text, rawAll, module);
    if (/\/(Weapon|Armor)\.txt$/i.test(p)) parseStatsText(text, rawEquip, module);
  }
  const stats = resolveStats(rawEquip);
  const rawGet = (name, key, depth = 0) => {
    const e = rawAll[name];
    if (!e || depth > 30) return null;
    const v = e.data[key];
    if (v != null && v !== '') return v;
    return e._using ? rawGet(e._using, key, depth + 1) : null;
  };
  const res = { nameOf: (e) => localize(loca, rawGet(e, 'DisplayName')), descOf: (e) => localize(loca, rawGet(e, 'Description'), rawGet(e, 'DescriptionParams')) };

  // 3. RootTemplates (every GameObject; equipment details for items)
  step(0.1, 'Reading item templates');
  const tplFiles = fs.list((p) => /^Public\/[^/]+\/RootTemplates\/_merged\.lsf$/i.test(p)).sort(byModule);
  const T = {};
  for (const p of tplFiles) {
    const lsf = await parseLSF(await fs.read(p));
    for (const region of Object.values(lsf.regions)) for (const n of walk(region)) {
      if (n.id !== 'GameObjects') continue;
      const a = attrsOf(n);
      if (!a.MapKey) continue;
      const t = { MapKey: a.MapKey, Name: a.Name, Stats: a.Stats, Type: a.Type, VisualTemplate: a.VisualTemplate, ParentTemplateId: a.ParentTemplateId,
        Icon: a.Icon, DisplayName: n.attrs.DisplayName?.handle ?? null, Description: n.attrs.Description?.handle ?? null, ColorPreset: a.ColorPreset };
      if (a.Type === 'item') { const eq = parseEquipment(n); if (eq) t.Equipment = eq; }
      T[a.MapKey] = t;
    }
  }

  // 4. resource banks
  const bankFiles = fs.list((p) => /^Public\/[^/]+\/Content\/.*_merged\.lsf$/i.test(p)).sort(byModule);
  const B = { VisualBank: {}, MaterialBank: {}, TextureBank: {}, VirtualTextureBank: {}, MaterialPresetBank: {} };
  for (let i = 0; i < bankFiles.length; i++) {
    if (i % 40 === 0) step(0.15 + 0.6 * (i / bankFiles.length), `Reading resource banks (${i}/${bankFiles.length})`);
    const lsf = await parseLSF(await fs.read(bankFiles[i]));
    for (const [rname, root] of Object.entries(lsf.regions)) {
      if (!B[rname]) continue;
      for (const n of walk(root)) if (n.id === 'Resource') { const [id, r] = bankResource(rname, n, bankFiles[i]); if (id) B[rname][id] = r; }
    }
  }

  // 5. body regions (VisualSlots.lsx NakedBodySystem)
  const regions = {};
  const vsPath = fs.list((p) => /EquipmentSettings\/VisualSlots\.lsx$/i.test(p))[0];
  if (vsPath) {
    const lsx = parseLSXText(await fs.readText(vsPath));
    for (const root of Object.values(lsx.regions)) for (const n of walk(root)) if (n.id === 'NakedBodySystem')
      for (const o of walk(n)) if (o.attrs.MapKey) regions[String(o.attrs.MapKey.value).toLowerCase()] = +o.attrs.MapValue.value;
  }
  const hideOf = (vid) => [...new Set((B.VisualBank[vid]?.MaskSlots || []).map((s) => regions[s.toLowerCase()]).filter((x) => x != null))].sort((a, b) => a - b);

  // 6. gold value tables
  const gold = {};
  const gvPath = fs.list((p) => /\/GoldValues\.lsx$/i.test(p))[0];
  if (gvPath) {
    const lsx = parseLSXText(await fs.readText(gvPath));
    for (const root of Object.values(lsx.regions)) for (const n of walk(root)) if (n.id === 'GoldValue') {
      const rec = { levels: {} };
      for (const [k, a] of Object.entries(n.attrs)) {
        const m = /^Level(\d+)$/.exec(k);
        if (m) rec.levels[+m[1]] = +a.value;
        else if (k === 'UUID' || k === 'ParentUUID' || k === 'Name') rec[k] = a.value;
        else if (k === 'ParentScale') rec.scale = +a.value;
      }
      if (rec.UUID) gold[rec.UUID] = rec;
    }
  }
  const goldLookup = (uuid, level, depth = 0) => {
    const t = gold[uuid];
    if (!t || depth > 20) return [null, []];
    const lv = Object.keys(t.levels).map(Number);
    if (lv.length) {
      const below = lv.filter((k) => k <= level);
      return [t.levels[level] ?? t.levels[below.length ? Math.max(...below) : Math.min(...lv)], [t.Name || uuid]];
    }
    const [pv, chain] = goldLookup(t.ParentUUID, level, depth + 1);
    return pv == null ? [null, []] : [pv * (t.scale ?? 1), [t.Name || uuid, ...chain]];
  };
  const computeValue = (st) => {
    const ov = st.ValueOverride;
    if (ov && /^-?\d+(\.\d+)?$/.test(ov) && +ov > 0) return [Math.round(+ov), 'ValueOverride'];
    const lvl = parseInt(st.ValueLevel, 10), uuid = st.ValueUUID;
    if (!lvl || !uuid) return [null, null];
    const scale = +(st.ValueScale || 1);
    const [base, chain] = goldLookup(uuid, lvl);
    if (base == null) return [null, null];
    const v = base * scale;
    return [v > 0 ? Math.max(1, Math.round(v)) : 0, `GoldValues ${chain[0]}[Level${lvl}] x ValueScale ${scale} (ValueUUID chain: ${chain.join(' > ')})`];
  };

  // 7. items
  step(0.8, 'Resolving items');
  const chainOf = (key) => { const seen = []; const ids = new Set(); while (key && T[key] && !ids.has(key)) { ids.add(key); seen.push(T[key]); key = T[key].ParentTemplateId; } return seen; };
  const inherited = (chain, f) => { for (const t of chain) if (t[f]) return t[f]; return null; };
  const iconDir = 'public/game/gui/assets/tooltips/itemicons/';
  const icons = new Map();
  for (const p of fs.list((x) => x.toLowerCase().startsWith(iconDir) && /\.dds$/i.test(x))) icons.set(p.slice(iconDir.length, -4).toLowerCase(), p);
  const visualByName = {};
  for (const [id, v] of Object.entries(B.VisualBank)) if (v.Name && !visualByName[v.Name]) visualByName[v.Name] = id;

  const items = [];
  const assets = {};   // item id -> what the asset builder needs (template chain, visuals)
  for (const [stat, st] of Object.entries(stats).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (st._type !== 'Weapon' && st._type !== 'Armor') continue;
    const chain = chainOf(st.RootTemplate);
    if (!chain.length) continue;
    const loot = inherited(chain, 'VisualTemplate');
    const eqT = chain.find((t) => t.Equipment && Object.keys(t.Equipment.Visuals).length);
    if (!loot && !eqT) continue;
    const isWeapon = st._type === 'Weapon';
    const folder = isWeapon ? 'weapons' : (st.Slot === 'Melee Offhand Weapon' || (st.Slot === 'Breast' && !['', 'None', 'Cloth', undefined].includes(st.ArmorType))) ? 'armor' : 'clothing';
    const catType = isWeapon ? (st['Proficiency Group'] || '').split(';')[0] : `${st.Slot}/${st.ArmorType}`;
    // worn visuals per body type: exact body key, then name-prefix fallback
    const pick = (key, prefixes) => {
      if (!eqT) return [];
      const V = eqT.Equipment.Visuals;
      if (V[key]) return V[key];
      for (const pre of prefixes) for (const [k, list] of Object.entries(V)) if (list.some((v) => (B.VisualBank[v]?.Name || '').match(pre))) return V[k];
      return [];
    };
    const wornM = pick(BODY_HUM_M, [/^HUM_M_/, /^HUM_F_/, /^HUM_/, /./]).filter((v) => B.VisualBank[v]);
    const wornF = pick(BODY_HUM_F, [/^HUM_F_/]).filter((v) => B.VisualBank[v]);
    const equipment = chain.find((t) => t.Equipment && (t.Equipment.ColorPreset || t.Equipment.GroupPresets.length || Object.keys(t.Equipment.VectorOverrides).length))?.Equipment || null;
    assets[stat] = { folder, loot: B.VisualBank[loot] ? loot : null, wornM, wornF, equipment };

    const tid = st.RootTemplate;
    const nameH = inherited(chain, 'DisplayName'), descH = inherited(chain, 'Description');
    const name = localize(loca, nameH) || humanizeId(stat);
    const desc = localize(loca, descH) || '';
    const isShield = st.Shield === 'Yes';
    let weapon = null, armor = null;
    if (isWeapon) {
      let rng = null; const wr = num(st.WeaponRange);
      if (wr != null && (/Ranged/.test(st.Slot || '') || /Ranged/.test(st['Weapon Group'] || ''))) rng = `${wr > 100 ? wr / 100 : wr}m`;
      weapon = { damage: st.Damage || null, damageType: st['Damage Type'] || null, versatileDamage: st.VersatileDamage || null, range: rng,
        properties: (st['Weapon Properties'] || '').split(';').filter(Boolean), proficiency: (st['Proficiency Group'] || '').split(';').filter(Boolean),
        weaponGroup: st['Weapon Group'] || null };
    } else {
      const all = BOOST_FIELDS.map(([f]) => st[f] || '').join(';');
      const ac = num(st.ArmorClass), aca = st['Armor Class Ability'];
      armor = { armorClass: ac, armorType: ['', 'None', undefined].includes(st.ArmorType) ? null : st.ArmorType,
        abilityModifier: ABILITIES.has(aca) && ac != null && !isShield ? aca : null, abilityModifierCap: num(st['Ability Modifier Cap']),
        proficiency: (st['Proficiency Group'] || '').split(';').filter(Boolean),
        stealthDisadvantage: /Disadvantage\(\s*Skill\s*,\s*Stealth\s*\)/.test(all) || /stealth/i.test(st.Flags || '') };
    }
    const boosts = [];
    for (const [f, when] of BOOST_FIELDS) for (const b of splitTop(st[f] || '')) boosts.push({ raw: b, text: boostText(b, res), when });
    const passives = [];
    for (const f of PASSIVE_FIELDS) for (const p of (st[f] || '').split(';').map((x) => x.trim()).filter(Boolean))
      passives.push({ id: p, name: res.nameOf(p) || splitCamel(p), description: res.descOf(p) || '' });
    const [value, valueSource] = computeValue(st);
    const iconName = inherited(chain, 'Icon');
    const base = `../vfs/${folder}/${stat}/`;
    const hideM = [...new Set(wornM.flatMap(hideOf))].sort((a, b) => a - b), hideF = [...new Set(wornF.flatMap(hideOf))].sort((a, b) => a - b);
    items.push({
      id: stat, uuid: tid,
      category: isWeapon ? 'weapons' : (['VanityBody', 'VanityBoots', 'Underwear'].includes(st.Slot) ? 'clothing' : 'armor'),
      slotGroup: isWeapon ? null : (SLOT_GROUPS[st.Slot || ''] || 'Other'),
      hideBody: hideM.length || hideF.length ? { M: hideM, F: hideF } : null,
      type: typeValue(catType, st, isWeapon), typeLabel: typeLabel(catType, st, isWeapon), slot: st.Slot || null,
      name, description: desc, rarity: st.Rarity || 'Common',
      icon: icons.has((iconName || '').toLowerCase()) ? base + 'icon.png' : null,
      models: { loot: assets[stat].loot ? base + 'loot.gltf' : null, worn: wornM.length ? base + 'worn.gltf' : null,
        wornF: wornF.length ? base + 'worn_f.gltf' : null, rigM: wornM.length ? base + 'rig_m.gltf' : null, rigF: wornF.length ? base + 'rig_f.gltf' : null },
      weight: num(st.Weight), value, valueSource, weapon, armor, boosts, passives,
      stats: Object.fromEntries(Object.keys(st).sort().map((k) => [k, st[k]])),
    });
    assets[stat].icon = icons.get((iconName || '').toLowerCase()) || null;
  }

  // 8. dyes
  step(0.9, 'Reading dyes');
  const dyes = [];
  const dyeAssets = {};
  for (const [name] of Object.entries(rawAll).filter(([n, e]) => n.startsWith('OBJ_Dye_') && e.data.RootTemplate).sort((a, b) => a[0].localeCompare(b[0]))) {
    const chain = chainOf(rawAll[name].data.RootTemplate);
    const pid = inherited(chain, 'ColorPreset');
    const preset = B.MaterialPresetBank[pid];
    if (!preset) continue;
    const colors = {};
    for (const [k, v] of Object.entries(preset.Vector)) if (COLOR_SLOTS.includes(k)) colors[k] = String(v).split(/\s+/).slice(0, 3).map(Number);
    const hex = (c) => '#' + c.map((x) => Math.max(0, Math.min(255, Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255))).toString(16).padStart(2, '0')).join('');
    const iconName = inherited(chain, 'Icon');
    const iconPath = icons.get((iconName || '').toLowerCase());
    dyeAssets[name] = { icon: iconPath || null };
    dyes.push({ id: name, name: localize(loca, inherited(chain, 'DisplayName')) || name.replace('OBJ_Dye_', '') + ' Dye',
      description: localize(loca, inherited(chain, 'Description')) || '', rarity: rawGet(name, 'Rarity') || 'Common',
      icon: iconPath ? `../vfs/dyes/${name}.png` : null, preset: preset.Name,
      swatch: ['Cloth_Primary', 'Leather_Primary', 'Metal_Primary'].filter((k) => colors[k]).map((k) => hex(colors[k])), colors });
  }

  // 9. Dressing Room: bodies, heads, poses
  step(0.95, 'Finding poses');
  const poses = { M: [], F: [] };
  const poseAssets = {};
  for (const b of ['M', 'F']) {
    const dir = new RegExp(`/Humans/_${b === 'M' ? 'Male' : 'Female'}/HUM_${b}_Rig/HUM_${b}_Rig_DFLT_(PM_.+|IDLE_Still_Peace_01)\\.GR2$`, 'i');
    const seen = new Set();
    for (const p of fs.list((x) => dir.test(x))) {
      const stem = p.split('/').pop().replace(/\.GR2$/i, '');
      if (seen.has(stem.toLowerCase())) continue;
      seen.add(stem.toLowerCase());
      const idle = /IDLE_Still_Peace_01$/i.test(stem);
      const id = idle ? 'idle' : stem.replace(new RegExp(`^HUM_${b}_Rig_DFLT_PM_`, 'i'), '');
      let nm = stem.replace(new RegExp(`^HUM_${b}_Rig_DFLT_PM_`, 'i'), '').replace(/_0?(\d+)$/, (m0, d) => (d === '1' ? '' : ` ${d}`));
      nm = nm.replace(/_/g, ' ').replace(/(?<=[a-z])(?=[A-Z])/g, ' ').trim();
      poses[b].push({ id, name: idle ? 'Idle' : nm, url: `../vfs/dressing/poses/${b}/${id}.gltf`, animated: idle });
      poseAssets[`${b}/${id}`] = p;
    }
    poses[b].sort((x, y) => (x.id !== 'idle') - (y.id !== 'idle') || x.name.localeCompare(y.name));
  }
  const dressing = {
    bodies: { M: '../vfs/dressing/body_M.gltf', F: '../vfs/dressing/body_F.gltf' },
    heads: { M: '../vfs/dressing/head_M.gltf', F: '../vfs/dressing/head_F.gltf' },
    poses,
    bodyRegions: Object.fromEntries(Object.entries(regions).sort((a, b) => a[1] - b[1])),
  };

  // keep only the bank entries the asset builder can reach (the index is cached in the browser)
  const used = { VisualBank: {}, MaterialBank: {}, TextureBank: {}, VirtualTextureBank: {}, MaterialPresetBank: {} };
  for (const a of Object.values(assets)) {
    for (const vid of [a.loot, ...a.wornM, ...a.wornF]) {
      const v = B.VisualBank[vid];
      if (!v) continue;
      used.VisualBank[vid] = v;
      for (const o of v.Objects) {
        const m = B.MaterialBank[o.MaterialID];
        if (!m) continue;
        used.MaterialBank[o.MaterialID] = m;
        for (const p of m.Texture2D) if (B.TextureBank[p.ID]) used.TextureBank[p.ID] = B.TextureBank[p.ID];
        for (const p of m.VirtualTexture) if (B.VirtualTextureBank[p.ID]) used.VirtualTextureBank[p.ID] = B.VirtualTextureBank[p.ID];
      }
    }
    for (const pid of [a.equipment?.ColorPreset, ...(a.equipment?.GroupPresets || [])]) if (pid && B.MaterialPresetBank[pid]) used.MaterialPresetBank[pid] = B.MaterialPresetBank[pid];
  }

  step(1, 'Ready');
  return {
    items: { generated: new Date().toISOString(), items }, dyes: { dyes }, dressing,
    // engine-internal (not served): what the asset builder needs
    _assets: assets, _dyeAssets: dyeAssets, _poseAssets: poseAssets, _banks: used,
    _stats: { ms: Math.round(performance.now() - T0), items: items.length, dyes: dyes.length, banks: bankFiles.length },
  };
}
