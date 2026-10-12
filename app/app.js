// The Camp Chest - BG3 item catalog UI (vanilla ES module, no build step)
// Data: ../data/items.json (contract in CONTRACT.md); falls back to assets/sample-items.json.
// Dyes: ../data/dyes.json; falls back to assets/sample-dyes.json. Hash: #ITEMID or #ITEMID&dye=DYEID.
// Viewer: ./viewer.js (createViewer), imported lazily so the catalog works without it.
// Dressing Room: ./dressing-ui.js (its 3D scene ./dressing.js loads on first open). Hash: #dress&...

import { createDressingUI, isDressHash, isDressable } from './dressing-ui.js';

const DATA_URL = '../vfs/data/items.json';
const SAMPLE_URL = 'assets/sample-items.json';
const STORE_KEY = 'bg3catalog.ui.v1';
const DYES_URL = '../vfs/data/dyes.json';
const DYES_SAMPLE_URL = 'assets/sample-dyes.json';
const DYE_SLOTS = ['Cloth_Primary', 'Cloth_Secondary', 'Cloth_Tertiary', 'Accent_Color',
  'Leather_Primary', 'Leather_Secondary', 'Leather_Tertiary', 'Custom_1',
  'Metal_Primary', 'Metal_Secondary', 'Metal_Tertiary', 'Custom_2'];
const DYE_FILTER_MIN = 12;   // show the dye filter box above this many dyes

const RARITIES = ['Common', 'Uncommon', 'Rare', 'VeryRare', 'Legendary', 'Story'];
const RARITY_LABEL = { Common: 'Common', Uncommon: 'Uncommon', Rare: 'Rare', VeryRare: 'Very Rare', Legendary: 'Legendary', Story: 'Story Item' };
const CATEGORY_LABEL = { weapons: 'Weapon', armor: 'Armour', clothing: 'Clothing' };
const WHEN_LABEL = { MainHand: 'when in main hand', OffHand: 'when in off hand', Equipped: 'when equipped', Always: '' };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- storage
const store = {
  read() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } },
  write(patch) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...store.read(), ...patch })); } catch { /* private mode etc. */ }
  },
};
const saved = store.read();

// ------------------------------------------------------------------ state
const state = {
  items: [],
  byId: new Map(),
  view: [],                 // filtered + sorted
  query: '',
  category: ['all', 'weapons', 'armor', 'clothing'].includes(saved.category) ? saved.category : 'all',
  type: '',
  slot: typeof saved.slot === 'string' ? saved.slot : '',   // armour sub-tab (slotGroup), '' = all
  rarity: '',
  sort: ['name', 'type', 'rarity', 'weight', 'value'].includes(saved.sort) ? saved.sort : 'name',
  selectedId: null,
  mode: saved.mode === 'loot' ? 'loot' : 'worn',   // preferred model when both exist
  body: saved.body === 'F' ? 'F' : 'M',             // worn body type: human male / female
  autoRotate: typeof saved.autoRotate === 'boolean' ? saved.autoRotate : !reducedMotion?.matches,
  dyeId: typeof saved.dye === 'string' && saved.dye ? saved.dye : null,   // validated once dyes load
  // 'catalog' | 'dress'. A #dress hash wins; an item hash means the catalogue; otherwise the saved view.
  page: isDressHash(location.hash) ? 'dress' : (location.hash.length > 1 ? 'catalog' : (saved.view === 'dress' ? 'dress' : 'catalog')),
};

const dyeState = {
  list: [],
  byId: new Map(),
  sample: false,
  supported: null,          // viewer has setDye(): null = not known yet
  dyeable: null,            // current model: true / false / null (unknown, load failed, no model)
  open: saved.dyeOpen !== false,
  filter: '',
  viewerDyeId: null,        // what the viewer was last told (undefined = unknown, resync)
};

// ------------------------------------------------------------------- dom
const el = {
  notice: $('#data-notice'),
  search: $('#search'),
  tabs: [...document.querySelectorAll('.tabs [role="tab"]')],
  subtabs: document.getElementById('subtabs'),
  fType: $('#f-type'),
  fRarity: $('#f-rarity'),
  fSort: $('#f-sort'),
  fClear: $('#f-clear'),
  count: $('#count'),
  grid: $('#grid'),
  empty: $('#empty'),
  emptyClear: $('#empty-clear'),
  tip: $('#tip'),
  stageName: $('#stage-name'),
  stageSub: $('#stage-sub'),
  mode: $('#mode'),
  body: $('#body'),
  rotate: $('#btn-rotate'),
  reset: $('#btn-reset'),
  viewer: $('#viewer'),
  loading: $('#viewer-loading'),
  bar: $('#viewer-bar'),
  loadingText: $('#viewer-loading-text'),
  msg: $('#viewer-msg'),
  card: $('#card'),
  dyeBar: $('#dye-bar'),
  dyeToggle: $('#dye-toggle'),
  dyeCount: $('#dye-count'),
  dyeSample: $('#dye-sample'),
  dyeStatus: $('#dye-status'),
  dyeFilterWrap: $('#dye-filter-wrap'),
  dyeFilter: $('#dye-filter'),
  dyeBody: $('#dye-body'),
  dyeTray: $('#dye-tray'),
  dyeEmpty: $('#dye-empty'),
  dyeNote: $('#dye-note'),
  dyeInd: $('#dye-ind'),
  dyeIndSw: $('#dye-ind-sw'),
  dyeIndName: $('#dye-ind-name'),
  dyeIndClear: $('#dye-ind-clear'),
};

// --------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;   // only used with static strings
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
// Click-to-copy id chip (UID = stats entry, UUID = RootTemplate GUID)
function copyChip(label, value, what) {
  const btn = h('button', { type: 'button', class: 'copy-chip', title: `${what}: click to copy`, 'aria-label': `Copy ${what} ${value}` },
    h('span', { class: 'copy-label' }, label), h('span', { class: 'copy-val' }, value));
  btn.addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; } catch {
      try { const ta = h('textarea', {}, value); ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch {}
    }
    btn.classList.add(ok ? 'copied' : 'copy-failed');
    btn.dataset.msg = ok ? 'Copied' : 'Copy failed';
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('copied', 'copy-failed'); }, 1400);
  });
  return btn;
}

const svgUse = (id, cls = '') => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};
const humanize = (s) => String(s ?? '')
  .replace(/^(WPN|ARM|OBJ|UNI)_/, '')
  .replace(/_/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .trim();
const asArray = (v) => Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/[;,]\s*/).filter(Boolean));
const fmtNum = (n, digits = 2) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : null;
const initials = (name) => {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]).toUpperCase();
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Put filigree corners on every .frame
function decorateFrames() {
  for (const f of document.querySelectorAll('.frame')) {
    for (const pos of ['tl', 'tr', 'bl', 'br']) f.append(svgUse('corner', 'corner ' + pos));
  }
}

