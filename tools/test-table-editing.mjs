import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
const start = appSource.indexOf('function escapeMarkdownTableCell(');
const end = appSource.indexOf('\n  function tableCellMarkdown', start);
assert.notEqual(start, -1, 'table serializer helpers should exist');
assert.notEqual(end, -1, 'table serializer helpers should have a stable boundary');
const { escapeMarkdownTableCell, markdownTableGrid } = vm.runInNewContext(
  `(() => { ${appSource.slice(start, end)}; return { escapeMarkdownTableCell, markdownTableGrid }; })()`
);

assert.equal(escapeMarkdownTableCell('A|B\nC'), 'A\\|B<br>C');
assert.equal(
  markdownTableGrid([
    ['表头', '居中', '右侧'],
    ['普通文本', 'A|B', '第一行\n第二行'],
    ['', '保留空格', '']
  ], ['left', 'center', 'right']),
  '| 表头 | 居中 | 右侧 |\n| :--- | :---: | ---: |\n| 普通文本 | A\\|B | 第一行<br>第二行 |\n|   | 保留空格 |   |'
);
assert.match(appSource, /turndownService\.addRule\('gfmTable'[\s\S]+markdownTableFromElement/,
  'preview HTML tables should use the GFM table serializer during Markdown writeback');
assert.match(appSource, /const breakToken = 'GUANYITABLECELLBREAKTOKEN'/,
  'table line-break placeholders must not contain Markdown punctuation that Turndown can escape');
assert.match(appSource, /function preparePreviewTables\([\s\S]+app-table-cell-content/,
  'preview tables should use a stable editable payload inside each cell');
assert.match(appSource, /function bindPreviewTableEditing\([\s\S]+event\.key === 'Tab'[\s\S]+event\.key === 'Enter'/,
  'table cells should support conventional Tab navigation and in-cell line breaks');
for (const command of ['row-above', 'row-below', 'column-left', 'column-right', 'row-delete', 'column-delete', 'table-delete']) {
  assert.match(indexSource, new RegExp(`data-table-command="${command}"`), `table toolbar should expose ${command}`);
}
assert.match(appSource, /function runPreviewTableCommand\([\s\S]+insertPreviewTableRow[\s\S]+insertPreviewTableColumn[\s\S]+deletePreviewTableRow[\s\S]+deletePreviewTableColumn/,
  'table toolbar commands should mutate the selected row or column through one routed workflow');
const insertTableStart = appSource.indexOf('function insertTablePure(');
const insertTableEnd = appSource.indexOf('\n  function markdownTableCountBefore', insertTableStart);
assert.notEqual(insertTableStart, -1, 'table insertion helper should exist');
assert.notEqual(insertTableEnd, -1, 'table insertion helper should have a stable boundary');
const insertTablePure = vm.runInNewContext(`(() => {
  const TABLE_MAX_ROWS = 8;
  const TABLE_MAX_COLS = 10;
  ${appSource.slice(insertTableStart, insertTableEnd)}
  return insertTablePure;
})()`);
const middleInsert = insertTablePure('第一段\n\n第二段', 5, 5, 2, 1);
assert.match(middleInsert.text, /^第一段\n\n\| 列 1 \|\n\| --- \|\n\|  \|\n\n第二段$/,
  'a table inserted from a preview caret must stay at that caret instead of appending to the document');
assert.match(appSource, /function insertTable\([\s\S]+captureImageInsertion\(\{ surface: 'preview' \}\)[\s\S]+selectPreviewTableCell/,
  'preview table insertion must reuse the caret anchor and restore focus to the inserted cell');
assert.match(cssSource, /\.editor-preview th, \.editor-preview td \{[\s\S]+height: 48px;[\s\S]+vertical-align: middle/,
  'preview table rows should keep a readable mature-editor default height');
assert.match(cssSource, /\.editor-preview \.app-table-cell-content \{[\s\S]+min-height: 48px;[\s\S]+line-height: 22px/,
  'cell caret height should be constrained to the editable content line box');
assert.match(appSource, /const HISTORY_LIMIT = 50;/, 'each document should retain 50 undo steps');
const trimStart = appSource.indexOf('function trimHistory(');
const trimEnd = appSource.indexOf('\n  function resetHistoryCoalescing', trimStart);
const trimHistory = vm.runInNewContext(`(${appSource.slice(trimStart, trimEnd)})`, {
  HISTORY_LIMIT: 50,
  activeHistoryLimit: () => 50
});
const history = { entries: Array.from({ length: 60 }, (_, index) => `v${index}`), uiEntries: Array(60).fill(null), index: 59 };
trimHistory(history);
assert.equal(history.entries.length, 51, '50 undo steps require the current entry plus 50 prior entries');
assert.equal(history.entries[0], 'v9');
assert.equal(history.index, 50);
assert.doesNotMatch(indexSource, /id="btn-download-review-json"|data-sidecar-format="json"/,
  'the shipped UI should no longer present review.json as a collaboration file');

console.log('table editing and 50-step history contracts: PASS');
