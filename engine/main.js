// Page side of the engine: starts the worker, registers the service worker that serves vfs/*, and mounts the app.
// The app runs in a same-origin iframe so this page keeps the folder permission and the worker alive.

let worker = null;

function setStatus(label, fraction) {
  const box = document.getElementById('boot-status');
  if (!box) return;
  box.hidden = false;
  let line = box.querySelector('.boot-line');
  if (!line) { line = document.createElement('p'); line.className = 'boot-line ob-small'; box.appendChild(line); }
  let bar = box.querySelector('.boot-bar');
  if (!bar) { bar = document.createElement('div'); bar.className = 'boot-bar'; bar.innerHTML = '<div></div>'; box.insertBefore(bar, line); }
  line.textContent = label;
  if (fraction != null) bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
}

function startWorker(dataDir) {
  return new Promise((resolve, reject) => {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') setStatus(m.label, m.fraction);
      else if (m.type === 'ready') resolve(m);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'The engine worker failed to start'));
    // files from the folder dialog (engine/filesdir.js), a real directory handle, or the localhost test server
    const open = dataDir?.files instanceof Map ? { type: 'open', files: dataDir.files }
      : dataDir ? { type: 'open', dataDir } : { type: 'open', devBase: new URL('../__bg3data/', import.meta.url).href };
    worker.postMessage(open);
  });
}

async function startServiceWorker() {
  const base = new URL('../', import.meta.url);
  const reg = await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
  // the service worker asks this page for every vfs/* file; hand the request to the engine worker
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'vfs' || !worker) return;
    worker.postMessage({ type: 'vfs', path: e.data.path }, [e.ports[0]]);
  });
  navigator.serviceWorker.startMessages?.();
  await navigator.serviceWorker.ready;
  // tell the service worker which window hosts the engine
  (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'engine-host' });
  return reg;
}

export async function startApp(dataDir) {
  setStatus('Starting', 0);
  const [info] = await Promise.all([startWorker(dataDir), startServiceWorker()]);
  console.info('[camp-chest] engine ready', info);
  const reg = await navigator.serviceWorker.ready;
  reg.active.postMessage({ type: 'engine-host' });

  const frame = document.createElement('iframe');
  frame.id = 'app-frame';
  frame.title = 'Camp Chest';
  frame.src = new URL('../app/' + location.hash, import.meta.url).href;
  frame.allow = 'clipboard-write';
  document.body.appendChild(frame);
  const change = document.createElement('button');
  change.id = 'change-folder'; change.type = 'button'; change.textContent = 'Change game folder';
  change.title = 'Forget this game folder and the files built from it, then pick again';
  change.addEventListener('click', async () => { worker?.terminate(); await (await import('../onboarding.js')).forgetGameFolder(); location.reload(); });
  document.body.appendChild(change);
  document.body.classList.add('app-mounted');
  await new Promise((r) => frame.addEventListener('load', r, { once: true }));
  // keep the address bar hash in sync with the app (deep links like #WPN_Longsword)
  const sync = () => { try { const h = frame.contentWindow.location.hash; if (h !== location.hash) history.replaceState(null, '', h || location.pathname); } catch { /* ignore */ } };
  frame.contentWindow.addEventListener('hashchange', sync);
  window.addEventListener('hashchange', () => { try { if (frame.contentWindow.location.hash !== location.hash) frame.contentWindow.location.hash = location.hash; } catch { /* ignore */ } });
}

export function forgetCache() { worker?.postMessage({ type: 'forget-cache' }); }