// ------------------------------------------------------------- data load
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  try {
    const data = await fetchJson(DATA_URL);
    if (!Array.isArray(data?.items) || !data.items.length) throw new Error('items.json has no items');
    return { data, sample: false };
  } catch (err) {
    console.warn('[catalog] falling back to sample data:', err);
    const data = await fetchJson(SAMPLE_URL);
    return { data, sample: true, reason: err.message };
  }
}

function normalize(raw) {
  const it = { ...raw };
  it.id = String(raw.id ?? raw.stat ?? '');
  it.category = raw.category || 'clothing';
  it.name = raw.name || humanize(it.id);
  it.type = raw.type ?? '';
  it.typeLabel = raw.typeLabel || humanize(String(it.type).split('/').pop()) || CATEGORY_LABEL[it.category] || '';
  it.rarity = RARITIES.includes(raw.rarity) ? raw.rarity : 'Common';
  it.models = raw.models || {};
  it.boosts = Array.isArray(raw.boosts) ? raw.boosts.map((b) => typeof b === 'string' ? { raw: b, text: b } : b) : [];
  it.passives = Array.isArray(raw.passives) ? raw.passives.map((p) => typeof p === 'string' ? { id: p, name: humanize(p) } : p) : [];
  it.stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const w = it.weapon || {};
  it._search = [
    it.name, it.id, it.type, it.typeLabel, it.slot, RARITY_LABEL[it.rarity], CATEGORY_LABEL[it.category],
    w.damage, w.damageType, w.versatileDamage, asArray(w.properties).join(' '), asArray(w.proficiency).join(' '), w.weaponGroup,
    it.armor?.armorType, asArray(it.armor?.proficiency).join(' '),
    it.boosts.map((b) => `${b.text ?? ''} ${b.raw ?? ''}`).join(' '),
    it.passives.map((p) => `${p.name ?? ''} ${p.description ?? ''}`).join(' '),
    it.description,
  ].filter(Boolean).join(' ').toLowerCase();
  return it;
}

// -------------------------------------------------------- filter & sort
function computeView() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const rIdx = (r) => RARITIES.indexOf(r);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const numDesc = (k) => (a, b) => {
    const x = a[k], y = b[k];
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn && x !== y) return y - x;
    if (xn !== yn) return xn ? -1 : 1;
    return byName(a, b);
  };
  const sorters = {
    name: byName,
    type: (a, b) => a.category.localeCompare(b.category) || a.typeLabel.localeCompare(b.typeLabel) || byName(a, b),
    rarity: (a, b) => rIdx(b.rarity) - rIdx(a.rarity) || byName(a, b),
    weight: numDesc('weight'),
    value: numDesc('value'),
  };
  state.view = state.items
    .filter((it) => state.category === 'all' || it.category === state.category)
    .filter((it) => !hasSubtabs(state.category) || !state.slot || it.slotGroup === state.slot)
    .filter((it) => !state.type || it.typeLabel === state.type)
    .filter((it) => !state.rarity || it.rarity === state.rarity)
    .filter((it) => terms.every((t) => it._search.includes(t)))
    .sort(sorters[state.sort] || byName);
}

const SLOT_ORDER = ['Breast', 'Helmet', 'Gloves', 'Boots', 'Cloak', 'Amulet', 'Ring', 'Shield', 'Instrument',
  'Camp Clothes', 'Camp Shoes', 'Underwear', 'Other'];
const hasSubtabs = (cat) => cat === 'armor' || cat === 'clothing';

function renderSubtabs() {
  const armour = state.items.filter((it) => it.category === state.category);
  const groups = SLOT_ORDER.filter((g) => armour.some((it) => it.slotGroup === g));
  if (state.slot && !groups.includes(state.slot)) state.slot = '';
  el.subtabs.hidden = !hasSubtabs(state.category) || groups.length < 2;
  el.subtabs.setAttribute('aria-label', state.category === 'clothing' ? 'Clothing slot' : 'Armour slot');
  if (el.subtabs.hidden) return;
  const btn = (g, label, n) => {
    const on = state.slot === g;
    const b = h('button', { type: 'button', role: 'tab', class: 'subtab', 'data-slot': g, 'aria-selected': String(on), tabindex: on ? '0' : '-1' },
      label, h('span', { class: 'tab-count' }, `${n}`));
    b.addEventListener('click', () => { state.slot = g; store.write({ slot: g }); refreshFilterOptions(); applyFilters(); });
    return b;
  };
  el.subtabs.replaceChildren(btn('', 'All', armour.length),
    ...groups.map((g) => btn(g, g, armour.filter((it) => it.slotGroup === g).length)));
}

