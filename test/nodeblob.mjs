// Minimal Blob-like reader for Node (Node's openAsBlob mis-sizes files > 4 GB). Browser File objects are fine.
import { openSync, readSync, fstatSync, existsSync } from 'node:fs';
export function fileBlob(path) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  const mk = (start, end) => ({
    size: end - start,
    slice: (a = 0, b = end - start) => mk(start + a, start + Math.min(b, end - start)),
    arrayBuffer: async () => { const buf = Buffer.alloc(end - start); readSync(fd, buf, 0, end - start, start); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
  });
  return mk(0, size);
}
export const partOpener = (dataDir, pakName) => {
  const base = pakName.replace(/\.pak$/i, '');
  return (part) => fileBlob(`${dataDir}/${part ? `${base}_${part}` : base}.pak`);
};
