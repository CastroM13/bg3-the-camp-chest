// Minimal reader for Larian's text .lsx files (no DOMParser in workers). Produces the same node shape as
// lib/lsf.js: { regions: { name: Node } }, Node = { id, attrs: { name: { type, value, handle? } }, children }.
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseLSXText(text) {
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  const regions = {};
  const stack = [];
  let region = null;
  let m;
  while ((m = tagRe.exec(text))) {
    const [, close, tag, rawAttrs, selfClose] = m;
    const a = {};
    let am; attrRe.lastIndex = 0;
    while ((am = attrRe.exec(rawAttrs))) a[am[1]] = unesc(am[2]);
    if (close) {
      if (tag === 'node') stack.pop();
      else if (tag === 'region') region = null;
      continue;
    }
    if (tag === 'region') { region = a.id; continue; }
    if (tag === 'node') {
      const node = { id: a.id, attrs: {}, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (region && !regions[region]) regions[region] = node;
      if (!selfClose) stack.push(node);
      continue;
    }
    if (tag === 'attribute' && stack.length) {
      const attr = { type: a.type, value: a.value ?? a.handle };
      if (a.handle !== undefined) { attr.handle = a.handle; attr.version = a.version; }
      stack[stack.length - 1].attrs[a.id] = attr;
    }
  }
  return { regions };
}

/** depth-first walk over every node */
export function* walk(node) {
  if (!node) return;
  yield node;
  for (const c of node.children || []) yield* walk(c);
}
export const val = (node, name) => node?.attrs?.[name]?.value ?? null;
export const kids = (node, id) => (node?.children || []).filter((c) => c.id === id);
export const kid = (node, id) => (node?.children || []).find((c) => c.id === id) || null;
