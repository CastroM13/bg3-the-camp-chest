// Engine worker: owns the game archives, builds the item index once per game version, and answers vfs requests.
// Everything it produces stays in this browser (Cache API, origin-private). Nothing is sent over the network.
import { GameFS } from './gamefs.js';
import { buildIndex } from './index.js';
import { AssetBuilder } from './assets.js';
import { httpDir } from './devdir.js';
import { filesDir } from './filesdir.js';

const INDEX_FORMAT = 3;          // bump when index.js output changes
const ASSET_FORMAT = 5;          // bump when assets.js output changes
let fs = null, builder = null, cache = null, ready = null;

const post = (msg) => self.postMessage(msg);
const progress = (fraction, label) => post({ type: 'progress', fraction, label });

async function digest(text) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function open(dataDir) {
  progress(0, 'Opening game archives');
  fs = await new GameFS(dataDir).open((f, name) => progress(f * 0.15, `Opening ${name}.pak`));
  const version = await digest(fs.version);
  const name = `camp-chest-${version}-${INDEX_FORMAT}.${ASSET_FORMAT}`;
  // drop caches made for another game version or engine format
  try {
    cache = await opfsCache(name);
  } catch (err) {   // storage unavailable (private window, blocked site data): everything still works, just rebuilt each visit
    console.warn('[engine] browser cache unavailable, files will be rebuilt on each visit:', err);
    cache = memoryCache();
  }

  let index = null;
  const hit = await cache.match('/__engine/index.json');
  if (hit) {
    progress(0.2, 'Loading the catalogue saved from your last visit');
    try { index = await hit.json(); } catch { index = null; }
  }
  if (!index) {
    index = await buildIndex(fs, (f, label) => progress(0.15 + f * 0.8, label));
    progress(0.96, 'Saving the catalogue for next time');
    await cache.put('/__engine/index.json', new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } }));
  }
  builder = new AssetBuilder(fs, index);
  progress(1, 'Ready');
  return { version, items: index.items.items.length, dyes: index.dyes.dyes.length, stats: index._stats || null };
}

// Built files live in the origin-private file system (this browser only), one folder per game version + format.
const TYPES = { json: 'application/json', gltf: 'model/gltf+json', png: 'image/png', bin: 'application/octet-stream' };
const typeOf = (k) => TYPES[k.split('.').pop()] || 'application/octet-stream';
async function opfsCache(name) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('camp-chest', { create: true });
  for await (const [k] of root.entries()) if (k !== name) await root.removeEntry(k, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(name, { create: true });
  const fname = (k) => encodeURIComponent(k).replaceAll('.', '%2E') + '.' + k.split('.').pop();
  return {
    async match(k) {
      try { const f = await (await dir.getFileHandle(fname(k))).getFile(); return new Response(f, { headers: { 'content-type': typeOf(k) } }); }
      catch { return undefined; }
    },
    async put(k, res) {
      const tmp = fname(k) + '.part';
      const h = await dir.getFileHandle(tmp, { create: true });
      const w = await h.createWritable();
      await w.write(await res.arrayBuffer());
      await w.close();
      await h.move(fname(k));
    },
  };
}

function memoryCache() {
  return { memory: true, match: async () => undefined, put: async () => {} };
}

const key = (path) => '/__vfs/' + path;

// Write freshly built files to the cache, then let older ones go from memory.
let flushing = false;
async function flush() {
  if (flushing || cache.memory) return;   // without storage, built files stay in memory
  flushing = true;
  try {
    const now = Date.now();
    for (const [path, f] of builder.files) {
      if (!f.bytes) continue;
      if (!f.cached) {
        await cache.put(key(path), new Response(f.bytes, { headers: { 'content-type': f.type } }));
        f.cached = true; f.t = now;
      } else if (now - f.t > 30000) builder.files.delete(path);
    }
  } finally { flushing = false; }
}

async function serve(path) {
  await ready;
  const hit = await cache.match(key(path));
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), type: hit.headers.get('content-type') || 'application/octet-stream' };
  const f = await builder.build(path);
  if (!f) return null;
  const out = { bytes: f.bytes, type: f.type };
  flush().catch((e) => console.warn('[engine] cache write failed', e));
  return out;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'open') {
    ready = open(msg.files ? filesDir(msg.files) : msg.dataDir || httpDir(msg.devBase));
    try { post({ type: 'ready', ...(await ready) }); }
    catch (err) { console.error(err); post({ type: 'error', message: String(err?.message || err), stack: String(err?.stack || '') }); }
  } else if (msg.type === 'vfs') {
    const port = e.ports[0];
    try {
      const f = await serve(msg.path);
      if (!f) port.postMessage({ status: 404 });
      else { const copy = f.bytes.slice(); port.postMessage({ status: 200, type: f.type, bytes: copy }, [copy.buffer]); }
    } catch (err) {
      console.error('[engine] failed to build', msg.path, err);
      port.postMessage({ status: 500, message: String(err?.message || err) });
    }
  } else if (msg.type === 'forget-cache') {
    try { await (await navigator.storage.getDirectory()).removeEntry('camp-chest', { recursive: true }); } catch { /* nothing saved */ }
    post({ type: 'cache-cleared' });
  }
};
