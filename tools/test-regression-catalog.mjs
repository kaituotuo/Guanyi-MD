import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

function parseMarkdownRow(line) {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const character of source) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      cell += character;
      escaped = true;
      continue;
    }
    if (character === '`') {
      cell += character;
      inCode = !inCode;
      continue;
    }
    if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function relativeLuminance(hexColor) {
  const channels = hexColor.replace('#', '').match(/.{2}/g).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const [checklist, packageText, runner, appSource, html, css] = await Promise.all([
  read('docs/发布前体验走查清单与矩阵验收.md'),
  read('package.json'),
  read('tools/run-regression-matrix.mjs'),
  read('js/app.js'),
  read('index.html'),
  read('css/app.css')
]);
const packageJson = JSON.parse(packageText);

const sectionNumbers = [...checklist.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1]));
assert.deepEqual(sectionNumbers, Array.from({ length: 12 }, (_, index) => index + 1), '验收清单章节必须从 1 到 12 连续编号');
assert.doesNotMatch(checklist, /## 9\. 本轮执行记录/, '不得保留旧的本轮执行记录标题');
assert.doesNotMatch(checklist, /1\.0\.18/, '当前基线不得回退到 1.0.18');

const recentRows = checklist.split(/\r?\n/).filter((line) => /^\|\s*RX-\d{2}\s*\|/.test(line));
assert.equal(recentRows.length, 42, '近期反馈锁定矩阵必须恰好包含 42 项');
const recentIds = recentRows.map((line) => parseMarkdownRow(line)[0]);
const expectedRecentIds = Array.from({ length: 42 }, (_, index) => `RX-${String(index + 1).padStart(2, '0')}`);
assert.deepEqual(recentIds, expectedRecentIds, '近期反馈编号必须从 RX-01 到 RX-42 连续且不重复');
recentRows.forEach((line, index) => {
  const cells = parseMarkdownRow(line);
  assert.equal(cells.length, 5, `${expectedRecentIds[index]} 必须保持五列表格结构`);
  assert.match(cells[3], /`test:[^`]+`/, `${expectedRecentIds[index]} 缺少 test:* 自动闸门`);
  assert.equal(cells[4], 'M', `${expectedRecentIds[index]} 必须保留发布前人工复核标记 M`);
});

const searchRows = checklist.split(/\r?\n/).filter((line) => /^\|\s*SE-\d{2}\s*\|/.test(line));
assert.equal(searchRows.length, 23, '搜索矩阵必须包含 SE-01 到 SE-23');
searchRows.forEach((line) => assert.equal(parseMarkdownRow(line).length, 4, `${parseMarkdownRow(line)[0]} 必须保持四列表格结构`));

const expectedScripts = [
  'test:source-scroll',
  'test:epub-reader',
  'test:pdf-reader',
  'test:reader-integration',
  'test:regression:readers',
  'test:markdown-clipboard',
  'test:work-question',
    'test:desktop-ai-bridge',
    'test:desktop-menu',
    'test:desktop-layout',
  'test:desktop-layout-electron',
  'test:desktop-file-actions',
  'test:directory-binary-electron',
  'test:document-rename',
  'test:regression-catalog',
  'test:regression:editor',
  'test:regression:collaboration',
  'test:regression:directory',
  'test:regression:search',
  'test:regression:recent',
  'test:regression:all'
];
expectedScripts.forEach((name) => assert.equal(typeof packageJson.scripts?.[name], 'string', `package.json 缺少 ${name}`));

const groupNames = ['readers', 'editor', 'collaboration', 'directory', 'search', 'recent', 'all'];
groupNames.forEach((name) => {
  const declaration = ['recent', 'all'].includes(name)
    ? new RegExp(`groups\\.${name}\\s*=`)
    : new RegExp(`\\b${name}\\s*:`);
  assert.match(runner, declaration, `回归运行器缺少 ${name} 分组`);
  assert.match(checklist, new RegExp(`test:regression:${name}\\b`), `验收清单缺少 test:regression:${name} 入口`);
});

assert.match(appSource, /const COLLAB_TAB_IDS = \['comments', 'reading', 'works'\];/, '协作区必须保留三个独立标签');
for (const tab of ['comments', 'reading', 'works']) {
  assert.equal((html.match(new RegExp(`<button[^>]+data-collab-panel="${tab}"`, 'g')) || []).length, 1, `${tab} 标签入口必须唯一`);
  assert.equal((html.match(new RegExp(`<section[^>]+data-collab-content="${tab}"`, 'g')) || []).length, 1, `${tab} 标签面板必须唯一`);
}
assert.match(appSource, /button\.draggable\s*=\s*true;/, '协作标签必须支持拖动排序');
assert.match(appSource, /localStorage\.setItem\(COLLAB_TAB_ORDER_KEY,/, '协作标签顺序必须持久化');
assert.match(html, /<div class="app-reading-work__footer">[\s\S]*?<textarea[^>]+id="reading-question"[\s\S]*?<button[^>]+id="btn-ask-work"[^>]*>[\s\S]*?<\/button>[\s\S]*?<\/div>/, '问作品输入框与发送按钮必须位于同一个底部操作区');
assert.match(css, /\.app-reading-work__footer\s*{[\s\S]*?flex:\s*0 0 auto;/, '问作品底部操作区必须保持独立布局');
assert.match(css, /\.app-reading-ask \.gicon\s*{[\s\S]*?--gicon-accent:\s*currentColor;[\s\S]*?color:\s*#fff;/, '问作品发送箭头的箭身和箭头必须保持高对比纯白色');
assert.match(css, /\.app-reading-ask:disabled\s*{[^}]*opacity:\s*1;[^}]*background:\s*#c43f20;/, '加载态不得通过整体透明度降低图标可见性');
for (const background of ['#df4b25', '#ed5a2f', '#bd3518', '#c43f20']) {
  assert.ok(contrastRatio('#ffffff', background) >= 3, `${background} 背景上的白色功能图标对比度必须不低于 3:1`);
}
assert.match(checklist, /图标对比：[\s\S]*?不得低于 `3:1`/, '发布自检必须包含实色背景与图标的高对比通用规则');
assert.match(checklist, /\| VW-11 \| 实色按钮图标对比 \|/, '多视图矩阵必须逐态验收实色按钮图标');
assert.match(css, /--guanyi-workspace-top:\s*calc\(var\(--guanyi-topbar-height\) \+ var\(--guanyi-formatbar-height\)\)/,
  '侧栏顶部必须由顶栏与格式工具栏共享令牌计算');
assert.match(css, /\.app-collab-drawer\s*\{[^}]*top:\s*var\(--guanyi-workspace-top\);/,
  '侧栏必须从共享工作区边界开始');
assert.match(css, /\.app-shell\.collab-open \.app-body\s*{\s*margin-right:\s*0;/, '侧栏展开时不得压缩顶部工具栏');
assert.match(css, /\.app-shell\.collab-open \.app-main \.editor-container\s*{\s*margin-right:\s*372px;/, '侧栏展开时只为正文画布预留空间');

process.stdout.write('regression catalog passed: 42 recent feedback cases and 12 execution gates verified\n');
