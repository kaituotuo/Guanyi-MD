import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing boundary ${endMarker}`);
  return appSource.slice(start, end);
}

const imageHelpers = vm.runInNewContext(`(() => {
  function imageInsertionLines() { return []; }
  function imageFenceBlocks() { return []; }
  ${sourceBetween('function markdownImageAlt(', '\n  function normalizedHttpImageUrl')}
  return { markdownImageSyntax, markdownImageTokens };
})()`);

const snapshotHelpers = vm.runInNewContext(`(() => {
  const INTERNAL_MARKDOWN_CLIPBOARD_TTL = 30 * 60 * 1000;
  ${sourceBetween('function createInternalMarkdownClipboardSnapshot(', '\n  function markdownClipboardTokenFromTransfer')}
  return { createInternalMarkdownClipboardSnapshot, validInternalMarkdownClipboard };
})()`);

const encodedImages = ['甲', '乙', '丙', '牛马'].map((alt, index) =>
  `![${alt}](data:image/png;base64,${String(index).repeat(175000)})`
);
const largeMarkdown = `# 六猫第五弹\n\n${encodedImages.join('\n\n')}\n\n后续正文`;
assert.ok(largeMarkdown.length > 700000, 'fixture should cover the reported large rich-text clipboard case');
const snapshot = snapshotHelpers.createInternalMarkdownClipboardSnapshot(largeMarkdown, {
  token: 'fixed-token', createdAt: 1000, sourceDocId: 'source-doc'
});
assert.equal(snapshot.markdown, largeMarkdown, 'the internal snapshot must retain the canonical Markdown byte-for-byte');
const copiedImages = imageHelpers.markdownImageTokens(snapshot.markdown);
assert.equal(copiedImages.length, 4, 'all four image tokens must survive the internal clipboard path');
assert.equal(copiedImages[3].alt, '牛马', 'the reported fourth image must remain an image instead of degrading to alt text');
assert.ok(copiedImages[3].source.length > 175000, 'the fourth image encoding must not be truncated');
assert.equal(snapshotHelpers.validInternalMarkdownClipboard(snapshot, 'fixed-token', 1000 + 100), true);
assert.equal(snapshotHelpers.validInternalMarkdownClipboard(snapshot, 'wrong-token', 1000 + 100), false);
assert.equal(snapshotHelpers.validInternalMarkdownClipboard(snapshot, 'fixed-token', 1000 + 30 * 60 * 1000 + 1), false,
  'expired in-memory clipboard tokens must not recover stale document content');

const tokenHelper = vm.runInNewContext(`(() => {
  const INTERNAL_MARKDOWN_CLIPBOARD_TYPE = 'application/x-guanyi-markdown';
  ${sourceBetween('function markdownClipboardTokenFromTransfer(', '\n  function internalMarkdownClipboardForTransfer')}
  return { markdownClipboardTokenFromTransfer };
})()`);
assert.equal(tokenHelper.markdownClipboardTokenFromTransfer({
  getData: (type) => type === 'application/x-guanyi-markdown' ? 'custom-token' : ''
}), 'custom-token', 'the custom MIME token should be preferred');
assert.equal(tokenHelper.markdownClipboardTokenFromTransfer({
  getData: (type) => type === 'text/html' ? '<div data-guanyi-clipboard-token="html-token">内容</div>' : ''
}), 'html-token', 'the HTML token should recover internal content when the OS drops custom MIME data');

const replacementHelper = vm.runInNewContext(`(() => {
  ${sourceBetween('function replaceMarkdownImageSources(', '\n  function clipboardImageFile')}
  return { replaceMarkdownImageSources };
})()`, {
  markdownImageTokens: imageHelpers.markdownImageTokens,
  markdownImageSyntax: imageHelpers.markdownImageSyntax
});
const relativeMarkdown = '![甲](assets/source/a.png) ![复用](assets/source/a.png)\n\n![乙](https://example.com/b.png)';
const replaced = replacementHelper.replaceMarkdownImageSources(relativeMarkdown, new Map([
  ['assets/source/a.png', 'assets/target/a-2.png']
]));
assert.equal(replaced,
  '![甲](assets/target/a-2.png) ![复用](assets/target/a-2.png)\n\n![乙](https://example.com/b.png)',
  'relative image references should be rewritten together while remote images remain unchanged');

assert.match(appSource, /sourceEditor\.addEventListener\('copy',[\s\S]+handleMarkdownCopy\(event, 'source'\)/,
  'source view must write the internal Markdown clipboard');
assert.match(appSource, /previewEditor\.addEventListener\('copy',[\s\S]+handleMarkdownCopy\(event, 'preview'\)/,
  'preview view must write the internal Markdown clipboard');
assert.match(appSource, /sourceEditor\.addEventListener\('paste',[\s\S]+if \(handleInternalMarkdownPaste\(event, 'source'\)\) return;[\s\S]+imageFilesFromTransfer/,
  'source paste must recover internal Markdown before the ordinary image-file path');
assert.match(appSource, /previewEditor\.addEventListener\('paste',[\s\S]+if \(handleInternalMarkdownPaste\(event, 'preview'\)\) return;[\s\S]+imageFilesFromTransfer/,
  'preview paste must recover internal Markdown before the ordinary image-file path');
assert.match(appSource, /function clipboardHtmlForSelection\([\s\S]+data-md-image-source[\s\S]+removeAttribute\('data-md-image-source'\)/,
  'clipboard HTML must carry each image payload once instead of duplicating it in src and data attributes');
assert.match(appSource, /function materializeMarkdownClipboardImages\([\s\S]+localImageFileForDoc\(sourceDoc, source\)[\s\S]+storeDirectoryImage\(file, targetDoc\)/,
  'relative assets must be read from the source document and written beside the target document');
assert.match(appSource, /function materializeMarkdownClipboardImages\([\s\S]+Promise\.allSettled\(cleanups\.map\(\(cleanup\) => cleanup\(\)\)\)/,
  'partially copied assets must roll back when any resource copy fails');
assert.match(appSource, /if \(!snapshot \|\| !targetDoc \|\| isPlainTextDocument\(targetDoc\)\) return null;/,
  'TXT targets must retain their normal plain-text paste behavior');

process.stdout.write('markdown clipboard passed: large four-image copy, token fallback, asset rewrite and rollback contracts verified\n');
