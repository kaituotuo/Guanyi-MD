import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(toolsDir, '..');
const indexPath = resolve(demoDir, 'index.html');

function replaceSection(source, marker, endMarker, content) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing marker: ${marker}`);
  const contentStart = markerIndex + marker.length;
  const contentEnd = source.indexOf(endMarker, contentStart);
  if (contentEnd < 0) throw new Error(`Missing section end after: ${marker}`);
  return source.slice(0, contentStart) + content.trimEnd() + source.slice(contentEnd);
}

let html = await readFile(indexPath, 'utf8');
const css = await readFile(resolve(demoDir, 'css/app.css'), 'utf8');
const docsData = await readFile(resolve(demoDir, 'js/docs-data.js'), 'utf8');
const js = await readFile(resolve(demoDir, 'js/app.js'), 'utf8');

html = replaceSection(html, '/* ===== css/app.css ===== */\n', '\n  </style>', css);
html = replaceSection(
  html,
  '/* ===== js/docs-data.js ===== */\n',
  '\n\n/* ===== js/app.js ===== */',
  docsData
);
html = replaceSection(
  html,
  '/* ===== js/app.js ===== */\n',
  '\n  </script>\n  <script type="text/plain" id="third-party-licenses">',
  js
);

await writeFile(indexPath, html, 'utf8');
