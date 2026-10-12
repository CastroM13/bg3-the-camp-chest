// A read-only stand-in for FileSystemDirectoryHandle over a list of File objects from <input webkitdirectory>.
// Chrome refuses showDirectoryPicker() for folders inside "Program Files" (where Steam installs by default), but the
// classic folder dialog still works there. The engine only needs entries(), getFileHandle() and getDirectoryHandle().

/** @param {Map<string, File>} files paths relative to this folder ("Gustav.pak", "Localization/English.pak") */
export function filesDir(files, name = '') {
  return {
    kind: 'directory', name, files,
    async *entries() {
      const seen = new Set();
      for (const p of files.keys()) {
        const i = p.indexOf('/');
        const n = i < 0 ? p : p.slice(0, i);
        if (seen.has(n)) continue;
        seen.add(n);
        yield [n, { kind: i < 0 ? 'file' : 'directory', name: n }];
      }
    },
    async getFileHandle(n) {
      const f = files.get(n);
      if (!f) throw new DOMException(`${n} not found`, 'NotFoundError');
      return { kind: 'file', name: n, getFile: async () => f };
    },
    async getDirectoryHandle(n) {
      const pre = n + '/', sub = new Map();
      for (const [p, f] of files) if (p.startsWith(pre)) sub.set(p.slice(pre.length), f);
      if (!sub.size) throw new DOMException(`${n} not found`, 'NotFoundError');
      return filesDir(sub, n);
    },
  };
}

/** Builds the picked folder from an <input webkitdirectory> FileList (paths start with the picked folder's name). */
export function filesDirFromList(list) {
  const files = new Map();
  let root = '';
  for (const f of list) {
    const rel = f.webkitRelativePath || f.name;
    const i = rel.indexOf('/');
    if (!root) root = i < 0 ? '' : rel.slice(0, i);
    files.set(i < 0 ? rel : rel.slice(i + 1), f);
  }
  return filesDir(files, root);
}