function refreshFilterOptions() {
  renderSubtabs();
  const inCat = state.items.filter((it) => (state.category === 'all' || it.category === state.category)
    && (!hasSubtabs(state.category) || !state.slot || it.slotGroup === state.slot));
  const types = [...new Set(inCat.map((it) => it.typeLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.type && !types.includes(state.type)) state.type = '';
  el.fType.replaceChildren(h('option', { value: '' }, 'All types'), ...types.map((t) => h('option', { value: t }, t)));
  el.fType.value = state.type;

  const rar = RARITIES.filter((r) => state.items.some((it) => it.rarity === r));
  el.fRarity.replaceChildren(h('option', { value: '' }, 'Any'), ...rar.map((r) => h('option', { value: r }, RARITY_LABEL[r])));
  el.fRarity.value = state.rarity;
  el.fSort.value = state.sort;

  for (const tab of el.tabs) {
    const cat = tab.dataset.cat;
    const n = cat === 'all' ? state.items.length : state.items.filter((it) => it.category === cat).length;
    $('.tab-count', tab).textContent = n ? `(${n})` : '';
    const on = cat === state.category;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
}

// ------------------------------------------------------------------ grid
function slotFor(it) {
  const slot = h('div', {
    class: 'slot', role: 'option', id: 'slot-' + it.id, 'data-id': it.id, 'data-rarity': it.rarity,
    'aria-selected': String(it.id === state.selectedId), tabindex: '-1',
    'aria-label': `${it.name}, ${RARITY_LABEL[it.rarity]} ${it.typeLabel}`,
  });
  const placeholder = () => h('span', { class: 'ph', 'aria-hidden': 'true' }, initials(it.name));
  if (it.icon) {
    const img = h('img', { src: it.icon, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
    slot.append(img);
  } else {
    slot.append(placeholder());
  }
  return slot;
}

function renderGrid() {
  computeView();
  const frag = document.createDocumentFragment();
  for (const it of state.view) frag.append(slotFor(it));
  el.grid.replaceChildren(frag);
  el.empty.hidden = state.view.length > 0;
  el.grid.hidden = state.view.length === 0;
  const total = state.items.length;
  el.count.textContent = state.view.length === total
    ? `${total} item${total === 1 ? '' : 's'}`
    : `${state.view.length} of ${total} items`;
  const filtered = !!(state.query || state.type || state.rarity || state.category !== 'all' || state.slot);
  el.fClear.hidden = !filtered;
  setRovingFocusTarget();
}

function setRovingFocusTarget() {
  const slots = el.grid.children;
  if (!slots.length) return;
  const sel = state.selectedId && document.getElementById('slot-' + state.selectedId);
  const target = sel || slots[0];
  for (const s of slots) s.tabIndex = s === target ? 0 : -1;
}

function columnsInGrid() {
  const slots = el.grid.children;
  if (slots.length < 2) return 1;
  const top = slots[0].offsetTop;
  let n = 0;
  for (const s of slots) { if (s.offsetTop !== top) break; n++; }
  return Math.max(1, n);
}

function onGridKey(e) {
  const slots = [...el.grid.children];
  if (!slots.length) return;
  const cur = slots.indexOf(document.activeElement);
  const i = cur < 0 ? 0 : cur;
  const cols = columnsInGrid();
  const rowsPerPage = Math.max(1, Math.floor(el.grid.parentElement.clientHeight / (slots[0].offsetHeight + 6)));
  let next = null;
  switch (e.key) {
    case 'ArrowRight': next = Math.min(slots.length - 1, i + 1); break;
    case 'ArrowLeft': next = Math.max(0, i - 1); break;
    case 'ArrowDown': next = i + cols < slots.length ? i + cols : i; break;
    case 'ArrowUp': next = i - cols >= 0 ? i - cols : i; break;
    case 'PageDown': next = Math.min(slots.length - 1, i + cols * rowsPerPage); break;
    case 'PageUp': next = Math.max(0, i - cols * rowsPerPage); break;
    case 'Home': next = e.ctrlKey ? 0 : i - (i % cols); break;
    case 'End': next = e.ctrlKey ? slots.length - 1 : Math.min(slots.length - 1, i - (i % cols) + cols - 1); break;
    case 'Enter': case ' ':
      e.preventDefault();
      if (cur >= 0) { select(slots[cur].dataset.id, { focus: false }); document.getElementById('details').focus({ preventScroll: true }); }
      return;
    default: return;
  }
  e.preventDefault();
  if (next != null && slots[next]) select(slots[next].dataset.id, { focus: true });
}

// --------------------------------------------------------------- tooltip
function showTip(slot) {
  const it = state.byId.get(slot.dataset.id);
  if (!it) return;
  placeTip(slot, [
    h('div', { class: 't-name r-' + it.rarity }, it.name),
    h('div', { class: 't-type' }, [it.typeLabel, RARITY_LABEL[it.rarity] !== 'Common' ? RARITY_LABEL[it.rarity] : null].filter(Boolean).join(' · ')),
  ]);
}
function placeTip(anchor, nodes) {
  el.tip.replaceChildren(...nodes);
  el.tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const t = el.tip.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2;
  let y = r.top - t.height - 8;
  if (y < 6) y = r.bottom + 8;
  x = Math.max(6, Math.min(window.innerWidth - t.width - 6, x));
  el.tip.style.left = `${Math.round(x)}px`;
  el.tip.style.top = `${Math.round(y)}px`;
}
const hideTip = () => { el.tip.hidden = true; };

// --------------------------------------------------------------- select
function select(id, { focus = false, scroll = true, fromHash = false } = {}) {
  const it = state.byId.get(id);
  if (!it) return;
  const changed = id !== state.selectedId;
  state.selectedId = id;
  for (const s of el.grid.querySelectorAll('[aria-selected="true"]')) s.setAttribute('aria-selected', 'false');
  const slot = document.getElementById('slot-' + id);
  if (slot) {
    slot.setAttribute('aria-selected', 'true');
    if (scroll) slot.scrollIntoView({ block: 'nearest', behavior: reducedMotion?.matches ? 'auto' : 'smooth' });
    if (focus) slot.focus({ preventScroll: true });
  }
  setRovingFocusTarget();
  if (!changed) return;
  store.write({ selected: id });
  if (!fromHash) writeHash();
  renderDetails(it);
  renderStageHeader(it);
  queueModel(it);
}

// ----------------------------------------------------------- details card
function renderDetails(it) {
  const w = it.weapon;
  const a = it.armor;
  const parts = [];

  parts.push(
    h('h2', { class: 'c-name r-' + it.rarity, id: 'card-title' }, it.name),
    h('div', { class: 'c-meta' },
      h('span', { class: 'c-rarity r-' + it.rarity }, RARITY_LABEL[it.rarity]),
      h('span', { class: 'c-sep', 'aria-hidden': 'true' }, '◆'),
      h('span', {}, it.typeLabel || CATEGORY_LABEL[it.category]),
      it.slot ? h('span', { class: 'c-sep', 'aria-hidden': 'true' }, '◆') : null,
      it.slot ? h('span', {}, humanize(it.slot)) : null,
    ),
    h('div', { class: 'divider', 'aria-hidden': 'true' }),
  );

  if (isDressable(it)) {
    const rigged = !!(it.models.rigM || it.models.rigF);
    const btn = h('button', { type: 'button', class: 'chip-btn c-equip', title: rigged ? 'Try it on in the Dressing Room' : 'Wear it in the Dressing Room (no worn model; shown as an icon)' },
      'Equip in Dressing Room');
    btn.addEventListener('click', () => equipInDressingRoom(it.id));
    parts.splice(2, 0, h('div', { class: 'c-actions' }, btn));
  }

  // Headline: damage
  if (w && (w.damage || w.damageType)) {
    const dmgType = w.damageType ? h('span', { class: 'dmg-type dt-' + w.damageType }, ' ' + w.damageType) : null;
    const subs = [];
    if (w.versatileDamage) subs.push(h('span', {}, 'Versatile: ', h('b', {}, w.versatileDamage), ' two-handed'));
    if (w.range) subs.push(h('span', {}, 'Range ', h('b', {}, String(w.range))));
    parts.push(h('div', { class: 'headline' },
      h('div', { class: 'dice-badge', 'aria-hidden': 'true' }, svgUse('i-sword')),
      h('div', {},
        h('div', { class: 'h-main' }, h('span', { class: 'visually-hidden' }, 'Damage: '), w.damage || '—', dmgType),
        subs.length ? h('div', { class: 'h-sub' }, ...subs.flatMap((s, i) => i ? [' · ', s] : [s])) : null,
      ),
    ));
  }

  // Headline: armour class
  if (a && a.armorClass != null) {
    const isShield = /shield/i.test(`${it.typeLabel} ${it.type} ${it.slot}`) || asArray(a.proficiency).includes('Shields');
    let modLine;
    if (isShield) modLine = 'Added to your Armour Class while equipped';
    else if (a.abilityModifier && a.abilityModifier !== 'None') {
      modLine = [`+ ${a.abilityModifier} modifier`, a.abilityModifierCap != null && a.abilityModifierCap !== 0 ? h('b', {}, ` (max ${a.abilityModifierCap})`) : null];
    } else modLine = 'No ability modifier';
    parts.push(h('div', { class: 'headline' },
      h('div', { class: 'h-icon', 'aria-hidden': 'true' }, svgUse('i-shield'), h('b', {}, (isShield ? '+' : '') + a.armorClass)),
      h('div', {},
        h('div', { class: 'h-main' }, `${isShield ? '+' : ''}${a.armorClass} Armour Class`),
        h('div', { class: 'h-sub' }, ...[].concat(modLine)),
        a.stealthDisadvantage ? h('div', { class: 'h-sub warn' }, 'Disadvantage on Stealth checks') : null,
      ),
    ));
  }

  // Properties / proficiency
  const props = asArray(w?.properties);
  const prof = [...asArray(w?.proficiency), ...asArray(a?.proficiency)];
  if (props.length || prof.length || a?.armorType) {
    const tags = [
      ...props.map((p) => h('li', {}, humanize(p))),
      ...(a?.armorType && a.armorType !== 'None' ? [h('li', {}, humanize(a.armorType))] : []),
      ...[...new Set(prof)].map((p) => h('li', { class: 'muted', title: 'Proficiency' }, humanize(p))),
    ];
    parts.push(h('section', { class: 'section', 'aria-label': 'Properties' },
      h('h3', {}, 'Properties'), h('ul', { class: 'tags' }, tags)));
  }

  // Boosts
  if (it.boosts.length) {
    parts.push(h('section', { class: 'section' }, h('h3', {}, 'Effects'),
      h('ul', { class: 'boosts' }, it.boosts.map((b) => {
        const when = b.when && WHEN_LABEL[b.when] !== undefined ? WHEN_LABEL[b.when] : (b.when ? `(${humanize(b.when)})` : '');
        const showRaw = b.raw && b.text && b.raw !== b.text;
        return h('li', {}, b.text || b.raw, when ? h('span', { class: 'when' }, when) : null,
          showRaw ? h('code', { class: 'raw' }, b.raw) : null);
      }))));
  }

  // Passives
  if (it.passives.length) {
    parts.push(h('section', { class: 'section' }, h('h3', {}, 'Passives'),
      h('dl', {}, it.passives.map((p) => h('div', { class: 'passive' },
        h('dt', {}, p.name || humanize(p.id)),
        p.description ? h('dd', {}, p.description) : null)))));
  }

  if (it.description) parts.push(h('p', { class: 'desc' }, it.description));

  // Footer: weight + value
  const weight = fmtNum(it.weight);
  const value = fmtNum(it.value, 0);
  parts.push(h('div', { class: 'footer-stats' },
    h('span', { title: 'Weight' }, svgUse('i-weight'), h('span', { class: 'visually-hidden' }, 'Weight '), weight != null ? `${weight} kg` : '—'),
    h('span', { title: it.valueSource ? `Value (${it.valueSource})` : 'Value' }, svgUse('i-coin'), h('span', { class: 'visually-hidden' }, 'Value '), value != null ? value : '—'),
  ));
  parts.push(h('div', { class: 'footer-ids' },
    copyChip('UID', it.id, 'Stats entry name'),
    it.uuid ? copyChip('UUID', it.uuid, 'RootTemplate UUID') : null));

  // All data
  const rows = [];
  const pushGroup = (label) => rows.push(h('tr', { class: 'group' }, h('th', { colspan: '2', scope: 'colgroup' }, label)));
  const fmt = (v) => v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));
  pushGroup('Catalog');
  for (const [k, v] of [['id', it.id], ['category', it.category], ['type', it.type], ['slot', it.slot],
    ['rarity', it.rarity], ['icon', it.icon], ['models.loot', it.models.loot], ['models.worn', it.models.worn], ['models.wornF', it.models.wornF],
    ['valueSource', it.valueSource]]) {
    rows.push(h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, fmt(v))));
  }
  const statEntries = Object.entries(it.stats);
  if (statEntries.length) {
    pushGroup('Stats');
    for (const [k, v] of statEntries) rows.push(h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, fmt(v))));
  }
  const det = h('details', { class: 'raw' },
    h('summary', {}, h('span', {}, `All data (${statEntries.length} fields)`)),
    h('table', { class: 'raw-table' }, h('tbody', {}, rows)));
  det.open = !!store.read().rawOpen;
  det.addEventListener('toggle', () => store.write({ rawOpen: det.open }));
  parts.push(det);

  el.card.replaceChildren(...parts.filter(Boolean));
  document.getElementById('details').setAttribute('aria-labelledby', 'card-title');
}

