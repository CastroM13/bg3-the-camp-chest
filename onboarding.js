// Camp Chest - first-visit onboarding and game-folder access.
//
// The site hosts only code. Every model, texture, icon and line of text comes from the visitor's own
// Baldur's Gate 3 installation, read locally in the browser. The folder is chosen with the browser's folder dialog
// (<input webkitdirectory>), because showDirectoryPicker() refuses folders under Program Files, where Steam installs
// the game by default. A folder chosen this way can't be remembered, so each visit asks for it again.
//
// Public API:
//   getGameFolder(): Promise<directory>
//       Resolves with the game's *Data* directory (engine/filesdir.js stand-in for a directory handle, with a
//       `files` Map) once it is picked and validated. Shows whatever UI is needed (first-visit notice,
//       "welcome back", errors) inside #onboarding. Calling it more than once returns the same promise.
//   forgetGameFolder(): Promise<void>
//       Forgets that the notice was accepted and deletes everything built from the game files.
//   isSupported(): boolean
//   REQUIRED_FILES: string[]   (paths relative to the Data folder)

import { filesDirFromList } from './engine/filesdir.js';

export const REQUIRED_FILES = [
  'Gustav.pak',
  'Shared.pak',
  'Models.pak',
  'Textures.pak',
  'VirtualTextures.pak',
  'Game.pak',
  'Localization/English.pak',
];

const DB_NAME = 'camp-chest';
const DB_STORE = 'kv';
const DB_KEY = 'gameFolder';

const MAC_APP = "Baldur's Gate 3.app";

const INSTALL_PATHS = [
  {
    name: 'Steam (default)',
    path: String.raw`C:\Program Files (x86)\Steam\steamapps\common\Baldurs Gate 3\Data`,
  },
  {
    name: 'Steam library on another drive',
    path: String.raw`<Drive>:\SteamLibrary\steamapps\common\Baldurs Gate 3\Data`,
    note: 'Replace <Drive> with the drive letter of your Steam library (for example D).',
  },
  {
    name: 'GOG Galaxy',
    path: String.raw`C:\Program Files (x86)\GOG Galaxy\Games\Baldurs Gate 3\Data`,
  },
  {
    name: 'Xbox app / PC Game Pass',
    path: String.raw`C:\XboxGames\Baldur's Gate 3\Content\Data`,
    note: 'May not work: Game Pass installs can be protected so that other programs, including your browser, cannot read the game files. If that happens, Camp Chest cannot read them either.',
    warn: true,
  },
  {
    name: 'macOS (Steam)',
    path: "~/Library/Application Support/Steam/steamapps/common/Baldurs Gate 3/Baldur's Gate 3.app/Contents/Data",
    note: 'The game is an app bundle: in the folder dialog press Cmd+Shift+G and paste this path.',
  },
];

// ------------------------------------------------------------------ helpers

export function isSupported() {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator &&
    'webkitdirectory' in document.createElement('input');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function loadSaved() {
  try { return (await idb('readonly', (s) => s.get(DB_KEY))) || null; } catch { return null; }
}
async function saveFolder(record) {
  try { await idb('readwrite', (s) => s.put(record, DB_KEY)); } catch (e) { console.warn('[onboarding] could not remember the folder', e); }
}
export async function forgetGameFolder() {
  try { await idb('readwrite', (s) => s.delete(DB_KEY)); } catch (e) { console.warn('[onboarding] could not forget the folder', e); }
}

async function getDir(dir, name) { try { return await dir.getDirectoryHandle(name); } catch { return null; } }
async function getFile(dir, name) { try { return await dir.getFileHandle(name); } catch { return null; } }
async function walk(dir, parts, last = 'dir') {
  let cur = dir;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    cur = isLast && last === 'file' ? await getFile(cur, parts[i]) : await getDir(cur, parts[i]);
    if (!cur) return null;
  }
  return cur;
}


// Accepts the game folder, its Data folder, the macOS app bundle (or its Contents folder), or the folder
// that holds the app bundle. Returns { data, missing[], unreadable } for the best candidate found.
async function locateDataDir(picked) {
  const candidates = [
    [],
    ['Data'],
    ['Contents', 'Data'],
    [MAC_APP, 'Contents', 'Data'],
  ];
  let fallback = null;
  for (const parts of candidates) {
    const dir = parts.length ? await walk(picked, parts) : picked;
    if (!dir) continue;
    if (await getFile(dir, 'Gustav.pak') || await getFile(dir, 'Shared.pak')) return dir;
    if (!fallback && parts.length) fallback = dir;
  }
  return fallback;
}

