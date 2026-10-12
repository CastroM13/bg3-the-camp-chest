// The Camp Chest - Dressing Room UI (vanilla ES module).
// The 3D scene lives in ./dressing.js and is imported lazily the first time the view opens
// (one WebGL context for the Dressing Room). app.js owns view switching and passes shared helpers in `ctx`.
//
// Hash: #dress&b=F&p=Flexing_01&s=clay&c=1&Helmet=ARM_Helmet_Metal~OBJ_Dye_Azure&Breast=...
//   b = body (M|F), p = pose id ('tpose' for none), s = skin id, c=1 = camp set shown,
//   one param per filled slot: ITEMID or ITEMID~DYEID.

const DRESSING_URL = '../vfs/dressing/dressing.json';
const OUTFITS_KEY = 'bg3catalog.outfits.v1';

// Equipment slots. `group` = items.json slotGroup that fits. `model` = has a worn 3D model.
export const SLOTS = [
  { key: 'Helmet', group: 'Helmet', label: 'Helmet', model: true },
  { key: 'Cloak', group: 'Cloak', label: 'Cloak', model: true },
  { key: 'Breast', group: 'Breast', label: 'Armour', model: true },
  { key: 'Gloves', group: 'Gloves', label: 'Gloves', model: true },
  { key: 'Boots', group: 'Boots', label: 'Boots', model: true },
  { key: 'Amulet', group: 'Amulet', label: 'Amulet', model: false },
  { key: 'Ring1', group: 'Ring', label: 'Ring 1', model: false },
  { key: 'Ring2', group: 'Ring', label: 'Ring 2', model: false },
  { key: 'Underwear', group: 'Underwear', label: 'Underwear', model: true },
  { key: 'CampClothes', group: 'Camp Clothes', label: 'Camp Clothes', model: true },
  { key: 'CampShoes', group: 'Camp Shoes', label: 'Camp Shoes', model: true },
];
const SLOT = Object.fromEntries(SLOTS.map((s) => [s.key, s]));
const LEFT = ['Helmet', 'Cloak', 'Breast', 'Gloves', 'Boots'];
const RIGHT = ['Amulet', 'Ring1', 'Ring2', 'Underwear'];
const CAMP_SWAP = { Breast: 'CampClothes', Boots: 'CampShoes' };
const GROUPS = new Set(SLOTS.map((s) => s.group));
const MODEL_GROUPS = new Set(SLOTS.filter((s) => s.model).map((s) => s.group));
const FILTERS = [
  ['', 'All'], ['Helmet', 'Helmet'], ['Cloak', 'Cloak'], ['Breast', 'Armour'], ['Gloves', 'Gloves'], ['Boots', 'Boots'],
  ['Amulet', 'Amulet'], ['Ring', 'Ring'], ['Underwear', 'Underwear'], ['Camp Clothes', 'Camp Clothes'], ['Camp Shoes', 'Camp Shoes'],
];
export const SKINS = [
  { id: 'clay', name: 'Clay mannequin', hex: '#8f8b86' },
  { id: 'porcelain', name: 'Porcelain', hex: '#f2d6c2' },
  { id: 'fair', name: 'Fair', hex: '#e2b896' },
  { id: 'tan', name: 'Tan', hex: '#c68d63' },
  { id: 'brown', name: 'Brown', hex: '#94603e' },
  { id: 'umber', name: 'Umber', hex: '#674029' },
  { id: 'ebony', name: 'Ebony', hex: '#3e271a' },
];
const SKIN = Object.fromEntries(SKINS.map((s) => [s.id, s]));
const POSE_TPOSE = 'tpose';

export const isDressHash = (hash) => /^#?dress(?:&|$)/.test(hash || '');

/** True when the item can go in a Dressing Room slot (rigged wearable, or amulet / ring as data only). */
export function isDressable(it) {
  if (!it || !GROUPS.has(it.slotGroup)) return false;
  if (!MODEL_GROUPS.has(it.slotGroup)) return true;
  return !!(it.models?.rigM || it.models?.rigF);
}

