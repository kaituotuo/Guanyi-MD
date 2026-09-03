import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const projectRoot = new URL('..', import.meta.url);
const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extract(startMarker, endMarker, expression) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return vm.runInNewContext(`(() => { ${appSource.slice(start, end)}; return ${expression}; })()`);
}

const computeFormat = extract('function markerRunLength(', '\n  function insertTablePure', 'computeFormat');
const computeBlockFormat = extract('function applyTextEdits(', '\n  function applySourceTransform', 'computeFormat');
const continueListPure = extract('function continueListPure(', '\n  function selectedLineBounds', 'continueListPure');
const imageHelpers = extract('function imageInsertionLines(', '\n  function applyImageBlocks', '{ insertImageBlocks, imageStructuralLine }');
const findHelpers = extract('function contentFindMatches(', '\n  function openContentFind', '{ contentFindMatches, replaceContentMatches }');

function applyAction(markdown, action, needle) {
  const start = markdown.indexOf(needle);
  assert.notEqual(start, -1, `missing action target ${needle}`);
  const result = computeBlockFormat(markdown, start, start + needle.length, action);
  assert.ok(result, `${action} should transform ${needle}`);
  return result.text;
}

function assertNoOrphanTasks(markdown, label) {
  assert.doesNotMatch(markdown, /^\s*[-*+]\s+\[[ xX]\]\s*$/m, `${label} must not create an orphan task item`);
}

const image = '![图](assets/test.png)';
const scenarios = [];

// Core cross-feature chains: every chain starts in ordinary text and crosses list,
// image, quote, and ordered-list boundaries before returning to a task item.
for (const [view, suffix] of [['source', '\n'], ['preview', '\n\n'], ['split', '\n\n']]) {
  let markdown = `任务一${suffix}步骤二${suffix}说明三${suffix}收尾四`;
  markdown = applyAction(markdown, 'task', '任务一');
  const imageAnchor = markdown.indexOf('\n', markdown.indexOf('任务一'));
  markdown = imageHelpers.insertImageBlocks(markdown, imageAnchor, imageAnchor, [image]).text;
  markdown = applyAction(markdown, 'ol', '步骤二');
  markdown = applyAction(markdown, 'quote', '说明三');
  markdown = applyAction(markdown, 'task', '收尾四');
  assert.match(markdown, /^- \[ \] 任务一/m, `${view}: task should survive image insertion`);
  assert.match(markdown, /^1\. 步骤二/m, `${view}: ordered list should survive mixed operations`);
  assert.match(markdown, /^> 说明三/m, `${view}: quote should survive mixed operations`);
  assert.match(markdown, /^- \[ \] 收尾四/m, `${view}: final task should survive mixed operations`);
  assertNoOrphanTasks(markdown, `${view}: mixed chain`);
  scenarios.push(`${view}: task -> image -> ordered -> quote -> task`);
}

// List continuation matrix: beginning, middle, end, completed tasks, and empty exit.
for (const [kind, line] of [
  ['task', '- [ ] 新增处理'], ['task-checked', '- [x] 新增处理'],
  ['unordered', '- 新增处理'], ['unordered-star', '* 新增处理'],
  ['ordered', '7. 新增处理'], ['quote', '> 新增处理']
]) {
  for (const position of [line.indexOf('新增'), line.indexOf('处理'), line.length]) {
    const result = continueListPure(line, position, position);
    assert.ok(result, `${kind} should continue at position ${position}`);
    assert.match(result.text, /\n/, `${kind} continuation should insert a new line`);
    scenarios.push(`${kind}: Enter at ${position}`);
  }
}
for (const empty of ['- [ ] ', '- [x] ', '- ', '* ', '7. ', '> ']) {
  const result = continueListPure(empty, empty.length, empty.length);
  assert.ok(result, `empty list ${empty} should be handled`);
  assert.equal(result.text, '', `empty list ${empty} should exit to a paragraph`);
  scenarios.push(`empty-list exit: ${JSON.stringify(empty)}`);
}

// Formatting combinations: toggles must compose and then return to the original text.
for (const sequence of [
  ['bold', 'italic', 'strike'], ['italic', 'bold', 'inlinecode'],
  ['bold', 'strike', 'italic'], ['inlinecode', 'bold']
]) {
  let value = '组合文本';
  for (const action of sequence) value = computeFormat(value, 0, value.length, action).text;
  assert.ok(value.includes('组合文本'), `format sequence ${sequence.join(' -> ')} should keep content`);
  scenarios.push(`format: ${sequence.join(' -> ')}`);
}

