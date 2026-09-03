import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
const functionStart = appSource.indexOf('function continueListPure(');
const functionEnd = appSource.indexOf('\n  function selectedLineBounds', functionStart);
assert.notEqual(functionStart, -1, 'continueListPure should exist in js/app.js');
assert.notEqual(functionEnd, -1, 'continueListPure should end before selectedLineBounds');
const continueListPure = vm.runInNewContext(`(${appSource.slice(functionStart, functionEnd)})`);

const structuralNormalizeStart = appSource.indexOf('function normalizePreviewStructuralMarkdown(');
const structuralNormalizeEnd = appSource.indexOf('\n  function flushPendingPreviewCommit', structuralNormalizeStart);
assert.notEqual(structuralNormalizeStart, -1, 'normalizePreviewStructuralMarkdown should exist in js/app.js');
assert.notEqual(structuralNormalizeEnd, -1, 'normalizePreviewStructuralMarkdown should end before flushPendingPreviewCommit');
const normalizePreviewStructuralMarkdown = vm.runInNewContext(
  `(${appSource.slice(structuralNormalizeStart, structuralNormalizeEnd)})`
);

const formattingStart = appSource.indexOf('function markerRunLength(');
const formattingEnd = appSource.indexOf('\n  function insertTablePure', formattingStart);
assert.notEqual(formattingStart, -1, 'formatting helpers should exist in js/app.js');
assert.notEqual(formattingEnd, -1, 'formatting helpers should end before insertTablePure');
const computeFormat = vm.runInNewContext(
  `(() => { ${appSource.slice(formattingStart, formattingEnd)}; return computeFormat; })()`
);
const editingHelpersStart = appSource.indexOf('function applyTextEdits(');
const editingHelpersEnd = appSource.indexOf('\n  function applySourceTransform', editingHelpersStart);
assert.notEqual(editingHelpersStart, -1, 'editing helpers should exist in js/app.js');
assert.notEqual(editingHelpersEnd, -1, 'editing helpers should end before applySourceTransform');
const computeBlockFormat = vm.runInNewContext(
  `(() => { ${appSource.slice(editingHelpersStart, editingHelpersEnd)}; return computeFormat; })()`
);

const taskMarkerStart = appSource.indexOf('function taskMarkers(');
const taskMarkerEnd = appSource.indexOf('\n  function ensureTaskContent', taskMarkerStart);
assert.notEqual(taskMarkerStart, -1, 'source task marker scanner should exist');
assert.notEqual(taskMarkerEnd, -1, 'source task marker scanner should have a stable boundary');
const taskMarkers = vm.runInNewContext(`(${appSource.slice(taskMarkerStart, taskMarkerEnd)})`);

const imageInsertionStart = appSource.indexOf('function imageInsertionLines(');
const imageInsertionEnd = appSource.indexOf('\n  function applyImageBlocks', imageInsertionStart);
assert.notEqual(imageInsertionStart, -1, 'image insertion boundary helpers should exist in js/app.js');
assert.notEqual(imageInsertionEnd, -1, 'image insertion helpers should end before applyImageBlocks');
const insertImageBlocks = vm.runInNewContext(
  `(() => { ${appSource.slice(imageInsertionStart, imageInsertionEnd)}; return insertImageBlocks; })()`
);

function caretCase(source, expected) {
  const caret = source.indexOf('|');
  const expectedCaret = expected.indexOf('|');
  assert.notEqual(caret, -1, `missing caret marker in ${source}`);
  assert.notEqual(expectedCaret, -1, `missing expected caret marker in ${expected}`);
  const text = source.slice(0, caret) + source.slice(caret + 1);
  const expectedText = expected.slice(0, expectedCaret) + expected.slice(expectedCaret + 1);
  const result = continueListPure(text, caret, caret);
  assert.ok(result, `expected list continuation for ${source}`);
  assert.equal(result.text, expectedText, source);
  assert.equal(result.selStart, result.selEnd, `${source} should leave a collapsed caret`);
  assert.equal(result.selStart, expectedCaret, `${source} should place the caret after the inherited marker`);
}