function renderStageHeader(it) {
  el.stageName.textContent = it.name;
  el.stageName.className = 'stage-name r-' + it.rarity;
  const hasLoot = !!it.models.loot, hasWorn = !!(it.models.worn || it.models.wornF);
  el.mode.hidden = !(hasLoot && hasWorn);
  const mode = currentMode(it);
  for (const b of el.mode.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  // body toggle: only for worn models that exist in both body types
  const both = !!(it.models.worn && it.models.wornF);
  el.body.hidden = !(mode === 'worn' && both);
  const body = currentBody(it);
  for (const b of el.body.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.body === body));
  el.stageSub.textContent = !hasLoot && !hasWorn ? 'No model available'
    : mode === 'worn' ? `Worn · ${body === 'F' ? 'female' : 'male'} body (T-pose shell)` : 'On the ground';
}

function currentMode(it) {
  const worn = it.models.worn || it.models.wornF;
  if (worn && it.models.loot) return state.mode;
  return worn ? 'worn' : 'loot';
}

function currentBody(it) {
  if (it.models.worn && it.models.wornF) return state.body;
  return it.models.wornF && !it.models.worn ? 'F' : 'M';
}

function wornUrl(it) {
  return currentBody(it) === 'F' ? it.models.wornF : it.models.worn;
}

