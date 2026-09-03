import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