const cases = [
  ['- [ ] |新增处理', '- [ ] \n- [ ] |新增处理'],
  ['- [ ] 新增|处理', '- [ ] 新增\n- [ ] |处理'],
  ['- [ ] 新增处理|', '- [ ] 新增处理\n- [ ] |'],
  ['- [x] 新增|处理', '- [x] 新增\n- [ ] |处理'],
  ['- 新增|处理', '- 新增\n- |处理'],
  ['* 新增|处理', '* 新增\n* |处理'],
  ['7. 新增|处理', '7. 新增\n8. |处理'],
  ['7) 新增|处理', '7) 新增\n8) |处理'],
  ['3. [ ] 新增|处理', '3. [ ] 新增\n4. [ ] |处理'],
  ['3) [x] 新增|处理', '3) [x] 新增\n4) [ ] |处理'],
  ['  - [x] 新增|处理', '  - [x] 新增\n  - [ ] |处理'],
  ['> 新增|处理', '> 新增\n> |处理']
];

for (const [source, expected] of cases) caretCase(source, expected);

function assertResult(actual, expected, message) {
  assert.ok(actual, message);
  assert.equal(actual.text, expected.text, message);
  assert.equal(actual.selStart, expected.selStart, message);
  assert.equal(actual.selEnd, expected.selEnd, message);
}

assertResult(
  continueListPure('- [ ] 新增处理', 7, 9),
  { text: '- [ ] 新\n- [ ] 理', selStart: 14, selEnd: 14 },
  'a same-line selection should be replaced by a continued task item'
);
assertResult(
  continueListPure('- [ ] ', 6, 6),
  { text: '', selStart: 0, selEnd: 0 },
  'Enter on an empty task item should exit the list'
);
assertResult(
  continueListPure('- ', 2, 2),
  { text: '', selStart: 0, selEnd: 0 },
  'Enter on an empty unordered item should exit the list'
);
assertResult(
  continueListPure('3. ', 3, 3),
  { text: '', selStart: 0, selEnd: 0 },
  'Enter on an empty ordered item should exit the list'
);
assert.equal(continueListPure('普通文本', 2, 2), null, 'plain text should use the native Enter behavior');
assert.equal(continueListPure('- 第一行\n- 第二行', 2, 9), null, 'multi-line selections stay outside the single-item transaction');

assert.equal(
  normalizePreviewStructuralMarkdown('  \n\n- [ ] 后项'),
  '- [ ] 后项',
  'exiting the first list item should not leave an invisible leading hard break'
);
assert.equal(
  normalizePreviewStructuralMarkdown('- [ ] 第一\n\n- [ ] 第三'),
  '- [ ] 第一\n\n- [ ] 第三',
  'separate lists around an empty paragraph should retain their Markdown boundary'
);
assert.equal(
  normalizePreviewStructuralMarkdown('- 第一\n\n  \n\n- 第三'),
  '- 第一\n\n- 第三',
  'an empty structural paragraph should collapse to one Markdown block boundary'
);

const taskDecoratorStart = appSource.indexOf('function ensureTaskContent(');
const taskDecoratorEnd = appSource.indexOf('\n  function prepareTaskCheckboxes', taskDecoratorStart);
assert.notEqual(taskDecoratorStart, -1, 'task content normalizer should exist');
assert.notEqual(taskDecoratorEnd, -1, 'task content normalizer should have a stable boundary');
const taskDecoratorSource = appSource.slice(taskDecoratorStart, taskDecoratorEnd);
assert.match(taskDecoratorSource, /checkboxHost !== item[\s\S]*?checkboxHost\.tagName === 'P'/, 'loose task-list paragraphs should be detected');
assert.match(taskDecoratorSource, /item\.insertBefore\(checkbox, checkboxHost\)[\s\S]*?checkboxHost\.remove\(\)/, 'a loose-list checkbox should become a direct list-item child');
assert.match(taskDecoratorSource, /while \(checkboxHost\.firstChild\) content\.appendChild\(checkboxHost\.firstChild\)/, 'loose-list text should move into the task content cell');
assert.match(cssSource, /\.editor-preview li\.task-list-item\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/, 'task items should keep the checkbox and text in a stable two-column row');
assert.equal(
  normalizePreviewStructuralMarkdown('    code\n\n正文'),
  '    code\n\n正文',
  'leading indented code must not be mistaken for an empty paragraph'
);