// ----------------------------------------------------------------- viewer
let viewerPromise = null;
let viewer = null;
let viewerFailed = false;
let loadToken = 0;
let running = false;
let queued = null;

function getViewer() {
  if (!viewerPromise) {
    viewerPromise = import('./viewer.js').then((mod) => {
      if (typeof mod.createViewer !== 'function') throw new Error('viewer.js does not export createViewer');
      const v = mod.createViewer(el.viewer, { background: 'transparent', glow: false });
      if (typeof v?.on === 'function') {
        v.on('progress', (p) => {
          if (typeof p === 'number' && isFinite(p)) setProgress(p);
        });
      }
      v.setAutoRotate?.(state.autoRotate);
      dyeState.supported = typeof v?.setDye === 'function';
      if (dyeState.supported && typeof v?.on === 'function') {
        try {
          v.on('dyeable', (on) => { dyeState.dyeable = !!on; updateDyeUI(); });
        } catch { /* older viewer: fall back to v.dyeable after each load */ }
      }
      viewer = v;
      updateDyeUI();
      return v;
    });
    viewerPromise.catch((err) => {
      viewerFailed = true;
      dyeState.supported = false;
      updateDyeUI();
      console.error('[catalog] viewer failed to start:', err);
      setLoading(false);
      showViewerMessage('3D viewer unavailable', 'The model viewer could not be started. Item details still work.', err?.message);
      el.rotate.disabled = el.reset.disabled = true;
    });
  }
  return viewerPromise;
}

function setLoading(on, label = 'Summoning model…') {
  el.loading.hidden = !on;
  if (on) {
    el.loading.classList.add('indeterminate');
    el.bar.style.width = '';
    el.loading.removeAttribute('aria-valuenow');
    el.loadingText.textContent = label;
  }
}
function setProgress(p) {
  if (el.loading.hidden) return;
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  el.loading.classList.remove('indeterminate');
  el.bar.style.width = pct + '%';
  el.loading.setAttribute('aria-valuenow', String(pct));
}
function showViewerMessage(title, body, detail) {
  el.msg.replaceChildren(
    h('div', { class: 'm-title' }, title),
    body ? h('div', { class: 'm-body' }, body, detail ? h('br') : null, detail ? h('code', {}, detail) : null) : null,
  );
  el.msg.hidden = false;
}
const clearViewerMessage = () => { el.msg.hidden = true; el.msg.replaceChildren(); };

const queueModel = debounce((it) => showModel(it), 120);

let deferredModel = null;
function showModel(it) {
  if (state.page === 'dress') { deferredModel = it; return; }   // no hidden-catalogue model loads
  deferredModel = null;
  const token = ++loadToken;
  if (viewerFailed) return;
  const url = currentMode(it) === 'worn' ? wornUrl(it) : it.models.loot;
  clearViewerMessage();
  if (!url) {
    setLoading(false);
    viewer?.clear?.();
    dyeState.dyeable = null;
    updateDyeUI();
    showViewerMessage('No model', 'This item has no 3D model in the export.');
    return;
  }
  setLoading(true);
  queued = { url, token, it };
  pump();
}

// Serialise loads so the last requested model is always the one left on screen.
async function pump() {
  if (running) return;
  running = true;
  try {
    let v;
    try { v = await getViewer(); } catch { return; }
    while (queued) {
      const job = queued; queued = null;
      if (job.token !== loadToken) continue;
      // Make the viewer's sticky dye match the selection; load() re-applies it to the new model.
      if (dyeState.viewerDyeId !== state.dyeId) await pushDyeToViewer(v, state.dyeId);
      try {
        await v.load(job.url);
        if (job.token === loadToken) {
          setLoading(false); clearViewerMessage();
          dyeState.dyeable = readDyeable(v, job.it);
          updateDyeUI();
          if (dyeState.viewerDyeId !== state.dyeId) pushDyeToViewer(v, state.dyeId);
        }
      } catch (err) {
        console.error('[catalog] model load failed:', job.url, err);
        if (job.token === loadToken) {
          dyeState.dyeable = null;
          updateDyeUI();
          setLoading(false);
          showViewerMessage('Could not load model', `${job.it.name} failed to load.`, err?.message || String(err));
        }
      }
    }
  } finally {
    running = false;
  }
}

function setAutoRotate(on) {
  state.autoRotate = on;
  el.rotate.setAttribute('aria-pressed', String(on));
  store.write({ autoRotate: on });
  viewer?.setAutoRotate?.(on);
}

// ------------------------------------------------------------------- dyes
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const linToHex = (rgb) => '#' + rgb.slice(0, 3).map((c) => {
  const x = Math.max(0, Math.min(1, Number(c) || 0));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255).toString(16).padStart(2, '0');
}).join('');

function normalizeDye(raw) {
  const id = String(raw?.id ?? '');
  const colors = {};
  if (raw?.colors && typeof raw.colors === 'object') {
    for (const k of DYE_SLOTS) {
      const c = raw.colors[k];
      if (Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((n) => typeof n === 'number' && isFinite(n))) colors[k] = c.slice(0, 3);
    }
  }
  let swatch = (Array.isArray(raw?.swatch) ? raw.swatch : []).filter((c) => typeof c === 'string' && HEX_RE.test(c)).slice(0, 3);
  if (!swatch.length) swatch = ['Cloth_Primary', 'Leather_Primary', 'Metal_Primary'].filter((k) => colors[k]).map((k) => linToHex(colors[k]));
  while (swatch.length && swatch.length < 3) swatch.push(swatch[swatch.length - 1]);
  const name = raw?.name || humanize(id);
  const description = typeof raw?.description === 'string' ? raw.description : '';
  return {
    id, name, description, swatch, colors,
    rarity: RARITIES.includes(raw?.rarity) ? raw.rarity : 'Common',
    icon: raw?.icon || null,
    _search: `${name} ${id} ${description}`.toLowerCase(),
  };
}

async function loadDyes() {
  const parse = (data) => {
    const list = (Array.isArray(data?.dyes) ? data.dyes : []).map(normalizeDye).filter((d) => d.id);
    if (!list.length) throw new Error('dyes.json has no dyes');
    return list;
  };
  try {
    return { list: parse(await fetchJson(DYES_URL)), sample: false };
  } catch (err) {
    console.warn('[catalog] dyes: falling back to sample dyes:', err);
    try {
      return { list: parse(await fetchJson(DYES_SAMPLE_URL)), sample: true };
    } catch (err2) {
      console.warn('[catalog] no dyes available:', err2);
      return { list: [], sample: false };
    }
  }
}

