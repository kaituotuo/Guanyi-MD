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

const readerStyles = await Promise.all(['reader-host', 'epub-reader', 'pdf-reader'].map(async (name) =>
  `/* ===== css/${name}.css ===== */\n${(await readFile(resolve(demoDir, `css/${name}.css`), 'utf8')).trimEnd()}`));
const readerScripts = await Promise.all(['reader-host', 'epub-reader', 'pdf-reader'].map(async (name) =>
  `/* ===== js/${name}.js ===== */\n${(await readFile(resolve(demoDir, `js/${name}.js`), 'utf8')).trimEnd()}`));
const readerBundle = `<style id="format-reader-styles">\n${readerStyles.join('\n')}\n</style>
<script src="vendor/jszip.min.js"></script>
<script src="vendor/epub.min.js"></script>
<script id="format-readers">\n${readerScripts.join('\n')}\n</script>`;
const readerStart = '<!-- FORMAT READERS START -->';
const readerEnd = '<!-- FORMAT READERS END -->';
if (!html.includes(readerStart)) html = html.replace('  <script>\n/* ===== vendor/', `${readerStart}\n${readerEnd}\n  <script>\n/* ===== vendor/`);
html = replaceSection(html, readerStart, readerEnd, `\n${readerBundle}\n`);
await writeFile(indexPath, html, 'utf8');