export function createDressingUI(ctx) {
  const { h, svgUse, placeTip, hideTip, store, RARITY_LABEL, initials } = ctx;
  const reduced = () => !!ctx.reducedMotion?.matches;
  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('dress-app'), search: $('d-search'), filter: $('d-filter'), count: $('d-count'), grid: $('d-grid'), empty: $('d-empty'),
    sub: $('d-sub'), body: $('d-body'), camp: $('d-camp'), posePop: $('d-pose-pop'), poseName: $('d-pose-name'),
    poseFilter: $('d-pose-filter'), pose: $('d-pose'), skinPop: $('d-skin-pop'), skinSw: $('d-skin-sw'), skinName: $('d-skin-name'),
    skin: $('d-skin'), play: $('d-play'), reset: $('d-reset'), drop: $('d-drop'), viewer: $('d-viewer'), loading: $('d-loading'),
    busy: $('d-busy'), msg: $('d-msg'), left: $('d-slots-left'), right: $('d-slots-right'), bottom: $('d-slots-bottom'),
    status: $('d-status'), dyeBar: $('d-dye-bar'), dyeTarget: $('d-dye-target'), dyeAll: $('d-dye-all'), dyeFilter: $('d-dye-filter'),
    dyeTray: $('d-dye-tray'), dyeMsg: $('d-dye-msg'), piece: $('d-piece'), save: $('d-save'), outfitName: $('d-outfit-name'),
    outfitList: $('d-outfit-list'), outfitEmpty: $('d-outfit-empty'), share: $('d-share'), random: $('d-random'), clear: $('d-clear'),
    outfitStatus: $('d-outfit-status'), ghost: $('d-ghost'), side: $('d-side'),
  };

  // ------------------------------------------------------------------ state
  const saved = store.read().dress || {};
  const st = {
    body: saved.body === 'F' ? 'F' : 'M',
    pose: typeof saved.pose === 'string' ? saved.pose : 'idle',
    skin: SKIN[saved.skin] ? saved.skin : 'clay',
    camp: !!saved.camp,
    slots: {},          // key -> { id, dye }
    selected: SLOT[saved.selected] ? saved.selected : 'Breast',
    filter: '', query: '', dyeFilter: '', focusId: null,
  };
  let items = [];       // dressable items, sorted
  let byId = new Map();
  let data = null;      // dressing.json
  let dataPromise = null;
  let dr = null;        // dressing.js room
  let drPromise = null;
  let isOpen = false;
  let built = false;
  let lastPose = undefined;
  let playing = !reduced();

  const dyes = () => ctx.dyes();
  const dyeById = (id) => (id ? dyes().byId.get(id) || null : null);
  const itemOf = (key) => { const e = st.slots[key]; return e ? byId.get(e.id) || null : null; };
  const fits = (key, it) => !!it && SLOT[key]?.group === it.slotGroup;
  const shownKey = (pos) => (st.camp && CAMP_SWAP[pos]) || pos;
  const rigFor = (it, body = st.body) => (body === 'F' ? it?.models?.rigF : it?.models?.rigM) || null;
  const hasModel = (it) => !!(it?.models?.rigM || it?.models?.rigF);
  const torsoKey = () => (st.camp ? 'CampClothes' : 'Breast');

  /** Is the slot's piece part of the visible worn set (camp swap, underwear under armour)? */
  function visible3D(key) {
    if (!SLOT[key].model || !itemOf(key)) return false;
    if (st.camp && (key === 'Breast' || key === 'Boots')) return false;
    if (!st.camp && (key === 'CampClothes' || key === 'CampShoes')) return false;
    if (key === 'Underwear' && itemOf(torsoKey())) return false; // as in the game: underwear shows without body armour
    return true;
  }

  // ------------------------------------------------------------- persistence
  function snapshot() {
    const slots = {};
    for (const [k, v] of Object.entries(st.slots)) if (v && byId.has(v.id)) slots[k] = { id: v.id, dye: v.dye || null };
    return { body: st.body, pose: st.pose, skin: st.skin, camp: st.camp, slots };
  }
  function persist() {
    store.write({ dress: { ...snapshot(), selected: st.selected } });
    if (isOpen) {
      const hash = hashString();
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }
    ctx.onHashUpdate?.();
  }
  function hashString() {
    const parts = ['dress', `b=${st.body}`, `p=${encodeURIComponent(st.pose)}`, `s=${st.skin}`];
    if (st.camp) parts.push('c=1');
    for (const s of SLOTS) {
      const e = st.slots[s.key];
      if (!e || !byId.has(e.id)) continue;
      parts.push(`${s.key}=${encodeURIComponent(e.id)}${e.dye ? '~' + encodeURIComponent(e.dye) : ''}`);
    }
    return '#' + parts.join('&');
  }
  /** Applies an outfit snapshot ({ body, pose, skin, camp, slots }) after validating it. */
  function applySnapshot(o) {
    if (!o || typeof o !== 'object') return;
    if (o.body === 'M' || o.body === 'F') st.body = o.body;
    if (typeof o.pose === 'string' && o.pose) st.pose = o.pose;
    if (SKIN[o.skin]) st.skin = o.skin;
    st.camp = !!o.camp;
    st.slots = {};
    for (const s of SLOTS) {
      const e = o.slots?.[s.key];
      const it = e && byId.get(e.id);
      if (!fits(s.key, it)) continue;
      st.slots[s.key] = { id: it.id, dye: dyeById(e.dye) ? e.dye : null };
    }
  }
  function parseHash(hash) {
    if (!isDressHash(hash)) return null;
    const q = new URLSearchParams(String(hash || '').replace(/^#?dress&?/, ''));
    if (![...q.keys()].length) return null;
    const o = { body: q.get('b'), pose: q.get('p'), skin: q.get('s'), camp: q.get('c') === '1', slots: {} };
    for (const s of SLOTS) {
      const v = q.get(s.key);
      if (!v) continue;
      const [id, dye = null] = v.split('~');
      o.slots[s.key] = { id, dye };
    }
    return o;
  }

  const outfits = {
    read() { try { const v = JSON.parse(localStorage.getItem(OUTFITS_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } },
    write(list) { try { localStorage.setItem(OUTFITS_KEY, JSON.stringify(list)); return true; } catch { return false; } },
  };

  // ------------------------------------------------------------------- build
  function ensureItems() {
    if (items.length || !ctx.items().length) return;
    const order = (g) => FILTERS.findIndex(([k]) => k === g);
    items = ctx.items().filter(isDressable)
      .sort((a, b) => order(a.slotGroup) - order(b.slotGroup) || a.name.localeCompare(b.name));
    byId = new Map(items.map((it) => [it.id, it]));
  }

  function build() {
    if (built) return;
    built = true;
    // filter chips
    el.filter.replaceChildren(...FILTERS.map(([g, label]) => {
      const n = g ? items.filter((it) => it.slotGroup === g).length : items.length;
      return h('button', { type: 'button', role: 'tab', class: 'subtab', 'data-group': g, 'aria-selected': 'false', 'aria-controls': 'd-grid' },
        label, h('span', { class: 'tab-count' }, String(n)));
    }));
    // skins
    el.skin.replaceChildren(...SKINS.map((s) => h('button', {
      type: 'button', role: 'radio', class: 'skin', 'data-skin': s.id, 'aria-checked': 'false', title: s.name, 'aria-label': s.name,
      style: `--skin:${s.hex}`,
    })));
    // weapon slots (later)
    el.bottom.replaceChildren(...['Main hand', 'Off hand'].map((label) => h('div', { class: 'dslot dslot-soon' },
      h('button', { type: 'button', class: 'dslot-btn', 'aria-disabled': 'true', 'data-tip': 'Coming soon: weapons will follow',
        'aria-label': `${label}: coming soon` },
      h('span', { class: 'dslot-empty', 'aria-hidden': 'true' }, svgUse('i-sword', 'dslot-ico'))),
      h('span', { class: 'dslot-name', 'aria-hidden': 'true' }, label))));
    renderDyeTray();
    bind();
  }

  // -------------------------------------------------------------------- grid
  function gridItem(it) {
    const node = h('div', {
      class: 'slot', role: 'option', id: 'dslot-' + it.id, 'data-id': it.id, 'data-rarity': it.rarity, tabindex: '-1',
      draggable: 'true', 'aria-selected': 'false',
      'aria-label': `${it.name}, ${RARITY_LABEL[it.rarity]} ${SLOT_LABEL(it.slotGroup)}${hasModel(it) ? '' : ', no worn model'}`,
    });
    const ph = () => h('span', { class: 'ph', 'aria-hidden': 'true' }, initials(it.name));
    if (it.icon) {
      const img = h('img', { src: it.icon, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(ph()), { once: true });
      node.append(img);
    } else node.append(ph());
    if (isEquipped(it.id)) node.classList.add('equipped');
    return node;
  }
  const SLOT_LABEL = (g) => (g === 'Breast' ? 'Armour' : g);
  const isEquipped = (id) => Object.values(st.slots).some((e) => e && e.id === id);

  function renderGrid() {
    const terms = st.query.toLowerCase().split(/\s+/).filter(Boolean);
    const view = items.filter((it) => (!st.filter || it.slotGroup === st.filter) && terms.every((t) => it._search.includes(t)));
    const frag = document.createDocumentFragment();
    for (const it of view) frag.append(gridItem(it));
    el.grid.replaceChildren(frag);
    el.empty.hidden = view.length > 0;
    el.count.textContent = view.length === items.length ? `${items.length} wearables` : `${view.length} of ${items.length} wearables`;
    for (const b of el.filter.children) {
      const on = b.dataset.group === st.filter;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    roving();
  }
  function roving() {
    const kids = [...el.grid.children];
    if (!kids.length) return;
    const target = (st.focusId && document.getElementById('dslot-' + st.focusId)) || kids[0];
    for (const k of kids) {
      k.tabIndex = k === target ? 0 : -1;
      k.setAttribute('aria-selected', String(k === target && st.focusId === k.dataset.id));
    }
  }
  function markEquipped() {
    for (const k of el.grid.children) k.classList.toggle('equipped', isEquipped(k.dataset.id));
  }
  function setFilter(g) {
    if (st.filter === g) return;
    st.filter = g;
    renderGrid();
  }

  function columns() {
    const kids = el.grid.children;
    if (kids.length < 2) return 1;
    const top = kids[0].offsetTop;
    let n = 0;
    for (const k of kids) { if (k.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  }
  function onGridKey(e) {
    const kids = [...el.grid.children];
    if (!kids.length) return;
    const cur = kids.indexOf(document.activeElement);
    const i = cur < 0 ? 0 : cur;
    const cols = columns();
    let n = null;
    switch (e.key) {
      case 'ArrowRight': n = Math.min(kids.length - 1, i + 1); break;
      case 'ArrowLeft': n = Math.max(0, i - 1); break;
      case 'ArrowDown': n = i + cols < kids.length ? i + cols : i; break;
      case 'ArrowUp': n = i - cols >= 0 ? i - cols : i; break;
      case 'Home': n = e.ctrlKey ? 0 : i - (i % cols); break;
      case 'End': n = e.ctrlKey ? kids.length - 1 : Math.min(kids.length - 1, i - (i % cols) + cols - 1); break;
      case 'Enter':
        if (cur >= 0) { e.preventDefault(); equip(kids[cur].dataset.id, { key: st.selected, viaKeyboard: true }); }
        return;
      case ' ':
        if (cur >= 0) { e.preventDefault(); focusGrid(kids[cur].dataset.id); }
        return;
      default: return;
    }
    e.preventDefault();
    if (kids[n]) focusGrid(kids[n].dataset.id, true);
  }
  function focusGrid(id, focus = true) {
    st.focusId = id;
    roving();
    const node = document.getElementById('dslot-' + id);
    if (node && focus) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest' }); showItemTip(node); }
  }
  function showItemTip(node) {
    const it = byId.get(node.dataset.id);
    if (!it) return;
    const notes = [];
    if (!hasModel(it)) notes.push('No worn model (icon only)');
    else if (!rigFor(it)) notes.push(`No ${st.body === 'F' ? 'female' : 'male'} model`);
    placeTip(node, [
      h('div', { class: 't-name r-' + it.rarity }, it.name),
      h('div', { class: 't-type' }, [SLOT_LABEL(it.slotGroup), RARITY_LABEL[it.rarity] !== 'Common' ? RARITY_LABEL[it.rarity] : null].filter(Boolean).join(' · ')),
      notes.length ? h('div', { class: 't-desc' }, notes.join(' · ')) : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------- slots
  function slotFrame(key) {
    const def = SLOT[key];
    const e = st.slots[key];
    const it = itemOf(key);
    const sel = st.selected === key;
    const d = e && dyeById(e.dye);
    const note = slotNote(key, it);
    const wrap = h('div', { class: 'dslot' + (it ? ' filled' : '') + (sel ? ' selected' : ''), 'data-key': key, 'data-rarity': it?.rarity || null });
    const label = it
      ? `${def.label}: ${it.name}${d ? `, dyed ${d.name}` : ''}${note ? `, ${note}` : ''}${sel ? ', selected' : ''}`
      : `${def.label}: empty${sel ? ', selected' : ''}`;
    const btn = h('button', { type: 'button', class: 'dslot-btn', 'aria-pressed': String(sel), 'aria-label': label, 'data-key': key });
    if (it) {
      if (it.icon) {
        const img = h('img', { src: it.icon, alt: '', draggable: 'false' });
        img.addEventListener('error', () => img.replaceWith(h('span', { class: 'ph', 'aria-hidden': 'true' }, initials(it.name))), { once: true });
        btn.append(img);
      } else btn.append(h('span', { class: 'ph', 'aria-hidden': 'true' }, initials(it.name)));
    } else btn.append(h('span', { class: 'dslot-empty', 'aria-hidden': 'true' }, def.label.replace('Underwear', 'Under­wear')));
    wrap.append(btn, h('span', { class: 'dslot-name', 'aria-hidden': 'true' }, def.label));
    if (it) {
      wrap.append(h('button', { type: 'button', class: 'dslot-x', 'data-key': key, 'aria-label': `Unequip ${it.name}`, title: 'Unequip' }, '×'));
      if (d) {
        const badge = h('span', { class: 'dslot-dye', title: d.name, 'aria-hidden': 'true', style: `--c1:${d.swatch[0] || '#888'};--c2:${d.swatch[1] || d.swatch[0] || '#888'}` });
        badge.append(svgUse('i-drop'));
        wrap.append(badge);
      }
      if (note) wrap.append(h('span', { class: 'dslot-note', 'aria-hidden': 'true' }, note));
    }
    return wrap;
  }
  function slotNote(key, it) {
    if (!it) return '';
    if (!SLOT[key].model) return 'no 3D';
    if (!rigFor(it)) return `no ${st.body === 'F' ? 'female' : 'male'} model`;
    if (key === 'Underwear' && itemOf(torsoKey())) return 'under armour';
    const info = dr?.pieceInfo(key);
    if (info?.status === 'error') return 'failed to load';
    return '';
  }
  function renderSlots() {
    const keepFocus = document.activeElement?.closest?.('.dslot')?.dataset.key;
    const keepX = document.activeElement?.classList?.contains('dslot-x');
    el.left.replaceChildren(...LEFT.map((p) => slotFrame(shownKey(p))));
    el.right.replaceChildren(...RIGHT.map((k) => slotFrame(k)));
    if (keepFocus) {
      const w = el.app.querySelector(`.dslot[data-key="${keepFocus}"]`);
      (keepX && w?.querySelector('.dslot-x')) ? w.querySelector('.dslot-x').focus() : w?.querySelector('.dslot-btn')?.focus();
    }
    el.camp.setAttribute('aria-pressed', String(st.camp));
    const n = Object.keys(st.slots).length;
    el.sub.textContent = `${st.body === 'F' ? 'Female' : 'Male'} body · ${n ? `${n} piece${n === 1 ? '' : 's'}` : 'nothing equipped'}${st.camp ? ' · camp set' : ''}`;
    markEquipped();
  }

  function selectSlot(key, { filter = true } = {}) {
    if (!SLOT[key]) return;
    st.selected = key;
    if (filter) setFilter(SLOT[key].group);
    renderSlots();
    renderDyeBar();
    renderPiece();
    persist();
  }

  // ------------------------------------------------------------- equipping
  /** Finds where an item goes. `key` is honoured when the item fits it. */
  function targetKey(it, key) {
    if (key && fits(key, it)) return key;
    if (it.slotGroup === 'Ring') {
      if (key && SLOT[key]?.group === 'Ring') return key;
      return !st.slots.Ring1 ? 'Ring1' : !st.slots.Ring2 ? 'Ring2' : (st.selected === 'Ring2' ? 'Ring2' : 'Ring1');
    }
    return SLOTS.find((s) => s.group === it.slotGroup)?.key || null;
  }

  function equip(id, { key = null, dye, strict = false, quiet = false } = {}) {
    ensureItems();
    const it = byId.get(id);
    if (!it) { flash(`That item can't be worn in the Dressing Room.`); return false; }
    if (strict && key && !fits(key, it) && !(SLOT[key]?.group === 'Ring' && it.slotGroup === 'Ring')) {
      flash(`${it.name} goes in the ${SLOT_LABEL(it.slotGroup)} slot, not ${SLOT[key]?.label || key}.`);
      return false;
    }
    const k = targetKey(it, key);
    if (!k) return false;
    if (k === 'CampClothes' || k === 'CampShoes') st.camp = true;
    else if (k === 'Breast' || k === 'Boots') st.camp = false;
    st.slots[k] = { id, dye: dye && dyeById(dye) ? dye : null };
    st.selected = k;
    if (!quiet) {
      const note = !hasModel(it) ? ' (no worn model, shown as an icon)' : !rigFor(it) ? ` (no ${st.body === 'F' ? 'female' : 'male'} model)` : '';
      flash(`Equipped ${it.name} in ${SLOT[k].label}${note}.`);
    }
    changed();
    return true;
  }

  function unequip(key) {
    const it = itemOf(key);
    if (!it) return;
    delete st.slots[key];
    flash(`Unequipped ${it.name}.`);
    changed();
  }

  function changed() {
    renderSlots();
    renderDyeBar();
    renderPiece();
    persist();
    sync3D();
  }

  // ---------------------------------------------------------------- 3D sync
  function poseList(body = st.body) { return data?.poses?.[body] || []; }
  function matchPose(body, id) {
    const list = poseList(body);
    let p = list.find((x) => x.id === id);
    if (p) return p;
    const other = poseList(body === 'F' ? 'M' : 'F').find((x) => x.id === id);
    if (other) p = list.find((x) => x.name === other.name);
    if (p) return p;
    const stem = String(id).replace(/_\d+$/, '').toLowerCase();
    return list.find((x) => { const s = x.id.replace(/_\d+$/, '').toLowerCase(); return s.startsWith(stem) || stem.startsWith(s); }) || null;
  }
  function poseDef(id) {
    if (!id || id === POSE_TPOSE) return null;
    const m = matchPose('M', id), f = matchPose('F', id);
    if (!m && !f) return null;
    return { id, animated: !!(m || f).animated, urls: { M: m?.url || null, F: f?.url || null } };
  }

  function sync3D() {
    if (!dr) return;
    dr.setSkinTone(SKIN[st.skin].hex);
    if (dr.bodyType !== st.body) dr.setBodyType(st.body).then(updatePlay);
    const poseKey = `${st.pose}`;
    if (poseKey !== lastPose) {
      lastPose = poseKey;
      dr.setPose(poseDef(st.pose)).then(updatePlay);
    }
    for (const s of SLOTS) {
      if (!s.model) continue;
      const it = visible3D(s.key) ? itemOf(s.key) : null;
      if (!it) { dr.removePiece(s.key); continue; }
      const d = dyeById(st.slots[s.key].dye);
      dr.setPiece(s.key, { urls: { M: it.models.rigM || null, F: it.models.rigF || null }, colors: d ? d.colors : null, hide: it.hideBody || null });
    }
  }

  function updatePlay() {
    if (!dr) return;
    el.play.hidden = !dr.animated;
    el.play.setAttribute('aria-pressed', String(playing));
    el.play.title = playing ? 'Pause idle animation' : 'Play idle animation';
    el.play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    el.play.querySelector('.visually-hidden').textContent = el.play.title;
  }

  async function ensureRoom() {
    if (drPromise) return drPromise;
    el.loading.hidden = false;
    drPromise = (async () => {
      await loadData();
      const mod = await import('./dressing.js');
      const room = mod.createDressingRoom(el.viewer, {
        bodies: data.bodies, heads: data.heads, bodyType: st.body, skin: SKIN[st.skin].hex, reducedMotion: reduced(),
      });
      room.setAnimationPlaying(playing);
      room.on('loading', (n) => { el.busy.hidden = n === 0 || !el.loading.hidden; el.busy.textContent = `Loading ${n}…`; });
      room.on('piece', () => { renderSlots(); renderDyeBar(); });
      room.on('error', (what, err) => {
        console.error('[dressing]', what, err);
        if (what === 'body') showMsg('Could not load the body', err?.message || String(err));
        else if (what === 'pose') flash('That pose could not be loaded.');
        else flash(`${itemOf(what)?.name || what} failed to load.`);
      });
      dr = room;
      sync3D();
      await room.ready;
      el.loading.hidden = true;
      if (!isOpen) room.setActive(false);
      return room;
    })();
    drPromise.catch((err) => {
      console.error('[dressing] failed to start', err);
      el.loading.hidden = true;
      showMsg('Dressing Room unavailable', `The 3D scene could not start. ${err?.message || ''}`);
    });
    return drPromise;
  }

  function loadData() {
    if (!dataPromise) {
      dataPromise = ctx.fetchJson(DRESSING_URL).then((d) => {
        if (!d?.bodies) throw new Error('dressing.json has no bodies');
        data = d;
        renderPoses();
        return d;
      });
      dataPromise.catch(() => { dataPromise = null; });
    }
    return dataPromise;
  }

  function showMsg(title, body) {
    el.msg.replaceChildren(h('div', { class: 'm-title' }, title), body ? h('div', { class: 'm-body' }, body) : null);
    el.msg.hidden = false;
  }

  // ------------------------------------------------------------------ poses
  function renderPoses() {
    if (!data) return;
    const list = poseList();
    if (!matchPose(st.body, st.pose) && st.pose !== POSE_TPOSE) st.pose = list.some((p) => p.id === 'idle') ? 'idle' : POSE_TPOSE;
    const terms = el.poseFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const opts = [{ id: POSE_TPOSE, name: 'T-pose' }, ...list.filter((p) => p.id === 'idle'), ...list.filter((p) => p.id !== 'idle')];
    const cur = matchPose(st.body, st.pose)?.id || POSE_TPOSE;
    const shown = opts.filter((p) => p.id === cur || terms.every((t) => `${p.name} ${p.id}`.toLowerCase().includes(t)));
    el.pose.replaceChildren(...shown.map((p) => h('option', { value: p.id }, p.animated ? `${p.name} (animated)` : p.name)));
    el.pose.value = cur;
    el.poseName.textContent = opts.find((p) => p.id === cur)?.name || 'T-pose';
  }

  function setPose(id) {
    if (id === st.pose) return;
    st.pose = id;
    renderPoses();
    persist();
    sync3D();
  }

  function renderSkin() {
    for (const b of el.skin.children) {
      const on = b.dataset.skin === st.skin;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    el.skinSw.style.background = SKIN[st.skin].hex;
    el.skinName.textContent = SKIN[st.skin].name;
  }

  // ------------------------------------------------------------------- dyes
  function renderDyeTray() {
    const list = dyes().list;
    el.dyeTray.replaceChildren(ctx.dyeButton(null), ...list.map((d) => ctx.dyeButton(d)));
  }
  function filterDyes() {
    const terms = st.dyeFilter.toLowerCase().split(/\s+/).filter(Boolean);
    for (const b of el.dyeTray.children) {
      const d = dyeById(b.dataset.dye);
      if (d) b.hidden = !terms.every((t) => d._search.includes(t));
    }
  }
  function dyeableKey(key) {
    const it = itemOf(key);
    if (!it || !SLOT[key].model || !hasModel(it)) return false;
    const info = dr?.pieceInfo(key);
    return info && info.status === 'ok' ? info.dyeable : true; // unknown until loaded: allow
  }
  function renderDyeBar() {
    const key = st.selected;
    const it = itemOf(key);
    const can = it && dyeableKey(key);
    const hasDyes = dyes().list.length > 0;
    el.dyeTarget.textContent = it ? `· ${it.name}` : `· ${SLOT[key]?.label || ''}`;
    el.dyeTray.hidden = !can || !hasDyes;
    el.dyeAll.disabled = !can;
    el.dyeFilter.disabled = !can;
    el.dyeMsg.hidden = !!(can && hasDyes);
    el.dyeMsg.textContent = !hasDyes ? 'No dyes available.'
      : !it ? 'Select an equipped piece to dye it.'
        : !SLOT[key].model || !hasModel(it) ? 'Jewellery has no worn model and cannot be dyed.'
          : 'This piece cannot be dyed.';
    const cur = st.slots[key]?.dye || null;
    const visible = [...el.dyeTray.children].filter((b) => !b.hidden);
    let target = null;
    for (const b of el.dyeTray.children) {
      const on = (b.dataset.dye || null) === cur;
      b.setAttribute('aria-pressed', String(on));
      if (on && !b.hidden) target = b;
    }
    const focused = visible.includes(document.activeElement) ? document.activeElement : null;
    target = focused || target || visible[0];
    for (const b of el.dyeTray.children) b.tabIndex = b === target ? 0 : -1;
  }
  function setDye(key, dyeId) {
    const e = st.slots[key];
    if (!e) return;
    e.dye = dyeById(dyeId) ? dyeId : null;
    changed();
  }
  function dyeAll() {
    const key = st.selected;
    const dye = st.slots[key]?.dye || null;
    let n = 0;
    for (const s of SLOTS) if (st.slots[s.key] && dyeableKey(s.key)) { st.slots[s.key].dye = dye; n++; }
    flash(dye ? `${dyeById(dye).name} applied to ${n} piece${n === 1 ? '' : 's'}.` : `Original colours restored on ${n} piece${n === 1 ? '' : 's'}.`);
    changed();
  }

  // ------------------------------------------------------------ side panel
  function renderPiece() {
    const key = st.selected;
    const it = itemOf(key);
    const d = it && dyeById(st.slots[key].dye);
    if (!it) {
      el.piece.replaceChildren(h('h2', { class: 'c-name' }, SLOT[key]?.label || 'Slot'),
        h('p', { class: 'd-muted' }, 'Empty. Drag an item here, double-click one in the list, or press Enter on a focused item.'),
        h('div', { class: 'divider', 'aria-hidden': 'true' }));
      return;
    }
    const note = slotNote(key, it);
    el.piece.replaceChildren(...[
      h('h2', { class: 'c-name r-' + it.rarity }, it.name),
      h('div', { class: 'c-meta' },
        h('span', { class: 'c-rarity r-' + it.rarity }, RARITY_LABEL[it.rarity]),
        h('span', { class: 'c-sep', 'aria-hidden': 'true' }, '◆'),
        h('span', {}, SLOT[key].label),
        it.armor?.armorClass != null ? h('span', { class: 'c-sep', 'aria-hidden': 'true' }, '◆') : null,
        it.armor?.armorClass != null ? h('span', {}, `AC ${it.armor.armorClass}`) : null),
      h('p', { class: 'd-piece-dye' }, d ? ['Dye: ', h('b', { class: 'r-' + d.rarity }, d.name)] : 'Original colours'),
      note ? h('p', { class: 'd-muted' }, note[0].toUpperCase() + note.slice(1) + '.') : null,
      h('p', { class: 'd-piece-links' },
        h('a', { href: '#' + encodeURIComponent(it.id), class: 'link-btn', 'data-catalog': it.id }, 'View in catalogue'),
        ' · ',
        h('button', { type: 'button', class: 'link-btn', 'data-unequip': key }, 'Unequip')),
      h('div', { class: 'divider', 'aria-hidden': 'true' }),
    ].filter(Boolean));
  }

  let flashTimer = 0;
  function flash(text) {
    el.status.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.status.textContent = ''; }, 4500);
  }
  let outfitTimer = 0;
  function outfitFlash(...nodes) {
    el.outfitStatus.replaceChildren(...nodes);
    clearTimeout(outfitTimer);
    outfitTimer = setTimeout(() => el.outfitStatus.replaceChildren(), 8000);
  }

  // ----------------------------------------------------------------- outfits
  function renderOutfits() {
    const list = outfits.read();
    el.outfitEmpty.hidden = list.length > 0;
    el.outfitList.replaceChildren(...list.map((o, i) => {
      const n = Object.keys(o.data?.slots || {}).length;
      return h('li', {},
        h('button', { type: 'button', class: 'd-outfit-load', 'data-i': String(i), title: `Wear "${o.name}"` },
          h('span', { class: 'd-outfit-name' }, o.name),
          h('span', { class: 'd-muted' }, `${o.data?.body === 'F' ? 'F' : 'M'} · ${n} piece${n === 1 ? '' : 's'}`)),
        h('button', { type: 'button', class: 'dslot-x d-outfit-del', 'data-i': String(i), 'aria-label': `Delete outfit ${o.name}`, title: 'Delete' }, '×'));
    }));
  }
  function saveOutfit(name) {
    name = name.trim().slice(0, 60);
    if (!name) return;
    const list = outfits.read();
    const i = list.findIndex((o) => o.name.toLowerCase() === name.toLowerCase());
    const entry = { name, saved: new Date().toISOString(), data: snapshot() };
    if (i >= 0) list[i] = entry; else list.unshift(entry);
    if (!outfits.write(list)) { outfitFlash('Could not save (browser storage is unavailable).'); return; }
    renderOutfits();
    el.outfitName.value = '';
    outfitFlash(i >= 0 ? `Updated "${name}".` : `Saved "${name}".`);
  }
  function loadOutfit(i) {
    const o = outfits.read()[i];
    if (!o) return;
    applySnapshot(o.data);
    renderPoses(); renderSkin(); renderBody();
    changed();
    outfitFlash(`Wearing "${o.name}".`);
  }
  function deleteOutfit(i) {
    const list = outfits.read();
    const [gone] = list.splice(i, 1);
    if (!gone) return;
    outfits.write(list);
    renderOutfits();
    const undo = h('button', { type: 'button', class: 'link-btn' }, 'Undo');
    undo.addEventListener('click', () => {
      const l = outfits.read();
      l.splice(Math.min(i, l.length), 0, gone);
      outfits.write(l);
      renderOutfits();
      outfitFlash(`Restored "${gone.name}".`);
    });
    outfitFlash(`Deleted "${gone.name}". `, undo);
  }
  async function copyLink() {
    const url = location.href.split('#')[0] + hashString();
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch {
      try {
        const ta = h('textarea', {}, url); ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch { /* ignore */ }
    }
    outfitFlash(ok ? 'Share link copied.' : 'Copy failed; the link is in the address bar.');
  }
  function randomise() {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const dyeList = dyes().list;
    st.slots = {};
    for (const s of SLOTS) {
      const pool = items.filter((it) => it.slotGroup === s.group && (!s.model || rigFor(it)));
      if (!pool.length) continue;
      let it = pick(pool);
      if (s.key === 'Ring2' && st.slots.Ring1 && pool.length > 1) while (it.id === st.slots.Ring1.id) it = pick(pool);
      const dye = s.model && dyeList.length && Math.random() < 0.85 ? pick(dyeList).id : null;
      st.slots[s.key] = { id: it.id, dye };
    }
    flash('Randomised every slot.');
    changed();
  }
  function clearAll() {
    st.slots = {};
    flash('All slots emptied.');
    changed();
  }

  function renderBody() {
    for (const b of el.body.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.body === st.body));
  }

  // ---------------------------------------------------------- drag and drop
  let dragId = null;
  function dropKeyAt(target) {
    const slotEl = target?.closest?.('.dslot');
    if (slotEl && el.app.contains(slotEl)) return slotEl.dataset.key ? { key: slotEl.dataset.key } : { bad: true };
    if (target && el.drop.contains(target)) return { key: null };
    return null;
  }
  function canDrop(drop, it) {
    if (!drop || drop.bad || !it) return false;
    if (!drop.key) return true;
    return fits(drop.key, it) || (SLOT[drop.key]?.group === 'Ring' && it.slotGroup === 'Ring');
  }
  function markDrop(target, ok) {
    for (const n of el.app.querySelectorAll('.drop-ok, .drop-bad')) n.classList.remove('drop-ok', 'drop-bad');
    if (!target) return;
    const n = target.closest('.dslot') || (el.drop.contains(target) ? el.drop : null);
    n?.classList.add(ok ? 'drop-ok' : 'drop-bad');
  }
  function doDrop(drop) {
    if (!drop || !dragId) return;
    const it = byId.get(dragId);
    if (drop.bad || !it) return;
    equip(dragId, { key: drop.key, strict: !!drop.key });
  }
  function highlightTargets(it) {
    for (const w of el.app.querySelectorAll('.dslot[data-key]')) w.classList.toggle('drop-hint', !!it && canDrop({ key: w.dataset.key }, it));
  }

  // touch / pen fallback: long-press an icon, then drag
  let touch = null;
  function onPointerDown(e) {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    const node = e.target.closest('.slot');
    if (!node) return;
    touch = { id: node.dataset.id, x: e.clientX, y: e.clientY, pid: e.pointerId, active: false, timer: 0 };
    touch.timer = setTimeout(() => startTouchDrag(node), 280);
  }
  function startTouchDrag(node) {
    if (!touch) return;
    touch.active = true;
    dragId = touch.id;
    const img = node.querySelector('img');
    el.ghost.replaceChildren(img ? h('img', { src: img.src, alt: '' }) : h('span', {}, node.textContent));
    el.ghost.hidden = false;
    moveGhost(touch.x, touch.y);
    highlightTargets(byId.get(dragId));
    hideTip();
    navigator.vibrate?.(10);
  }
  function moveGhost(x, y) { el.ghost.style.transform = `translate(${x - 28}px, ${y - 28}px)`; }
  function onPointerMove(e) {
    if (!touch || e.pointerId !== touch.pid) return;
    if (!touch.active) {
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) { clearTimeout(touch.timer); touch = null; }
      return;
    }
    moveGhost(e.clientX, e.clientY);
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const drop = dropKeyAt(t);
    markDrop(drop ? t : null, canDrop(drop, byId.get(dragId)));
  }
  function onPointerUp(e) {
    if (!touch || e.pointerId !== touch.pid) return;
    clearTimeout(touch.timer);
    if (touch.active) {
      const t = e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY) : null;
      doDrop(dropKeyAt(t));
      endDrag();
    }
    touch = null;
  }
  function endDrag() {
    dragId = null;
    el.ghost.hidden = true;
    markDrop(null);
    highlightTargets(null);
  }
  // keep the page from scrolling while a touch drag is active
  const onTouchMove = (e) => { if (touch?.active) e.preventDefault(); };

  // -------------------------------------------------------------- bindings
  function bind() {
    // search + filter
    let t = 0;
    el.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.query = el.search.value.trim(); renderGrid(); }, 60); });
    el.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.search.value) { e.preventDefault(); el.search.value = ''; st.query = ''; renderGrid(); }
      else if (e.key === 'ArrowDown') {
        const first = el.grid.querySelector('[tabindex="0"]') || el.grid.firstElementChild;
        if (first) { e.preventDefault(); focusGrid(first.dataset.id); }
      }
    });
    el.filter.addEventListener('click', (e) => { const b = e.target.closest('[data-group]'); if (b) setFilter(b.dataset.group); });
    el.filter.addEventListener('keydown', (e) => {
      const tabs = [...el.filter.children];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : null;
      if (n == null) return;
      e.preventDefault();
      setFilter(tabs[n].dataset.group);
      el.filter.children[n].focus();
    });

    // grid
    el.grid.addEventListener('click', (e) => { const n = e.target.closest('.slot'); if (n) focusGrid(n.dataset.id); });
    el.grid.addEventListener('dblclick', (e) => { const n = e.target.closest('.slot'); if (n) equip(n.dataset.id); });
    el.grid.addEventListener('keydown', onGridKey);
    el.grid.addEventListener('pointerover', (e) => { const n = e.target.closest('.slot'); if (n && !dragId) showItemTip(n); });
    el.grid.addEventListener('pointerleave', hideTip);
    el.grid.addEventListener('focusin', (e) => { const n = e.target.closest('.slot'); if (n && n.matches(':focus-visible')) showItemTip(n); });
    el.grid.addEventListener('focusout', hideTip);
    el.grid.parentElement.addEventListener('scroll', hideTip, { passive: true });

    // HTML5 drag and drop (mouse)
    el.grid.addEventListener('dragstart', (e) => {
      const n = e.target.closest('.slot');
      if (!n) return;
      if (touch) { clearTimeout(touch.timer); touch = null; el.ghost.hidden = true; } // the browser took over the drag
      dragId = n.dataset.id;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', dragId);
      const img = n.querySelector('img');
      if (img) e.dataTransfer.setDragImage(img, 28, 28);
      hideTip();
      highlightTargets(byId.get(dragId));
    });
    el.grid.addEventListener('dragend', endDrag);
    el.app.addEventListener('dragover', (e) => {
      if (!dragId) return;
      const drop = dropKeyAt(e.target);
      if (!drop) { markDrop(null); return; }
      const ok = canDrop(drop, byId.get(dragId));
      markDrop(e.target, ok);
      if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    el.app.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      doDrop(dropKeyAt(e.target));
      endDrag();
    });

    // touch / pen fallback
    el.grid.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    el.grid.addEventListener('contextmenu', (e) => { if (touch) e.preventDefault(); });

    // slots
    const slotsRoot = el.left.parentElement;
    slotsRoot.addEventListener('click', (e) => {
      const x = e.target.closest('.dslot-x');
      if (x) { unequip(x.dataset.key); el.app.querySelector(`.dslot[data-key="${x.dataset.key}"] .dslot-btn`)?.focus(); return; }
      const b = e.target.closest('.dslot-btn');
      if (!b || b.getAttribute('aria-disabled') === 'true') return;
      selectSlot(b.dataset.key);
    });
    slotsRoot.addEventListener('keydown', (e) => {
      const b = e.target.closest('.dslot-btn');
      if (!b?.dataset.key) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); unequip(b.dataset.key); }
    });
    slotsRoot.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.dslot-btn');
      if (!b || dragId) return;
      if (b.dataset.tip) { placeTip(b, [h('div', { class: 't-name' }, b.dataset.tip)]); return; }
      const key = b.dataset.key;
      const it = itemOf(key);
      const d = it && dyeById(st.slots[key].dye);
      const note = slotNote(key, it);
      placeTip(b, [
        h('div', { class: 't-name' + (it ? ' r-' + it.rarity : '') }, it ? it.name : SLOT[key].label),
        h('div', { class: 't-type' }, it ? [SLOT[key].label, d ? d.name : null].filter(Boolean).join(' · ') : 'Empty slot'),
        note ? h('div', { class: 't-desc' }, note) : null,
      ].filter(Boolean));
    });
    slotsRoot.addEventListener('pointerout', (e) => { if (e.target.closest('.dslot-btn')) hideTip(); });
    slotsRoot.addEventListener('focusin', (e) => {
      const b = e.target.closest('.dslot-btn');
      if (b?.dataset.tip && b.matches(':focus-visible')) placeTip(b, [h('div', { class: 't-name' }, b.dataset.tip)]);
    });
    slotsRoot.addEventListener('focusout', hideTip);

    // character controls
    el.body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-body]');
      if (!b || b.dataset.body === st.body) return;
      st.body = b.dataset.body;
      renderBody(); renderPoses();
      lastPose = undefined; // pose ids can differ per body type
      changed();
    });
    el.camp.addEventListener('click', () => {
      st.camp = !st.camp;
      if (st.selected === 'Breast' || st.selected === 'CampClothes') st.selected = torsoKey();
      if (st.selected === 'Boots' || st.selected === 'CampShoes') st.selected = st.camp ? 'CampShoes' : 'Boots';
      flash(st.camp ? 'Showing the camp set.' : 'Showing the adventuring set.');
      changed();
    });
    el.pose.addEventListener('change', () => setPose(el.pose.value));
    el.pose.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { el.posePop.open = false; el.posePop.querySelector('summary').focus(); } });
    el.poseFilter.addEventListener('input', renderPoses);
    el.poseFilter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); el.pose.focus(); }
      if (e.key === 'Escape') { el.posePop.open = false; el.posePop.querySelector('summary').focus(); }
    });
    el.posePop.addEventListener('toggle', () => { if (el.posePop.open) { el.skinPop.open = false; el.poseFilter.focus(); } });
    el.skinPop.addEventListener('toggle', () => { if (el.skinPop.open) { el.posePop.open = false; el.skin.querySelector('[tabindex="0"]')?.focus(); } });
    el.skin.addEventListener('click', (e) => {
      const b = e.target.closest('[data-skin]');
      if (!b) return;
      st.skin = b.dataset.skin;
      renderSkin(); persist(); sync3D();
    });
    el.skin.addEventListener('keydown', (e) => {
      const btns = [...el.skin.children];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Escape') { el.skinPop.open = false; el.skinPop.querySelector('summary').focus(); return; }
      if (n == null) return;
      e.preventDefault();
      btns[n].click();
      btns[n].focus();
    });
    document.addEventListener('click', (e) => {   // light dismiss for the popovers
      for (const p of [el.posePop, el.skinPop]) if (p.open && !p.contains(e.target)) p.open = false;
    });
    el.play.addEventListener('click', () => { playing = !playing; dr?.setAnimationPlaying(playing); updatePlay(); });
    el.reset.addEventListener('click', () => dr?.resetView());

    // dyes
    el.dyeTray.addEventListener('click', (e) => {
      const b = e.target.closest('.dye');
      if (!b || b.hidden) return;
      setDye(st.selected, b.dataset.dye || null);
    });
    el.dyeTray.addEventListener('keydown', (e) => {
      const btns = [...el.dyeTray.children].filter((b) => !b.hidden);
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = btns.length - 1;
      if (n == null) return;
      e.preventDefault();
      for (const x of el.dyeTray.children) x.tabIndex = x === btns[n] ? 0 : -1;
      btns[n].focus();
      btns[n].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    el.dyeTray.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.dye');
      if (!b) return;
      const d = dyeById(b.dataset.dye);
      placeTip(b, d ? [h('div', { class: 't-name r-' + d.rarity }, d.name), h('div', { class: 't-type' }, 'Dye')] : [h('div', { class: 't-name' }, 'Original colours')]);
    });
    el.dyeTray.addEventListener('pointerleave', hideTip);
    el.dyeTray.addEventListener('scroll', hideTip, { passive: true });
    el.dyeTray.addEventListener('wheel', (e) => {
      const tr = el.dyeTray;
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = tr.scrollWidth - tr.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && tr.scrollLeft <= 0) || (e.deltaY > 0 && tr.scrollLeft >= max - 1)) return;
      e.preventDefault();
      tr.scrollLeft += e.deltaY;
    }, { passive: false });
    el.dyeFilter.addEventListener('input', () => { st.dyeFilter = el.dyeFilter.value.trim(); filterDyes(); renderDyeBar(); });
    el.dyeAll.addEventListener('click', dyeAll);

    // side panel
    el.piece.addEventListener('click', (e) => {
      const u = e.target.closest('[data-unequip]');
      if (u) unequip(u.dataset.unequip);
      const c = e.target.closest('[data-catalog]');
      if (c) { e.preventDefault(); ctx.showInCatalog(c.dataset.catalog); }
    });
    el.save.addEventListener('submit', (e) => { e.preventDefault(); saveOutfit(el.outfitName.value); });
    el.outfitList.addEventListener('click', (e) => {
      const del = e.target.closest('.d-outfit-del');
      if (del) { deleteOutfit(+del.dataset.i); return; }
      const ld = e.target.closest('.d-outfit-load');
      if (ld) loadOutfit(+ld.dataset.i);
    });
    el.share.addEventListener('click', copyLink);
    el.random.addEventListener('click', randomise);
    el.clear.addEventListener('click', clearAll);
  }

  // ------------------------------------------------------------------ public
  /** Shows the view. `hash` may carry an outfit (#dress&...). Creates the 3D scene on first open. */
  function open(hash) {
    ensureItems();
    if (!items.length) return;  // items not loaded yet; app.js opens again after boot
    if (!built) {
      const o = saved.slots ? saved : null;
      if (o) applySnapshot(o);
      build();
    }
    const fromHash = parseHash(hash);
    if (fromHash) { applySnapshot(fromHash); lastPose = undefined; }
    isOpen = true;
    renderBody(); renderSkin(); renderGrid(); renderSlots(); renderDyeBar(); renderPiece(); renderOutfits();
    if (data) renderPoses();
    persist();
    ensureRoom().then((room) => { if (isOpen) { room.setActive(true); sync3D(); } }).catch(() => {});
    dr?.setActive(true);
    sync3D();
  }
  function close() {
    isOpen = false;
    hideTip();
    dr?.setActive(false);
  }

  return {
    open,
    close,
    /** Equips an item (e.g. from the catalogue's Equip button), keeping an optional dye. */
    equip(id, { dye = null } = {}) { ensureItems(); if (!built && items.length) { if (saved.slots) applySnapshot(saved); build(); } return equip(id, { dye }); },
    hash: () => hashString(),
    get isOpen() { return isOpen; },
    get room() { return dr; },
  };
}