// URL hash: "#ITEMID" (old links) or "#ITEMID&dye=DYEID". dye is null when absent.
function parseHash() {
  const [idPart = '', ...rest] = location.hash.slice(1).split('&');
  let id = '';
  try { id = decodeURIComponent(idPart); } catch { id = idPart; }
  const dye = new URLSearchParams(rest.join('&')).get('dye');
  return { id, dye };
}
function writeHash() {
  updateViewLinks();
  if (!state.selectedId || state.page === 'dress') return;
  let hash = '#' + encodeURIComponent(state.selectedId);
  if (state.dyeId) hash += '&dye=' + encodeURIComponent(state.dyeId);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function initDyes({ list, sample }, hashDye) {
  dyeState.list = list;
  dyeState.byId = new Map(list.map((d) => [d.id, d]));
  dyeState.sample = sample;
  if (hashDye != null && (hashDye === '' || dyeState.byId.has(hashDye))) state.dyeId = hashDye || null;
  else if (state.dyeId && !dyeState.byId.has(state.dyeId)) state.dyeId = null;
  store.write({ dye: state.dyeId });
  renderDyeTray();
  updateDyeUI();
}

function swatchBar(colors, cls = 'dye-swatch') {
  const bar = h('span', { class: cls, 'aria-hidden': 'true' });
  for (const c of colors) bar.append(h('i', { style: `background:${c}` }));
  return bar;
}

function dyeButton(d) {
  const b = h('button', {
    type: 'button', class: d ? 'dye' : 'dye dye-original', tabindex: '-1', 'aria-pressed': 'false',
    'data-dye': d ? d.id : '', 'data-rarity': d ? d.rarity : 'Common',
    'aria-label': d ? `${d.name}, ${RARITY_LABEL[d.rarity]} dye` : 'Original colours',
  });
  if (!d) {
    b.append(h('span', { class: 'dye-face dye-face-orig', 'aria-hidden': 'true' }, svgUse('i-reset')));
    return b;
  }
  const [c1 = '#3a3027', c2 = c1, c3 = c2] = d.swatch;
  const blob = () => h('span', { class: 'dye-face dye-blob', 'aria-hidden': 'true', style: `--c1:${c1};--c2:${c2};--c3:${c3}` });
  if (d.icon) {
    const img = h('img', { class: 'dye-face', src: d.icon, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(blob()), { once: true });
    b.append(img);
  } else {
    b.append(blob());
  }
  if (d.swatch.length) b.append(swatchBar(d.swatch));
  return b;
}

function renderDyeTray() {
  el.dyeTray.replaceChildren(dyeButton(null), ...dyeState.list.map(dyeButton));
  el.dyeCount.textContent = dyeState.list.length ? `(${dyeState.list.length})` : '';
  el.dyeSample.hidden = !dyeState.sample;
  applyDyeFilter();
}

const dyeButtons = () => [...el.dyeTray.children].filter((b) => !b.hidden);

function applyDyeFilter() {
  const terms = dyeState.filter.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const b of el.dyeTray.children) {
    const d = dyeState.byId.get(b.dataset.dye);
    if (!d) continue;   // "Original" is always shown
    b.hidden = !terms.every((t) => d._search.includes(t));
    if (!b.hidden) shown++;
  }
  el.dyeEmpty.hidden = !terms.length || shown > 0;
  syncDyeButtons();
}

// aria-pressed + roving tabindex (the pressed swatch, else the first visible one)
function syncDyeButtons() {
  const visible = dyeButtons();
  let target = null;
  for (const b of el.dyeTray.children) {
    const on = (b.dataset.dye || null) === state.dyeId;
    b.setAttribute('aria-pressed', String(on));
    if (on && !b.hidden) target = b;
  }
  const focused = visible.includes(document.activeElement) ? document.activeElement : null;
  target = focused || target || visible[0];
  for (const b of el.dyeTray.children) b.tabIndex = b === target ? 0 : -1;
}

function readDyeable(v, it) {
  if (!dyeState.supported) return null;
  if (v && 'dyeable' in v) return !!v.dyeable;
  return it ? it.category !== 'weapons' : null;   // viewer without the getter: best guess
}

function updateDyeUI() {
  const avail = dyeState.list.length > 0 && dyeState.supported !== false;
  const d = state.dyeId ? dyeState.byId.get(state.dyeId) : null;
  const wasHidden = el.dyeBar.hidden;
  el.dyeBar.hidden = !(avail && dyeState.dyeable === true);
  el.dyeNote.hidden = true; // weapons etc.: show nothing

  el.dyeToggle.setAttribute('aria-expanded', String(dyeState.open));
  el.dyeBody.hidden = !dyeState.open;
  el.dyeFilterWrap.hidden = !dyeState.open || dyeState.list.length <= DYE_FILTER_MIN;

  el.dyeInd.hidden = !(avail && d) || dyeState.dyeable === false;   // nothing on items that can't be dyed
  if (d) {
    el.dyeIndName.textContent = d.name;
    el.dyeIndName.className = 'r-' + d.rarity;
    el.dyeIndSw.replaceChildren(...d.swatch.map((c) => h('i', { style: `background:${c}` })));
    const inactive = dyeState.dyeable === false;
    el.dyeInd.classList.toggle('inactive', inactive);
    el.dyeInd.title = inactive ? 'This item cannot be dyed; the dye is kept for armour and clothing' : '';
  }
  syncDyeButtons();
  if (wasHidden && !el.dyeBar.hidden) revealPressedDye();
}

function revealPressedDye() {
  const b = el.dyeTray.querySelector('[aria-pressed="true"]');
  if (!b || b.hidden) return;
  const tray = el.dyeTray;
  const left = b.offsetLeft;   // tray is position: relative
  if (left < tray.scrollLeft || left + b.offsetWidth > tray.scrollLeft + tray.clientWidth) {
    tray.scrollLeft = Math.max(0, left - (tray.clientWidth - b.offsetWidth) / 2);
  }
}

let dyeStatusTimer = 0;
function flashDyeStatus(text) {
  el.dyeStatus.textContent = text;
  clearTimeout(dyeStatusTimer);
  dyeStatusTimer = setTimeout(() => { el.dyeStatus.textContent = ''; }, 4000);
}

let dyePushSeq = 0;
async function pushDyeToViewer(v, id, btn = null) {
  if (typeof v?.setDye !== 'function') return;
  const d = id ? dyeState.byId.get(id) : null;
  const seq = ++dyePushSeq;
  btn?.classList.add('busy');
  btn?.setAttribute('aria-busy', 'true');
  try {
    await v.setDye(d ? d.colors : null);
    if (seq === dyePushSeq) dyeState.viewerDyeId = d ? id : null;
  } catch (err) {
    console.error('[catalog] setDye failed:', id, err);
    if (seq === dyePushSeq) {
      dyeState.viewerDyeId = undefined;   // resync before the next load
      flashDyeStatus(`Could not apply ${d ? d.name : 'original colours'}`);
    }
  } finally {
    btn?.classList.remove('busy');
    btn?.removeAttribute('aria-busy');
  }
}

function applyDye(id, btn = null) {
  id = id && dyeState.byId.has(id) ? id : null;
  if (id === state.dyeId && dyeState.viewerDyeId === id) return;
  state.dyeId = id;
  store.write({ dye: id });
  writeHash();
  updateDyeUI();
  el.dyeStatus.textContent = '';
  // Without a viewer yet, pump() syncs the dye before the first load.
  if (viewer) pushDyeToViewer(viewer, id, btn);
}

function showDyeTip(b) {
  const d = dyeState.byId.get(b.dataset.dye);
  const nodes = d ? [
    h('div', { class: 't-name r-' + d.rarity }, d.name),
    h('div', { class: 't-type' }, ['Dye', RARITY_LABEL[d.rarity]].join(' · ')),
    d.description ? h('div', { class: 't-desc' }, d.description) : null,
  ] : [
    h('div', { class: 't-name' }, 'Original colours'),
    h('div', { class: 't-desc' }, "Restores the item's own colours."),
  ];
  placeTip(b, nodes.filter(Boolean));
}

function bindDyes() {
  el.dyeTray.addEventListener('click', (e) => {
    const b = e.target.closest('.dye');
    if (!b || b.hidden) return;
    for (const x of el.dyeTray.children) x.tabIndex = x === b ? 0 : -1;
    applyDye(b.dataset.dye || null, b);
  });
  el.dyeTray.addEventListener('keydown', (e) => {
    const btns = dyeButtons();
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = btns.length - 1;
    if (n == null) return;   // Enter / Space reach the button's own click
    e.preventDefault();
    for (const x of el.dyeTray.children) x.tabIndex = x === btns[n] ? 0 : -1;
    btns[n].focus();
    btns[n].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion?.matches ? 'auto' : 'smooth' });
    showDyeTip(btns[n]);
  });
  el.dyeTray.addEventListener('pointerover', (e) => { const b = e.target.closest('.dye'); if (b) showDyeTip(b); });
  el.dyeTray.addEventListener('pointerleave', hideTip);
  el.dyeTray.addEventListener('focusin', (e) => { const b = e.target.closest('.dye'); if (b && b.matches(':focus-visible')) showDyeTip(b); });
  el.dyeTray.addEventListener('focusout', hideTip);
  el.dyeTray.addEventListener('scroll', hideTip, { passive: true });
  // vertical wheel scrolls the single-row tray sideways, but only while it can still move
  el.dyeTray.addEventListener('wheel', (e) => {
    const t = el.dyeTray;
    if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = t.scrollWidth - t.clientWidth;
    if (max <= 0 || (e.deltaY < 0 && t.scrollLeft <= 0) || (e.deltaY > 0 && t.scrollLeft >= max - 1)) return;
    e.preventDefault();
    t.scrollLeft += e.deltaY;
  }, { passive: false });

  el.dyeToggle.addEventListener('click', () => {
    dyeState.open = !dyeState.open;
    store.write({ dyeOpen: dyeState.open });
    hideTip();
    updateDyeUI();
    if (dyeState.open) revealPressedDye();
  });

  const onFilter = debounce(() => { dyeState.filter = el.dyeFilter.value.trim(); applyDyeFilter(); }, 60);
  el.dyeFilter.addEventListener('input', onFilter);
  el.dyeFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (el.dyeFilter.value) { e.preventDefault(); el.dyeFilter.value = ''; dyeState.filter = ''; applyDyeFilter(); }
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      const first = dyeButtons().find((b) => b.dataset.dye) || dyeButtons()[0];
      if (first) { e.preventDefault(); first.focus(); }
    }
  });

  el.dyeIndClear.addEventListener('click', () => applyDye(null, el.dyeTray.querySelector('.dye-original')));
}

