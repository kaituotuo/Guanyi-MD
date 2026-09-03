import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');

const helperStart = appSource.indexOf('function documentSourceName(');
const helperEnd = appSource.indexOf('\n  function isLocalFileDoc', helperStart);
assert.notEqual(helperStart, -1, 'TXT document helpers should exist');
assert.notEqual(helperEnd, -1, 'TXT document helper boundary should exist');
const helpers = vm.runInNewContext(`(() => { ${appSource.slice(helperStart, helperEnd)}; return { isPlainTextDocument, plainTextPreviewValue }; })()`);

const readingHelpersStart = appSource.indexOf('function plainTextReadingLineKind(');
const readingHelpersEnd = appSource.indexOf('\n  function plainTextPreviewValue', readingHelpersStart);
const headingHelperStart = appSource.indexOf('function plainTextHeadingInfo(');
const headingHelperEnd = appSource.indexOf('\n  function numberedPlainTextLine', headingHelperStart);
assert.notEqual(readingHelpersStart, -1, 'TXT reading layout helpers should exist');
assert.notEqual(readingHelpersEnd, -1, 'TXT reading layout helpers should have a stable boundary');
assert.notEqual(headingHelperStart, -1, 'TXT heading helper should exist');
assert.notEqual(headingHelperEnd, -1, 'TXT heading helper should have a stable boundary');
const readingHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(headingHelperStart, headingHelperEnd)}
  ${appSource.slice(readingHelpersStart, readingHelpersEnd)}
  return { plainTextReadingLineKind, plainTextReadingIndent, plainTextReadingLines };
})()`);

for (const doc of [
  { localFileName: '小说.txt' },
  { relativePath: '文学名著/小说.TXT' },
  { desktopPath: '/tmp/小说.txt' },
  { name: '小说.txt' }
]) {
  assert.equal(helpers.isPlainTextDocument(doc), true, `${JSON.stringify(doc)} should use TXT rules`);
}
for (const doc of [
  { localFileName: '小说.md' },
  { relativePath: '文学名著/小说.markdown' },
  { name: '未命名文档' },
  null
]) {
  assert.equal(helpers.isPlainTextDocument(doc), false, `${JSON.stringify(doc)} should use Markdown rules`);
}

const fixture = '目录\n\n第一部……1\n第二部……7\n\n纪年对照表\n危机纪元\n威慑纪元';
assert.equal(helpers.plainTextPreviewValue({ innerText: fixture }), fixture, 'single and blank lines should round-trip');
assert.equal(helpers.plainTextPreviewValue({ innerText: '甲\r\n乙\r丙' }), '甲\n乙\n丙', 'preview writeback should normalize platform newlines');
assert.equal(helpers.plainTextPreviewValue({ textContent: fixture }), fixture, 'textContent fallback should preserve TXT lines');
assert.equal(readingHelpers.plainTextReadingLineKind('却说孙策看了半晌，方始回马。'), 'paragraph', 'literary prose should receive reading indentation');
assert.equal(readingHelpers.plainTextReadingLineKind('第十九回 下邳城曹操鏖兵'), 'structure', 'chapter headings should not receive reading indentation');
assert.equal(readingHelpers.plainTextReadingLineKind('1. 第一项'), 'structure', 'plain-text list lines should not receive reading indentation');
assert.equal(readingHelpers.plainTextReadingIndent('正文'), 2, 'unindented prose should receive exactly two em');
assert.equal(readingHelpers.plainTextReadingIndent('\u3000正文'), 1, 'existing full-width indentation should count toward the two-em visual indent');
assert.equal(readingHelpers.plainTextReadingIndent('\u3000\u3000正文'), 0, 'existing two-character indentation should not be doubled');
assert.deepEqual(
  JSON.parse(JSON.stringify(readingHelpers.plainTextReadingLines('第一段\n\n第二段'))),
  [
    { text: '第一段', kind: 'paragraph', indent: 2, collapsedBlank: false },
    { text: '', kind: 'blank', indent: 2, collapsedBlank: false },
    { text: '第二段', kind: 'paragraph', indent: 2, collapsedBlank: false }
  ],
  'every TXT source line should remain an independent reading paragraph without losing blank lines'
);
const repeatedBlankLines = JSON.parse(JSON.stringify(readingHelpers.plainTextReadingLines('第一段\n\n\n\n第二段')));
assert.deepEqual(
  repeatedBlankLines.map((line) => line.collapsedBlank),
  [false, false, true, true, false],
  'only the first line in a consecutive TXT blank-line run should remain visually expanded'
);
assert.equal(repeatedBlankLines.map((line) => line.text).join('\n'), '第一段\n\n\n\n第二段', 'collapsing TXT paragraph gaps must not normalize source newlines');

assert.match(appSource, /marked\.setOptions\(\{ gfm: true, breaks: false \}\)/, 'Markdown soft-break behavior must remain unchanged');
assert.match(appSource, /function updatePreviewEditableState[\s\S]*?isPlainTextDocument\(doc\) \? 'plaintext-only' : 'true'[\s\S]*?setAttribute\('contenteditable', value\)/, 'TXT preview should use plain-text editing in every view transition');
assert.match(appSource, /function setViewMode[\s\S]*?updatePreviewEditableState\(mode\)/, 'view switching should preserve TXT plain-text editing');
assert.match(appSource, /if \(plainText\) \{[\s\S]*?renderPlainTextPreview\(els\.previewEditor, md\);[\s\S]*?\} else \{[\s\S]*?marked\.parse/, 'TXT must use the line-preserving reading renderer and bypass Markdown rendering');
assert.match(appSource, /sourceProjection = isPlainTextDocument\(currentDoc\(\)\)[\s\S]*?\{ markdown: md, display: md, segments: \[\] \}/, 'TXT source should not collapse Markdown-like image text');
assert.match(appSource, /if \(plainText\) \{[\s\S]*?md = plainTextPreviewValue\(els\.previewEditor\)/, 'TXT preview edits should write back as plain text');
assert.match(appSource, /const markdownControls = els\.fmtbar\?\.querySelectorAll\('\[data-fmt\], #btn-heading, #btn-table, #btn-image'\)/, 'Markdown-only controls should be disabled for TXT');
assert.match(appSource, /plainText \? '\.txt' : '\.md'/, 'raw TXT export should retain the TXT extension');
assert.match(cssSource, /\.editor-preview\.is-plain-text \.app-plain-text-line\s*\{[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;/, 'TXT preview lines should preserve file whitespace and soft-wrap long lines');
assert.match(cssSource, /\.editor-preview\.is-plain-text \.app-plain-text-line\.is-paragraph\s*\{[\s\S]*?text-indent:\s*var\(--plain-text-reading-indent,\s*2em\);/, 'TXT literary paragraphs should use a two-character first-line indent');
assert.match(cssSource, /\.app-plain-text-line\.is-structure\s*\{[\s\S]*?text-indent:\s*0;/, 'TXT headings and list-like lines should remain unindented');
assert.match(cssSource, /\.editor-preview\.is-plain-text \.app-plain-text-line\.is-collapsed-blank\s*\{[\s\S]*?display:\s*none;/, 'only repeated TXT blank rows should collapse in the reading preview');

console.log('TXT preview tests passed: type detection, two-em literary paragraphs, collapsed visual gaps, original line breaks, soft wrapping, plain-text writeback and raw export verified');