async function checkDataDir(data) {
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!(await walk(data, rel.split('/'), 'file'))) missing.push(rel);
  }
  if (missing.length) return { ok: false, missing };
  // Cheap readability check: the first four bytes of Gustav.pak must be "LSPK". This catches protected
  // installs (e.g. some Game Pass setups) where the files are listed but cannot actually be read.
  try {
    const file = await (await data.getFileHandle('Gustav.pak')).getFile();
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== 'LSPK') return { ok: false, unreadable: 'format' };
  } catch (e) {
    console.warn('[onboarding] could not read Gustav.pak', e);
    return { ok: false, unreadable: 'read' };
  }
  return { ok: true };
}

// --------------------------------------------------------------------- UI

const CORNER = '<svg class="ob-corner {pos}" aria-hidden="true" focusable="false"><use href="#ob-corner"/></svg>';
const corners = () => ['tl', 'tr', 'bl', 'br'].map((p) => CORNER.replace('{pos}', p)).join('');

function footerHTML() {
  const tpl = document.getElementById('ob-footer-template');
  return tpl ? tpl.innerHTML : '';
}

class OnboardingUI {
  constructor(root) {
    this.root = root;
    this.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
  }

  show(html, { narrow = false } = {}) {
    this.root.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', this.onKey, true);
    this.root.innerHTML = `
      <div class="ob-overlay" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div class="ob-panel${narrow ? ' ob-narrow' : ''}">${corners()}${html}</div>
        <footer class="ob-footer">${footerHTML()}</footer>
      </div>`;
    const title = this.root.querySelector('#ob-title');
    if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
    this.root.querySelector('.ob-overlay').scrollTop = 0;
  }

  hide() {
    this.root.innerHTML = '';
    this.root.hidden = true;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', this.onKey, true);
  }

  $(sel) { return this.root.querySelector(sel); }