const mixedTaskSource = [
  '- [x] 正文任务',
  '```md',
  '- [x] 围栏中的示例',
  '```',
  '    - [x] 缩进代码中的示例',
  '> - [ ] 引用任务',
  '1. [ ] 有序任务',
  '- 项目',
  '  - [x] 嵌套任务'
].join('\n');
const mixedMarkers = taskMarkers(mixedTaskSource);
assert.deepEqual(
  JSON.parse(JSON.stringify(mixedMarkers.map((marker) => ({ checked: marker.checked, listType: marker.listType, quoteDepth: marker.quoteDepth, indent: marker.indent })))),
  [
    { checked: true, listType: 'ul', quoteDepth: 0, indent: 0 },
    { checked: false, listType: 'ul', quoteDepth: 1, indent: 0 },
    { checked: false, listType: 'ol', quoteDepth: 0, indent: 0 },
    { checked: true, listType: 'ul', quoteDepth: 0, indent: 2 }
  ],
  'task markers must skip fenced/indented code while retaining quote, ordered, and nested tasks'
);
assert.equal(mixedMarkers[0].index, mixedTaskSource.indexOf('[x]') + 1, 'task state offset should point to the source state character');
assert.equal(mixedMarkers[1].index, mixedTaskSource.indexOf('[ ]', mixedMarkers[0].index) + 1, 'quoted task state offset should remain source-relative');
const crlfSource = '- [ ] 第一\r\n1. [x] 第二\r\n';
assert.equal(taskMarkers(crlfSource)[1].index, crlfSource.indexOf('[x]') + 1, 'CRLF source offsets must not drift');

const compactListStart = appSource.indexOf("turndownService.addRule('compactListItem'");
const compactListEnd = appSource.indexOf('\n  }\n\n  function normalizeSettings', compactListStart);
assert.notEqual(compactListStart, -1, 'list serializer should exist');
const compactListSource = appSource.slice(compactListStart, compactListEnd);
assert.match(compactListSource, /const ordered = parent\?\.nodeName === 'OL'/, 'list serializer should detect ordered parents for task items');
assert.match(compactListSource, /prefix = checkbox \? `\$\{marker\}\[\$\{checkbox\.checked \? 'x' : ' '\}\] /, 'ordered task items should retain an ordered marker');
assert.match(compactListSource, /body\.split\('\\n'\)\.map/, 'list serializer should normalize continuation lines one line at a time');

assert.match(appSource, /function movePreviewListItem\([\s\S]*?event\.key !== 'Tab'/, 'preview lists should handle Tab indentation');
assert.match(appSource, /function movePreviewListItem\([\s\S]*?event\.shiftKey/, 'preview lists should handle Shift+Tab outdent');
assert.match(appSource, /if \(movePreviewListItem\(event\)\) return;/, 'preview keydown should route Tab before native editing');
assert.match(appSource, /function previewListItemRange\([\s\S]*?A caret placed on the list-item wrapper/, 'task caret boundaries should be normalized before Enter/Tab');

function assertFormat(source, start, end, action, expected, expectedStart, expectedEnd) {
  const result = computeFormat(source, start, end, action);
  assert.equal(result.text, expected, `${action} should produce the expected Markdown`);
  assert.equal(result.selStart, expectedStart, `${action} should preserve the expected selection start`);
  assert.equal(result.selEnd, expectedEnd, `${action} should preserve the expected selection end`);
}

assertFormat('格式测试', 0, 4, 'bold', '**格式测试**', 2, 6);
assertFormat('**格式测试**', 2, 6, 'bold', '格式测试', 0, 4);
assertFormat('格式测试', 0, 4, 'italic', '*格式测试*', 1, 5);
assertFormat('*格式测试*', 1, 5, 'italic', '格式测试', 0, 4);
assertFormat('**格式测试**', 2, 6, 'italic', '***格式测试***', 3, 7);
assertFormat('***格式测试***', 3, 7, 'italic', '**格式测试**', 2, 6);
assertFormat('~~格式测试~~', 2, 6, 'strike', '格式测试', 0, 4);
assertFormat('`格式测试`', 1, 5, 'inlinecode', '格式测试', 0, 4);
assertFormat('```\n格式测试\n```', 4, 8, 'codeblock', '格式测试', 0, 4);

const image = '![图](assets/test.png)';

const afterLineStart = appSource.indexOf('function markdownEmptyLineAfter(');
const afterLineEnd = appSource.indexOf('\n  function previewImageMarkdownLine', afterLineStart);
assert.notEqual(afterLineStart, -1, 'image-following Markdown line helper should exist');
assert.notEqual(afterLineEnd, -1, 'image-following Markdown line helper should have a stable boundary');
const markdownEmptyLineAfter = vm.runInNewContext(`(${appSource.slice(afterLineStart, afterLineEnd)})`);
assert.deepEqual(
  JSON.parse(JSON.stringify(markdownEmptyLineAfter(image, image.length))),
  { markdown: `${image}\n\n`, start: image.length + 2, end: image.length + 2 },
  'a terminal preview image should gain a real following Markdown line'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(markdownEmptyLineAfter(`${image}\n下一行`, image.length))),
  { markdown: `${image}\n\n\n\n下一行`, start: image.length + 2, end: image.length + 2 },
  'an image caret placeholder before text should map to a distinct Markdown line'
);

for (const [action, broken] of [
  ['ol', `1. ${image}`],
  ['ul', `- ${image}`],
  ['task', `- [ ] ${image}`],
  ['quote', `> ${image}`],
  ['heading', `## ${image}`]
]) {
  const result = computeBlockFormat(broken, 0, broken.length, action, action === 'heading' ? 2 : undefined);
  assert.equal(result.text, image, `${action} should remove a legacy structural prefix from an atomic image row`);
}

