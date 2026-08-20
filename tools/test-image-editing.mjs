import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const syntaxStart = appSource.indexOf('function markdownImageAlt(');
const syntaxEnd = appSource.indexOf('\n  function normalizedHttpImageUrl', syntaxStart);
assert.notEqual(syntaxStart, -1, 'image markdown helpers should exist');
assert.notEqual(syntaxEnd, -1, 'image markdown helpers should end before URL validation');
const helpers = vm.runInNewContext(`(() => {
  function imageInsertionLines() { return []; }
  function imageFenceBlocks() { return []; }
  ${appSource.slice(syntaxStart, syntaxEnd)}
  return { markdownImageTokens, updateMarkdownImage };
})()`);

const images = helpers.markdownImageTokens('![甲](assets/a.png) ![乙](assets/b.png "标题")');
assert.equal(images.length, 2, 'two adjacent images should remain independently editable');
assert.deepEqual(
  JSON.parse(JSON.stringify(images.map(({ alt, source, title }) => ({ alt, source, title })))),
  [
    { alt: '甲', source: 'assets/a.png', title: '' },
    { alt: '乙', source: 'assets/b.png', title: '标题' }
  ]
);
assert.equal(
  helpers.updateMarkdownImage('![甲](assets/a.png)', 0, { alt: '新的描述' }),
  '![新的描述](assets/a.png)',
  'description editing should preserve the image source'
);
assert.equal(
  helpers.updateMarkdownImage('![甲](assets/a.png "标题")', 0, { source: 'assets/a-crop.png' }),
  '![甲](assets/a-crop.png "标题")',
  'crop replacement should preserve alt text and title'
);

const metadataStart = appSource.indexOf('function parseImageRowMetadata(');
const metadataEnd = appSource.indexOf('\n  function imageMetadataCommentBefore', metadataStart);
const metadataHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(metadataStart, metadataEnd)}
  return { parseImageRowMetadata, imageRowMetadataComment };
})()`);
assert.deepEqual(
  JSON.parse(JSON.stringify(metadataHelpers.parseImageRowMetadata('guanyi:image width=75 align=right'))),
  { width: 75, align: 'right' }
);
assert.equal(metadataHelpers.imageRowMetadataComment({ width: 60, align: 'left' }), '<!-- guanyi:image width=60 align=left -->');
assert.equal(metadataHelpers.imageRowMetadataComment({ width: 'auto', align: 'center' }), '', 'default presentation should not add metadata noise');

const insertionStart = appSource.indexOf('function imageInsertionLines(');
const insertionEnd = appSource.indexOf('\n  function placePreviewCaretAfterInsertedImages', insertionStart);
assert.notEqual(insertionStart, -1, 'image insertion helpers should exist');
assert.notEqual(insertionEnd, -1, 'image insertion helpers should end before caret placement');
const insertionHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(insertionStart, insertionEnd)}
  return { insertImageBlocks };
})()`);
const imageBlock = '![图](assets/image.png)';
assert.equal(
  insertionHelpers.insertImageBlocks('上一行', 3, 3, [imageBlock]).text,
  `上一行\n\n${imageBlock}`,
  'an image inserted after a text line should remain after that line'
);
assert.equal(
  insertionHelpers.insertImageBlocks('上一行\n\n下一行', 4, 4, [imageBlock]).text,
  `上一行\n\n${imageBlock}\n\n下一行`,
  'an image inserted on a blank line should not jump before the preceding text'
);

const storageStart = appSource.indexOf('function canStoreImageBesideDocument(');
const storageEnd = appSource.indexOf('\n  async function imageAssetLocation', storageStart);
assert.notEqual(storageStart, -1, 'image storage routing helper should exist');
const storageHelpers = vm.runInNewContext(`(() => {
  function isDirectoryDoc(doc) { return doc?.sourceKind === 'directory-file'; }
  function isLocalFileDoc(doc) { return doc?.sourceKind === 'local-file'; }
  ${appSource.slice(storageStart, storageEnd)}
  return { canStoreImageBesideDocument };
})()`);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'directory-file' }), true);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', fileHandle: {} }), true);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', fileHandle: null, openedWithoutHandle: true }), false);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'browser' }), false);