  status(html, kind = '') {
    const el = this.$('.ob-status');
    if (!el) return;
    el.innerHTML = html ? `<div class="ob-msg ${kind}">${html}</div>` : '';
    if (html && kind === 'error') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  header(eyebrow, title) {
    return `<header class="ob-header"><p class="ob-eyebrow">${esc(eyebrow)}</p>
      <h1 class="ob-title" id="ob-title">${esc(title)}</h1><div class="ob-rule" aria-hidden="true"></div></header>`;
  }

  unsupported() {
    const insecure = !window.isSecureContext;
    this.show(`
      ${this.header('Camp Chest', 'This browser can’t open your game folder')}
      <p class="ob-lead">Camp Chest reads Baldur's Gate 3 directly from your own installed copy, inside your browser.
        That needs a desktop browser that can open a folder from your computer, such as
        <strong>Chrome or Microsoft Edge</strong>.</p>
      ${insecure
        ? `<p class="ob-msg error">This page was opened over an insecure connection. Opening folders only works on
             <code>https://</code> or <code>http://localhost</code>.</p>`
        : `<p>Mobile browsers can't open folders, so the game can't be read here.</p>`}
      <p class="ob-muted">Please open this page in desktop Chrome or Edge on the computer where the game is installed.
        Nothing is uploaded: the site only hosts code, and game files never leave your computer.</p>
    `, { narrow: true });
  }

  notice() {
    const paths = INSTALL_PATHS.map((p, i) => `
      <li class="ob-path">
        <span class="ob-path-name">${esc(p.name)}</span>
        <code id="ob-path-${i}">${esc(p.path)}</code>
        <button type="button" class="ob-copy" data-copy="${i}" aria-label="Copy the ${esc(p.name)} path">Copy</button>
        ${p.note ? `<p class="ob-path-note${p.warn ? ' warn' : ''}">${esc(p.note)}</p>` : ''}
      </li>`).join('');

    this.show(`
      ${this.header('Before you open the chest', 'Bring your own game')}
      <p class="ob-lead">Camp Chest is a free, unofficial fan catalogue of Baldur's Gate 3 items. It contains
        <strong>no game content</strong>: every model, texture, icon and description is read from
        <strong>your own installed copy</strong> of the game.</p>
      <ul class="ob-facts">
        <li><b>You need the game</b>Baldur's Gate 3 must be installed on this computer, and you must own it.</li>
        <li><b>Read locally</b>Files are read in your browser. Nothing is uploaded, and no game content is hosted on this site.</li>
        <li><b>Desktop Chrome or Edge</b>Use a desktop browser on the computer where the game is installed.</li>
        <li><b>Read-only</b>Camp Chest only reads the files. It never changes your game.</li>
      </ul>

      <h2 class="ob-h2">Which folder to pick</h2>
      <p>Pick the game's <strong>Data</strong> folder, inside the Baldur's Gate 3 folder. Common locations:</p>
      <ul class="ob-paths">${paths}</ul>

      <h2 class="ob-h2">Can't find it?</h2>
      <ol class="ob-steps">
        <li><strong>Steam:</strong> right-click Baldur's Gate 3 in your library &rsaquo; <em>Manage</em> &rsaquo; <em>Browse local files</em>.</li>
        <li><strong>GOG Galaxy:</strong> open the game &rsaquo; the settings button &rsaquo; <em>Manage installation</em> &rsaquo; <em>Show folder</em>.</li>
        <li>Copy the folder's address from the window that opens and paste it into the folder dialog's address bar
          (on macOS, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> in the dialog to type a path).</li>
      </ol>

      <div class="ob-ack">
        <label class="ob-check">
          <input type="checkbox" id="ob-ack">
          <span>I own Baldur's Gate 3 and understand game files are read locally from my computer</span>
        </label>
        <div class="ob-actions">
          <button type="button" class="ob-btn" id="ob-pick" disabled>Select the Data folder</button>
          <span class="ob-small" id="ob-pick-hint">Tick the box above to continue.</span>
        </div>
        <p class="ob-small ob-classic-note">After you pick the folder, the browser asks whether to <q>upload</q> its files.
          That is only the browser's standard wording for this dialog: the files are read inside this page and never leave
          your computer. The browser can't remember the folder, so you pick it again on each visit (later visits still
          start quickly).</p>
        <div class="ob-status" role="status" aria-live="polite"></div>
      </div>
    `);

    const ack = this.$('#ob-ack');
    const pick = this.$('#ob-pick');
    const hint = this.$('#ob-pick-hint');
    ack.addEventListener('change', () => {
      pick.disabled = !ack.checked;
      hint.hidden = ack.checked;
    });
    this.root.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(INSTALL_PATHS[+btn.dataset.copy].path, btn));
    });
    return { pick };
  }

  welcomeBack(name) {
    this.show(`
      ${this.header('Camp Chest', 'Welcome back')}
      <p>Select your Baldur's Gate 3 <code>Data</code> folder again${name ? ` (last time: <strong>${esc(name)}</strong>)` : ''}.
        The browser can't remember it between visits.</p>
      <p class="ob-small">When the browser asks whether to <q>upload</q> the files, that is just its wording: the files are
        read only inside this page and never leave your computer.</p>
      <div class="ob-actions">
        <button type="button" class="ob-btn" id="ob-pick">Select the Data folder</button>
        <button type="button" class="ob-link" id="ob-forget">Start over</button>
      </div>
      <div class="ob-status" role="status" aria-live="polite"></div>
    `, { narrow: true });
    return { pick: this.$('#ob-pick'), forget: this.$('#ob-forget') };
  }

  busy(text) {
    this.show(`
      <h1 class="ob-title" id="ob-title">${esc(text)}</h1>
      <div class="ob-spinner" aria-hidden="true"></div>
      <p class="ob-small">Reading your local game files. Nothing is uploaded.</p>
    `, { narrow: true });
  }
}

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  btn.textContent = ok ? 'Copied' : 'Select it';
  btn.classList.toggle('copied', ok);
  if (!ok) {
    const code = btn.parentElement.querySelector('code');
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1600);
}

// --------------------------------------------------------------- the flow

function describeProblem(result, pickedName) {
  if (result.unreadable === 'read') {
    return `<strong>The game files were found but couldn't be read.</strong> This usually happens with Xbox app /
      PC Game Pass installs, whose files can be protected so that other programs can't read them. Unfortunately
      Camp Chest can't work around that. A Steam or GOG copy of the game will work.`;
  }
  if (result.unreadable === 'format') {
    return `<strong><code>Gustav.pak</code> doesn't look like a Baldur's Gate 3 package.</strong> The file may be damaged
      or protected. Try verifying the game files in Steam or GOG Galaxy, then pick the folder again.`;
  }
  const all = result.missing.length === REQUIRED_FILES.length;
  const list = `<ul>${result.missing.map((m) => `<li><code>Data/${esc(m)}</code></li>`).join('')}</ul>`;
  if (all) {
    return `<strong>“${esc(pickedName)}” doesn't look like the Baldur's Gate 3 folder.</strong> Camp Chest couldn't find
      any of the game's data files there. Pick the game folder (the one containing <code>Data</code> and <code>bin</code>)
      or the <code>Data</code> folder itself. See the common locations above.`;
  }
  return `<strong>Some game files are missing</strong> from “${esc(pickedName)}”:${list}
    The installation may be incomplete or still updating. Try verifying the game files (Steam: right-click the game
    &rsaquo; Properties &rsaquo; Installed Files &rsaquo; Verify integrity), then pick the folder again.`;
}