const orderedAroundImage = `上一项\n\n${image}\n\n下一项`;
const orderedAroundImageResult = computeBlockFormat(orderedAroundImage, 0, orderedAroundImage.length, 'ol');
assert.equal(
  orderedAroundImageResult.text,
  `1. 上一项\n\n${image}\n\n2. 下一项`,
  'formatting across an image should format text lines while preserving the image and its paragraph boundaries'
);

function imageCaretCase(source, expected, blocks = [image]) {
  const caretMarker = source.includes('¦') ? '¦' : '|';
  const start = source.indexOf(caretMarker);
  const expectedCaret = expected.indexOf(caretMarker);
  assert.notEqual(start, -1, `missing image insertion caret in ${source}`);
  assert.notEqual(expectedCaret, -1, `missing expected image caret in ${expected}`);
  const text = source.slice(0, start) + source.slice(start + 1);
  const expectedText = expected.slice(0, expectedCaret) + expected.slice(expectedCaret + 1);
  const initialImageCount = (text.match(/!\[[^\]]*\]\([^\n)]+\)/g) || []).length;
  const result = insertImageBlocks(text, start, start, blocks);
  assert.equal(result.text, expectedText, source);
  assert.equal(result.caret, expectedCaret, `${source} should place the caret at a stable block boundary`);
  assert.equal(result.insertedImageCount, blocks.length, `${source} should expose the inserted image count for preview caret placement`);
  assert.equal((result.text.match(/!\[[^\]]*\]\([^\n)]+\)/g) || []).length, initialImageCount + blocks.length, `${source} should keep every image token intact`);
}

const imageBoundaryCases = [
  ['- [ ] 第一项\n- [ ] |', '- [ ] 第一项\n\n![图](assets/test.png)|'],
  ['- [x] |', '![图](assets/test.png)|'],
  ['- [ ] |第一项', '![图](assets/test.png)\n\n|- [ ] 第一项'],
  ['- [ ] 第|一项', '- [ ] 第一项\n\n![图](assets/test.png)|'],
  ['- [ ] 第一项|', '- [ ] 第一项\n\n![图](assets/test.png)|'],
  ['- |项目', '![图](assets/test.png)\n\n|- 项目'],
  ['* 项|目', '* 项目\n\n![图](assets/test.png)|'],
  ['+ 项目|', '+ 项目\n\n![图](assets/test.png)|'],
  ['1. |步骤', '![图](assets/test.png)\n\n|1. 步骤'],
  ['7) 步|骤', '7) 步骤\n\n![图](assets/test.png)|'],
  ['> |引用', '![图](assets/test.png)\n\n|> 引用'],
  ['> 引|用', '> 引用\n\n![图](assets/test.png)|'],
  ['## |标题', '![图](assets/test.png)\n\n|## 标题'],
  ['## 标|题', '## 标题\n\n![图](assets/test.png)|'],
  ['**加|粗**', '**加粗**\n\n![图](assets/test.png)|'],
  ['*斜|体*', '*斜体*\n\n![图](assets/test.png)|'],
  ['~~删|除~~', '~~删除~~\n\n![图](assets/test.png)|'],
  ['`代|码`', '`代码`\n\n![图](assets/test.png)|'],
  ['[链|接](https://example.com)', '[链接](https://example.com)\n\n![图](assets/test.png)|'],
  ['---|', '---\n\n![图](assets/test.png)|'],
  ['| 列一 | 列二 |\n| --- | --- |\n| 内¦容 | 值 |', '| 列一 | 列二 |\n| --- | --- |\n| 内容 | 值 |\n\n![图](assets/test.png)¦'],
  ['```js\nconst a| = 1;\n```', '```js\nconst a = 1;\n```\n\n![图](assets/test.png)|'],
  ['![旧图](assets/old.png)|', '![旧图](assets/old.png)\n\n![图](assets/test.png)|']
];