const anchorStart = appSource.indexOf('function imageInsertionSelectionAfterPreviewBlock(');
const anchorEnd = appSource.indexOf('\n  function applyFormatToPreview', anchorStart);
const anchorHelpers = vm.runInNewContext(`(() => {
  function normalizeCommentText(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); }
  function markdownLineInfos(markdown) {
    let offset = 0;
    return String(markdown).split('\\n').map((raw, index, lines) => {
      const info = { raw, start: offset, end: offset + raw.length };
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
      return info;
    });
  }
  function markdownToPlain(markdown) { return String(markdown).replace(/^[-*+]\\s+/, '').trim(); }
  ${appSource.slice(anchorStart, anchorEnd)}
  return { imageInsertionSelectionAfterPreviewBlock };
})()`);
assert.deepEqual(
  JSON.parse(JSON.stringify(anchorHelpers.imageInsertionSelectionAfterPreviewBlock(
    { previousElementSibling: { textContent: '上一行' } },
    '上一行\n\n下一行'
  ))),
  { markdown: '上一行\n\n下一行', start: 3, end: 3 },
  'a blank preview block should resolve to the end of the preceding Markdown line'
);

assert.match(indexSource, /id="image-edit-popover"[^>]+role="dialog"/, 'selected images should expose an edit popover');
assert.match(indexSource, /id="image-size-range"[^>]+min="25"[^>]+max="100"/, 'image rows should support bounded resizing');
assert.match(indexSource, /data-image-align="left"[\s\S]+data-image-align="center"[\s\S]+data-image-align="right"/, 'all alignment choices should exist');
assert.match(indexSource, /id="image-description-input"/, 'image description editing should exist');
assert.match(indexSource, /id="btn-image-download"/, 'image download should exist');
assert.match(indexSource, /id="image-crop-canvas"/, 'image crop canvas should exist');
assert.match(cssSource, /img\.is-image-selected[\s\S]+outline: 2px solid/, 'selected images should have visible feedback');
assert.match(cssSource, /\.app-image-row\[data-image-width\]/, 'persisted image width should affect preview layout');
assert.match(cssSource, /\.app-image-row > img \{[\s\S]+object-fit: contain;/, 'equal-height image rows should show the complete image');
assert.match(appSource, /function captureImageInsertion\([\s\S]+flushPendingPreviewCommit\(\);[\s\S]+previewMarkdownSelection/, 'pending preview line breaks should be committed before locating an image');
assert.match(appSource, /function imageInsertionSelectionAfterPreviewBlock\([\s\S]+previousElementSibling[\s\S]+markdownToPlain/, 'empty preview blocks should anchor insertion after the preceding text block');
assert.match(appSource, /function canStoreImageBesideDocument\([\s\S]+isLocalFileDoc\(doc\)[\s\S]+doc\.fileHandle/, 'saved local files should store images beside the document');
assert.match(appSource, /function imageAssetLocation\([\s\S]+selectParentDirectory\(doc\)/, 'local file assets should request and retain parent-directory access');
assert.match(appSource, /function scheduleImageSizeCommit\([\s\S]+setTimeout\([\s\S]+180\)/, 'slider input should persist even when change is interrupted');
assert.match(appSource, /const metadata = imageRowMetadataFor\(paragraph\);[\s\S]+applyImageRowPresentation\(row, metadata\);/, 'overflow image rows should inherit presentation metadata');
assert.match(appSource, /event\.key !== 'Escape' \|\| els\.imageCropModal\?\.hidden[\s\S]+closeImageCrop\(\);/, 'Escape should close the crop modal');

console.log('image editing tests passed: selection UI, metadata, resize, alignment, descriptions, download and crop contracts verified');