// ---------------------------------------------------------- dressing room
const viewEl = { app: document.querySelector('.app'), dress: document.getElementById('dress-app'), skip: document.querySelector('.skip-link') };
let dressUI = null;
function getDressUI() {
  if (!dressUI) {
    dressUI = createDressingUI({
      h, svgUse, placeTip, hideTip, dyeButton, store, initials, RARITY_LABEL, reducedMotion, fetchJson,
      items: () => state.items,
      dyes: () => dyeState,
      onHashUpdate: updateViewLinks,
      showInCatalog: (id) => {
        setView('catalog');
        if (!document.getElementById('slot-' + id)) clearAll();
        select(id);
        writeHash();
      },
    });
  }
  return dressUI;
}

function updateViewLinks() {
  const cat = state.selectedId ? '#' + encodeURIComponent(state.selectedId) + (state.dyeId ? '&dye=' + encodeURIComponent(state.dyeId) : '') : '#';
  const dress = dressUI ? dressUI.hash() : '#dress';
  for (const a of document.querySelectorAll('.view-switch a')) {
    a.href = a.dataset.view === 'dress' ? dress : cat;
    if (a.dataset.view === state.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/** Switches between the catalogue and the Dressing Room. `hash` (a #dress link) may carry an outfit. */
function setView(view, { hash = null } = {}) {
  view = view === 'dress' ? 'dress' : 'catalog';
  const was = state.page;
  state.page = view;
  store.write({ view });
  document.body.dataset.view = view;
  viewEl.app.hidden = view === 'dress';
  viewEl.dress.hidden = view !== 'dress';
  viewEl.skip.textContent = view === 'dress' ? 'Skip to outfits' : 'Skip to item details';
  hideTip();
  if (view === 'dress') {
    if (state.items.length) getDressUI().open(hash);
  } else {
    dressUI?.close();
    writeHash();
    if (deferredModel) showModel(deferredModel);
  }
  updateViewLinks();
  if (was !== view) document.title = view === 'dress' ? 'Dressing Room · BG3 Item Catalog' : 'Camp Chest · BG3 Item Catalog';
}

function equipInDressingRoom(id) {
  const ui = getDressUI();
  setView('dress');
  ui.equip(id, { dye: state.dyeId });
}

function bindViews() {
  for (const a of document.querySelectorAll('.view-switch a')) {
    a.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;   // let "open in new tab" work
      e.preventDefault();
      if (state.page === a.dataset.view) return;
      setView(a.dataset.view);
      const twin = (state.page === 'dress' ? viewEl.dress : viewEl.app).querySelector(`.view-switch a[data-view="${a.dataset.view}"]`);
      twin?.focus();
    });
  }
  viewEl.skip.addEventListener('click', (e) => {
    e.preventDefault();
    const target = state.page === 'dress' ? document.getElementById('d-side') : document.getElementById('details');
    target?.focus();
  });
}

// ----------------------------------------------------------------- wiring
function applyFilters({ keepSelection = true } = {}) {
  renderGrid();
  if (keepSelection && state.selectedId && document.getElementById('slot-' + state.selectedId)) {
    document.getElementById('slot-' + state.selectedId).scrollIntoView({ block: 'nearest' });
  }
}

function clearAll() {
  state.query = ''; state.type = ''; state.rarity = ''; state.category = 'all'; state.slot = '';
  el.search.value = '';
  store.write({ category: 'all', slot: '' });
  refreshFilterOptions();
  applyFilters();
}

function bind() {
  // search
  const onSearch = debounce(() => { state.query = el.search.value.trim(); applyFilters(); }, 60);
  el.search.addEventListener('input', onSearch);
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (el.search.value) { el.search.value = ''; state.query = ''; applyFilters(); }
      else el.search.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = el.grid.querySelector('[tabindex="0"]') || el.grid.firstElementChild;
      if (first) { e.preventDefault(); select(first.dataset.id, { focus: true }); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    el.search.focus();
    el.search.select();
  });

  // tabs
  for (const tab of el.tabs) {
    tab.addEventListener('click', () => {
      if (state.category !== tab.dataset.cat) state.slot = '';
      state.category = tab.dataset.cat;
      store.write({ category: state.category, slot: state.slot });
      refreshFilterOptions();
      applyFilters();
    });
  }
  el.tabs[0].parentElement.addEventListener('keydown', (e) => {
    const i = el.tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % el.tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + el.tabs.length) % el.tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = el.tabs.length - 1;
    if (n == null) return;
    e.preventDefault();
    el.tabs[n].focus();
    el.tabs[n].click();
  });

  // chips
  el.fType.addEventListener('change', () => { state.type = el.fType.value; applyFilters(); });
  el.fRarity.addEventListener('change', () => { state.rarity = el.fRarity.value; applyFilters(); });
  el.fSort.addEventListener('change', () => { state.sort = el.fSort.value; store.write({ sort: state.sort }); applyFilters(); });
  el.fClear.addEventListener('click', clearAll);
  el.emptyClear.addEventListener('click', () => { clearAll(); el.search.focus(); });

  // grid
  el.grid.addEventListener('click', (e) => {
    const slot = e.target.closest('.slot');
    if (slot) select(slot.dataset.id, { focus: true, scroll: false });
  });
  el.grid.addEventListener('keydown', onGridKey);
  el.grid.addEventListener('pointerover', (e) => { const s = e.target.closest('.slot'); if (s) showTip(s); });
  el.grid.addEventListener('pointerleave', hideTip);
  el.grid.addEventListener('focusin', (e) => { const s = e.target.closest('.slot'); if (s && s.matches(':focus-visible')) showTip(s); });
  el.grid.addEventListener('focusout', hideTip);
  el.grid.parentElement.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);

  // viewer controls
  el.mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    store.write({ mode: state.mode });
    const it = state.byId.get(state.selectedId);
    if (it) { renderStageHeader(it); showModel(it); }
  });
  el.body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-body]');
    if (!b || b.dataset.body === state.body) return;
    state.body = b.dataset.body;
    store.write({ body: state.body });
    const it = state.byId.get(state.selectedId);
    if (it) { renderStageHeader(it); showModel(it); }
  });
  el.rotate.addEventListener('click', () => setAutoRotate(!state.autoRotate));
  el.reset.addEventListener('click', () => viewer?.resetView?.());

  // dyes
  bindDyes();

  // deep links: #ITEMID or #ITEMID&dye=DYEID
  window.addEventListener('hashchange', () => {
    if (isDressHash(location.hash)) { setView('dress', { hash: location.hash }); return; }
    const { id: hid } = parseHash();
    if (state.page === 'dress') {
      if (!state.byId.has(hid)) return;    // e.g. a stray in-page anchor: stay in the Dressing Room
      setView('catalog');
    }
    const { id, dye } = parseHash();
    if (state.byId.has(id)) {
      if (!document.getElementById('slot-' + id)) { clearAll(); }
      select(id, { fromHash: true });
    }
    if (dye != null && dye !== (state.dyeId ?? '') && (dye === '' || dyeState.byId.has(dye))) applyDye(dye || null);
    writeHash();
  });
}

