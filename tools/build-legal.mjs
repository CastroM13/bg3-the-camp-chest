// Regenerates legal.html from LEGAL.md (GitHub Pages serves .md files as plain text). node tools/build-legal.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  .replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1" rel="noopener">$1</a>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u === 'LICENSE' || u.endsWith('.md') ? 'https://github.com/CastroM13/bg3-the-camp-chest/blob/main/' + u : u}" rel="noopener">${t}</a>`);
const md = readFileSync(new URL('../LEGAL.md', import.meta.url), 'utf8').replace(/\r/g, '');
let html = '', para = [], list = [];
const flush = () => {
  if (para.length) { html += `<p>${inline(para.join(' '))}</p>\n`; para = []; }
  if (list.length) { html += `<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>\n`; list = []; }
};
for (const line of md.split('\n')) {
  let m;
  if (!line.trim()) flush();
  else if ((m = /^(#{1,3}) (.*)/.exec(line))) { flush(); html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>\n`; }
  else if ((m = /^- (.*)/.exec(line))) { if (para.length) flush(); list.push(m[1]); }
  else if (list.length && /^\s+/.test(line)) list[list.length - 1] += ' ' + line.trim();
  else para.push(line.trim());
}
flush();
writeFileSync(new URL('../legal.html', import.meta.url), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Legal notice · Camp Chest</title>
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<link rel="stylesheet" href="onboarding.css">
<style>
  .legal { max-width: 820px; margin: 40px auto; padding: 32px 40px; line-height: 1.55; font-size: 18px; }
  .legal h1 { margin-top: 0; } .legal h3 { margin-top: 28px; }
  .legal a { color: #d8b36a; } .legal code { font-size: .9em; }
  @media (max-width: 600px) { .legal { margin: 16px; padding: 20px 16px; } }
</style>
</head>
<body>
<!-- generated from LEGAL.md by tools/build-legal.mjs -->
<main class="ob-page"><article class="ob-panel legal">
<p><a href="./">&larr; Back to Camp Chest</a></p>
${html.replace('<h2>', '<h1 class="ob-title">').replace('</h2>', '</h1>')}</article></main>
</body>
</html>
`);
console.log('legal.html written');
