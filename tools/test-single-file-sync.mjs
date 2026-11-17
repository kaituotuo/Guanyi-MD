import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');

async function assertSection(sourceUrl, marker, endMarker, label) {
  const source = (await readFile(sourceUrl, 'utf8')).trimEnd();
  const start = index.indexOf(marker);
  assert.notEqual(start, -1, `${label} marker should exist in index.html`);
  const contentStart = start + marker.length;
  const end = index.indexOf(endMarker, contentStart);
  assert.notEqual(end, -1, `${label} end marker should exist in index.html`);
  assert.equal(index.slice(contentStart, end).trimEnd(), source, `${label} should match the split source byte-for-byte`);
}

await assertSection(new URL('../css/app.css', import.meta.url), '/* ===== css/app.css ===== */\n', '\n  </style>', 'CSS');
await assertSection(new URL('../js/docs-data.js', import.meta.url), '/* ===== js/docs-data.js ===== */\n', '\n\n/* ===== js/app.js ===== */', 'preset documents');
await assertSection(new URL('../js/app.js', import.meta.url), '/* ===== js/app.js ===== */\n', '\n  </script>\n  <script type="text/plain" id="third-party-licenses">', 'application JavaScript');

console.log('single-file sync passed: CSS, preset documents and application JavaScript are identical');

for (const name of ['reader-host', 'epub-reader', 'pdf-reader', 'home-workspace', 'pdf-study']) {
  for (const kind of ['js', 'css']) {
    const source = (await readFile(new URL(`../${kind}/${name}.${kind}`, import.meta.url), 'utf8')).trimEnd();
    assert.ok(index.includes(`/* ===== ${kind}/${name}.${kind} ===== */\n${source}`), `${name} ${kind} should match source`);
  }
}
const evidenceSource = (await readFile(new URL('../js/pdf-evidence.js', import.meta.url), 'utf8')).trimEnd();
assert.ok(index.includes(`/* ===== js/pdf-evidence.js ===== */\n${evidenceSource}`), 'PDF evidence module should match its source');
const paperReaderSource = (await readFile(new URL('../js/paper-reader.js', import.meta.url), 'utf8')).trimEnd();
assert.ok(index.includes(`/* ===== js/paper-reader.js ===== */\n${paperReaderSource}`), 'Paper reader engine should match its source');
const skill = await readFile(new URL('../vendor/paper-reader-skill/SKILL.md', import.meta.url), 'utf8');
const rules = index.match(/window\.GuanyiPaperReaderSkill = (.*);\n/);
assert.ok(rules, 'Original reading rules must be bundled');
const context = { window: {} };
vm.runInNewContext(`window.GuanyiPaperReaderSkill = ${rules[1]}`, context);
assert.equal(context.window.GuanyiPaperReaderSkill, skill, 'Bundled rules must preserve the pinned original skill exactly');
const skillLicense = await readFile(new URL('../vendor/paper-reader-skill/LICENSE', import.meta.url), 'utf8');
assert.ok(index.includes(`<script type="text/plain" id="paper-reader-skill-license">${skillLicense.replace(/</g, '&lt;')}</script>`), 'MIT license must be retained in distributed HTML');
