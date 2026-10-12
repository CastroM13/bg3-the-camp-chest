// Extracts Localization/English/english.loca from the game's English.pak with lib/pak.js, parses it with
// lib/lsf.js parseLoca(), and compares it with Divine's XML conversion (extract/Localization/english.xml).
// Usage: node test/loca-test.mjs
import { readFileSync } from 'node:fs';
import { Pak } from '../lib/pak.js';
import { parseLoca, parseLocaEntries } from '../lib/lsf.js';
import { partOpener } from './nodeblob.mjs';

const DATA = 'C:/Program Files (x86)/Steam/steamapps/common/Baldurs Gate 3/Data';
const XML = 'C:/Users/castro/Documents/BG3Catalog/extract/Localization/english.xml';
const ENTRY = 'Localization/English/english.loca';

const pak = await new Pak(partOpener(`${DATA}/Localization`, 'English.pak')).open();
if (!pak.has(ENTRY)) throw new Error(`${ENTRY} not found in English.pak`);
const t0 = performance.now();
const bytes = await pak.read(ENTRY);
const t1 = performance.now();
const entries = parseLocaEntries(bytes);
const map = parseLoca(bytes);
const t2 = performance.now();
console.log(`english.loca: ${(bytes.length / 1e6).toFixed(1)} MB, read ${(t1 - t0).toFixed(0)} ms, parse (entries + map) ${(t2 - t1).toFixed(0)} ms, ${entries.length} entries, ${map.size} unique handles`);

// Divine XML: <content contentuid="..." version="N">text</content>
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const xml = readFileSync(XML, 'utf8');
const re = /<content contentuid="([^"]*)" version="(\d+)"(?:\s*\/>|>([\s\S]*?)<\/content>)/g;
const ref = [];
let m;
while ((m = re.exec(xml))) ref.push({ handle: m[1], version: +m[2], text: unesc(m[3] ?? '') });
console.log(`english.xml: ${ref.length} <content> entries`);

// .NET's XmlWriter writes "\n" in text as "\r\n" (NewLineHandling.Replace) and any XML parser maps "\r\n" back to
// "\n" (XML 1.0 section 2.11), so a raw-text mismatch that disappears after that normalisation is a match.
let exact = 0, eol = 0, textDiff = 0, verDiff = 0, missing = 0;
const samples = [];
const byHandle = new Map(entries.map((e) => [e.handle, e]));
for (const r of ref) {
  const e = byHandle.get(r.handle);
  if (!e) { missing++; if (samples.length < 5) samples.push(`missing ${r.handle}`); continue; }
  if (e.version !== r.version) verDiff++;
  if (e.text === r.text) exact++;
  else if (e.text === r.text.replace(/\r\n?/g, '\n')) eol++;
  else { textDiff++; if (samples.length < 5) samples.push(`${r.handle}: loca ${JSON.stringify(e.text.slice(0, 120))} vs xml ${JSON.stringify(r.text.slice(0, 120))}`); }
}
const orderSame = ref.length === entries.length && ref.every((r, i) => r.handle === entries[i].handle);
console.log(`text exact: ${exact}/${ref.length} (${(100 * exact / ref.length).toFixed(4)}%), equal after XML CRLF->LF normalisation: ${eol}, total match: ${exact + eol}/${ref.length}, text differs: ${textDiff}, version differs: ${verDiff}, missing in loca: ${missing}`);
console.log(`entry order identical to XML: ${orderSame}; loca entries not in XML: ${entries.length - ref.length + missing}`);
for (const s of samples) console.log('  ' + s);
process.exitCode = textDiff || verDiff || missing ? 1 : 0;
