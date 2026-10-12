// Camp Chest service worker. It serves vfs/* (catalogue data, models, textures, icons) by asking the page that hosts
// the engine to build them from the visitor's own game files. Every other request goes to the network as usual.
const SCOPE = new URL(self.registration.scope);
const VFS = SCOPE.pathname + 'vfs/';
let hostId = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => { if (e.data?.type === 'engine-host' && e.source) hostId = e.source.id; });

async function hostClient() {
  if (hostId) { const c = await self.clients.get(hostId); if (c) return c; }
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const host = all.find((c) => { const p = new URL(c.url).pathname; return p === SCOPE.pathname || p === SCOPE.pathname + 'index.html'; });
  if (host) hostId = host.id;
  return host || null;
}

function ask(client, path) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ status: 504 }), 180000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    client.postMessage({ type: 'vfs', path }, [ch.port2]);
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(VFS)) return;
  e.respondWith((async () => {
    const path = decodeURIComponent(url.pathname.slice(VFS.length));
    const client = await hostClient();
    if (!client) return new Response('Camp Chest is not open: start it from the home page.', { status: 503 });
    const r = await ask(client, path);
    if (r.status !== 200) return new Response(r.message || 'Not found', { status: r.status || 500 });
    return new Response(r.bytes, { headers: { 'content-type': r.type, 'cache-control': 'no-store' } });
  })());
});
