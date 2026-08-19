import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
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
assert.equal(
  normalizePreviewStructuralMarkdown('    code\n\n正文'),
  '    code\n\n正文',
  'leading indented code must not be mistaken for an empty paragraph'
);

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

console.log(`editing tests passed: ${cases.length + 19}`);