// ------------------------------------------------------------------- boot
async function boot() {
  decorateFrames();
  el.rotate.setAttribute('aria-pressed', String(state.autoRotate));
  bind();
  bindViews();
  const bootHash = location.hash;
  setView(state.page);   // the Dressing Room fills in once items are loaded

  const dyesPromise = loadDyes();   // in parallel with items; never rejects
  let loaded;
  try {
    loaded = await loadData();
  } catch (err) {
    el.count.textContent = 'No data';
    el.notice.hidden = false;
    el.notice.classList.add('error');
    el.notice.replaceChildren(h('strong', {}, 'Could not load items. '), `Neither ${DATA_URL} nor ${SAMPLE_URL} could be read (${err.message}).`);
    el.card.replaceChildren(h('p', { class: 'card-empty' }, 'No item data.'));
    return;
  }
  if (loaded.sample) {
    el.notice.hidden = false;
    el.notice.replaceChildren(h('strong', {}, 'Sample data. '), 'The catalog file ', h('code', {}, 'data/items.json'), ' was not found, so placeholder stats are shown.');
  }

  state.items = loaded.data.items.map(normalize).filter((it) => it.id);
  state.byId = new Map(state.items.map((it) => [it.id, it]));
  refreshFilterOptions();
  renderGrid();

  // Dyes are needed before the first model load so the saved dye is applied straight away.
  const { id: hashId, dye: hashDye } = parseHash();
  initDyes(await dyesPromise, hashDye);

  let initial = state.byId.has(hashId) ? hashId : (state.byId.has(saved.selected) ? saved.selected : null);
  if (initial && !document.getElementById('slot-' + initial)) {
    // keep deep-linked item visible even if a saved category would hide it
    state.category = 'all'; state.slot = '';
    refreshFilterOptions();
    renderGrid();
  }
  if (!initial) initial = state.view[0]?.id;
  if (initial) { select(initial, { scroll: true, fromHash: initial === hashId }); writeHash(); }
  else el.card.replaceChildren(h('p', { class: 'card-empty' }, 'No items.'));
  if (state.page === 'dress') setView('dress', { hash: isDressHash(bootHash) ? bootHash : null });
}

boot();