// Image row boundaries: one through seven images, with the seventh starting a new row.
for (let count = 1; count <= 7; count += 1) {
  const blocks = Array.from({ length: count }, (_, index) => `![${index + 1}](x)`);
  const result = imageHelpers.insertImageBlocks('正文', 2, 2, blocks, { ensureTrailingLine: true });
  assert.equal((result.text.match(/!\[[^\]]*\]\([^\n)]+\)/g) || []).length, count, `${count} images should all be preserved`);
  if (count <= 6) assert.doesNotMatch(result.text, /\n\n!\[7\]/, `${count} images should fit in one row`);
  scenarios.push(`images: ${count} in one insertion`);
}

// Atomic image rows must never inherit adjacent block formats, and legacy
// prefixed image rows must be recoverable through the same toolbar action.
for (const action of ['ul', 'ol', 'task', 'quote', 'heading']) {
  const source = `前文\n\n${image}\n\n后文`;
  const result = computeBlockFormat(source, 0, source.length, action, action === 'heading' ? 2 : undefined);
  assert.equal((result.text.match(/!\[[^\]]*\]\([^\n)]+\)/g) || []).length, 1, `${action}: image token should remain intact`);
  assert.match(result.text, new RegExp(`\\n\\n${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n`), `${action}: image boundaries should remain intact`);
  scenarios.push(`${action}: text -> image -> text`);
}
for (const broken of [`1. ${image}`, `- ${image}`, `- [ ] ${image}`, `> ${image}`, `## ${image}`]) {
  const result = computeBlockFormat(broken, 0, broken.length, 'ol');
  assert.equal(result.text, image, `legacy image prefix should be removable: ${broken}`);
  scenarios.push(`image prefix recovery: ${broken.slice(0, broken.indexOf('!')).trim()}`);
}

// Find/replace is exercised after structural edits, including no-result feedback.
const searchText = '- [ ] 任务甲\n\n![图](assets/test.png)\n\n> 任务甲';
assert.equal(findHelpers.contentFindMatches(searchText, '任务甲').length, 2);
assert.equal(findHelpers.contentFindMatches(searchText, '不存在').length, 0);
assert.equal(findHelpers.replaceContentMatches(searchText, '任务甲', '任务乙').count, 2);
assert.equal(findHelpers.replaceContentMatches(searchText, '任务甲', '任务乙').text.includes('任务乙'), true);
scenarios.push('find/replace: hit, no-result, replace-all');

// View contract: all three editor modes and the separator must remain wired in the shipped HTML.
const viewModeStart = appSource.indexOf('function setViewMode(');
const viewModeEnd = appSource.indexOf('\n  function bindViewSeg', viewModeStart);
assert.notEqual(viewModeStart, -1, 'view mode transition should exist');
const viewModeSource = appSource.slice(viewModeStart, viewModeEnd);
assert.match(viewModeSource, /state\.viewMode = mode/);
assert.match(viewModeSource, /updatePreviewEditableState\(mode\)/);
const editableStateStart = appSource.indexOf('function updatePreviewEditableState(');
const editableStateEnd = appSource.indexOf('\n  function renderPreview', editableStateStart);
assert.notEqual(editableStateStart, -1, 'preview editable-state transition should exist');
const editableStateSource = appSource.slice(editableStateStart, editableStateEnd);
assert.match(editableStateSource, /mode === 'preview'/);
assert.match(editableStateSource, /mode === 'split'/);
assert.match(editableStateSource, /isPlainTextDocument\(doc\) \? 'plaintext-only' : 'true'/);
assert.match(indexSource, /<textarea[^>]+class="editor-source"[^>]+wrap="soft"[^>]+id="source-editor"/);
assert.match(indexSource, /<div[^>]+class="editor-preview"[^>]+id="preview-editor"[^>]+contenteditable="true"/);
assert.match(indexSource, /<div[^>]+class="app-split-resizer"[^>]+id="split-resizer"[^>]+role="separator"/);
scenarios.push('views: source + preview + split + resizer');

console.log(`editor matrix passed: ${scenarios.length} cross-feature scenarios`);