// <input webkitdirectory>: unlike showDirectoryPicker() it works under Program Files, but it can't be remembered.
function chooseWithInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', () => { resolve(input.files && input.files.length ? input.files : null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

async function pickAndValidate(ui) {
  const list = await chooseWithInput();
  if (!list) return null;
  ui.status('Checking the folder…');
  const picked = filesDirFromList(list);
  const data = await locateDataDir(picked);
  const result = data ? await checkDataDir(data) : { ok: false, missing: REQUIRED_FILES.slice() };
  if (!result.ok) {
    ui.status(describeProblem(result, picked.name || 'that folder'), 'error');
    return null;
  }
  await saveFolder({ name: picked.name, acknowledged: true, savedAt: Date.now() });
  return data;
}

let pending = null;

export function getGameFolder() {
  if (!pending) pending = run();
  return pending;
}

async function run() {
  let rootEl = document.getElementById('onboarding');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'onboarding';
    document.body.appendChild(rootEl);
  }
  ensureCornerSymbol();
  const ui = new OnboardingUI(rootEl);

  if (!isSupported()) {
    ui.unsupported();
    return new Promise(() => {}); // nothing more can happen in this browser
  }

  const saved = await loadSaved();
  const data = saved?.acknowledged ? await welcomeBackFlow(ui, saved) : null;
  const result = data || await firstVisitFlow(ui);
  ui.hide();
  return result;
}

// Resolves with the Data dir, or null when the user chose "Start over".
function welcomeBackFlow(ui, saved) {
  return new Promise((resolve) => {
    const { pick, forget } = ui.welcomeBack(saved.name);
    const setBusy = (b) => { pick.disabled = forget.disabled = b; };
    pick.addEventListener('click', async () => {
      setBusy(true);
      ui.status('');
      const data = await pickAndValidate(ui);
      setBusy(false);
      if (data) resolve(data);
    });
    forget.addEventListener('click', async () => { setBusy(true); await forgetGameFolder(); resolve(null); });
  });
}

function firstVisitFlow(ui) {
  return new Promise((resolve) => {
    const { pick } = ui.notice();
    const ack = ui.$('#ob-ack');
    pick.addEventListener('click', async () => {
      if (!ack.checked) return;
      pick.disabled = true;
      ui.status('');
      const data = await pickAndValidate(ui);
      pick.disabled = !ack.checked;
      if (data) resolve(data);
    });
  });
}

function ensureCornerSymbol() {
  if (document.getElementById('ob-corner')) return;
  const holder = document.createElement('div');
  holder.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
    <defs><linearGradient id="ob-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f3d58e"/><stop offset=".45" stop-color="#c59a4c"/><stop offset="1" stop-color="#7a5626"/>
    </linearGradient></defs>
    <symbol id="ob-corner" viewBox="0 0 48 48">
      <g fill="none" stroke="url(#ob-gold)" stroke-linecap="round">
        <path d="M2.5 46V10Q2.5 2.5 10 2.5H46" stroke-width="1.6"/>
        <path d="M8 40V15Q8 8 15 8H40" stroke-width=".9" opacity=".75"/>
        <path d="M8 22c5.5 0 8-3 8-7.5 0-3-2-4.5-4-4.5s-3 1.6-3 3.2c0 1.5 1.1 2.3 2.2 2.3" stroke-width="1.1"/>
        <path d="M22 8c0 5.5-3 8-7.5 8" stroke-width="1.1"/>
      </g>
      <path d="M4 0 8 4 4 8 0 4Z" fill="url(#ob-gold)"/>
      <circle cx="15.5" cy="15.5" r="1.6" fill="#f3d58e"/>
    </symbol></svg>`;
  document.body.prepend(holder.firstElementChild);
}