for (const [source, expected] of imageBoundaryCases) imageCaretCase(source, expected);

imageCaretCase('正文|', '正文\n\n![1](x) ![2](x) ![3](x) ![4](x) ![5](x) ![6](x)|',
  Array.from({ length: 6 }, (_, index) => `![${index + 1}](x)`));
imageCaretCase('正文|', '正文\n\n![1](x) ![2](x) ![3](x) ![4](x) ![5](x) ![6](x)\n\n![7](x)|',
  Array.from({ length: 7 }, (_, index) => `![${index + 1}](x)`));

const selectedTask = '- [ ] 待替换';
const selectedTaskResult = insertImageBlocks(selectedTask, 0, selectedTask.length, [image]);
assert.equal(selectedTaskResult.text, image, 'selecting a complete task item should not leave an orphan task marker');
assert.equal(selectedTaskResult.imageStartIndex, 0, 'a replacement image should be the first preview image');

const partialTask = '- [ ] 第一项';
const partialStart = partialTask.indexOf('一');
const partialResult = insertImageBlocks(partialTask, partialStart, partialStart + 1, [image]);
assert.equal(partialResult.text, '- [ ] 第项\n\n' + image, 'a partial task selection should preserve the surrounding task structure');

const selectedBold = '**加粗**';
const selectedBoldResult = insertImageBlocks(selectedBold, 2, 4, [image]);
assert.equal(selectedBoldResult.text, image, 'replacing all formatted text should not leave empty Markdown delimiters');
const partialBoldResult = insertImageBlocks(selectedBold, 2, 3, [image]);
assert.equal(partialBoldResult.text, '**粗**\n\n' + image, 'a partial formatted selection should keep its paired delimiters intact');

const imageAfterExisting = insertImageBlocks('![旧图](old.png)', '![旧图](old.png)'.length, '![旧图](old.png)'.length, [image]);
assert.equal(imageAfterExisting.imageStartIndex, 1, 'preview caret placement should target the image after existing images');

let sequence = '待办一\n步骤二\n说明三\n收尾四';
let sequenceResult = computeBlockFormat(sequence, sequence.indexOf('待办一'), sequence.indexOf('待办一') + 3, 'task');
sequence = sequenceResult.text;
const firstTaskEnd = sequence.indexOf('\n');
sequence = insertImageBlocks(sequence, firstTaskEnd, firstTaskEnd, [image]).text;
sequenceResult = computeBlockFormat(sequence, sequence.indexOf('步骤二'), sequence.indexOf('步骤二') + 3, 'ol');
sequence = sequenceResult.text;
sequenceResult = computeBlockFormat(sequence, sequence.indexOf('说明三'), sequence.indexOf('说明三') + 3, 'quote');
sequence = sequenceResult.text;
sequenceResult = computeBlockFormat(sequence, sequence.indexOf('收尾四'), sequence.indexOf('收尾四') + 3, 'task');
sequence = sequenceResult.text;
assert.match(sequence, /^- \[ \] 待办一\n\n!\[图\]\(assets\/test\.png\)/, 'task then image should retain the first task item');
assert.match(sequence, /^1\. 步骤二$/m, 'image insertion should not destabilize later ordered-list formatting');
assert.match(sequence, /^> 说明三$/m, 'ordered list then quote should retain both structures');
assert.match(sequence, /^- \[ \] 收尾四$/m, 'quote then task should retain the final task structure');
assert.doesNotMatch(sequence, /^\s*[-*+]\s+\[[ xX]\]\s*$/m, 'mixed operations should not create orphan task markers');

console.log(`editing matrix passed: ${cases.length + 19 + imageBoundaryCases.length + 15} scenarios`);
