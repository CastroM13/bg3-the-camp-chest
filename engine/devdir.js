// Test-only stand-in for a FileSystemDirectoryHandle, backed by test/dev_server.py on localhost.
// Used when the page is opened as http://localhost:<port>/?devdata (automated browser tests cannot use the picker).
async function get(url, start, end) {   // the local test server occasionally drops a connection under load
  for (let i = 0; ; i++) {
    try { return await (await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })).arrayBuffer(); }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
  }
}

export function httpDir(base) {
  return {
    kind: 'directory', name: decodeURIComponent(base.split('/').filter(Boolean).pop()),
    async *entries() { for (const e of await (await fetch(base + '?list')).json()) yield [e.name, { kind: e.kind }]; },
    async getDirectoryHandle(n) { const r = await fetch(base + encodeURIComponent(n) + '/?list'); if (!r.ok) throw new DOMException('not found', 'NotFoundError'); return httpDir(base + encodeURIComponent(n) + '/'); },
    async getFileHandle(n) {
      const url = base + encodeURIComponent(n);
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      if (!r.ok) throw new DOMException('not found', 'NotFoundError');
      const size = +r.headers.get('X-File-Size'), lastModified = +r.headers.get('X-Last-Modified');
      const mk = (start, end) => ({ size: end - start,
        slice: (a = 0, b = end - start) => mk(start + a, start + Math.min(b, end - start)),
        arrayBuffer: async () => end <= start ? new ArrayBuffer(0) : get(url, start, end) });
      return { kind: 'file', name: n, getFile: async () => Object.assign(mk(0, size), { name: n, lastModified }) };
    },
  };
}
