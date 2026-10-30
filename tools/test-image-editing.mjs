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

const projectionStart = appSource.indexOf('function sourceImageEncodingSize(');
const projectionEnd = appSource.indexOf('\n  function currentSourceMarkdownSelection', projectionStart);
assert.notEqual(projectionStart, -1, 'source image projection helpers should exist');
assert.notEqual(projectionEnd, -1, 'source image projection helpers should have a stable boundary');
const projectionHelpers = vm.runInNewContext(`(() => {
  let sourceProjection = { markdown: '', display: '', segments: [] };
  ${appSource.slice(projectionStart, projectionEnd)}
  return { sourceProjectionForMarkdown, sourceDisplayPosition, sourceProjectionSegmentForEdit, expandSourceProjection };
})()`);
const encodedPayload = 'A'.repeat(1565000);
const encodedMarkdown = `# 图片\n\n![收到](data:image/gif;base64,${encodedPayload})\n\n后续正文`;
const projectedSource = projectionHelpers.sourceProjectionForMarkdown(encodedMarkdown);
assert.equal(projectedSource.segments.length, 1, 'one data URI should produce one compact source segment');
assert.equal(projectedSource.display.split('\n').length, encodedMarkdown.split('\n').length, 'compaction should preserve logical source lines');
assert.ok(projectedSource.display.includes('图片编码'), 'source view should identify the compacted image encoding');
assert.ok(projectedSource.display.includes('GIF'), 'source placeholder should identify the image format');
assert.ok(!projectedSource.display.includes(encodedPayload), 'source view should not expose the full base64 payload');
assert.ok(projectedSource.display.length < 160, 'a long data URI should remain a short editable source line');
const projectedCaret = projectedSource.display.indexOf('\n\n后续正文') + 2;
const expandedSource = projectionHelpers.expandSourceProjection(
  projectedSource.display,
  projectedCaret,
  projectedCaret,
  projectedSource
);
assert.equal(expandedSource.markdown, encodedMarkdown, 'editing the compact source view should restore the original data URI');
assert.equal(expandedSource.selectionStart, encodedMarkdown.indexOf('后续正文'), 'display caret positions should map back to canonical Markdown');
assert.equal(
  projectionHelpers.sourceDisplayPosition(encodedMarkdown.indexOf('后续正文'), 'before', projectedSource),
  projectedSource.display.indexOf('后续正文'),
  'canonical search positions should map into the compact source view'
);
const compactSegment = projectedSource.segments[0];
assert.equal(
  projectionHelpers.sourceProjectionSegmentForEdit(compactSegment.displayStart + 2, compactSegment.displayStart + 2, 'insertText', projectedSource)?.placeholder,
  compactSegment.placeholder,
  'typing inside a compact image placeholder should target the entire atomic segment'
);
assert.equal(
  projectionHelpers.sourceProjectionSegmentForEdit(compactSegment.displayStart, compactSegment.displayEnd, 'insertText', projectedSource),
  null,
  'an explicitly selected complete placeholder may be replaced with a new image address'
);
assert.equal(
  projectionHelpers.sourceProjectionSegmentForEdit(compactSegment.displayStart, compactSegment.displayEnd, 'deleteContentBackward', projectedSource)?.placeholder,
  compactSegment.placeholder,
  'deleting a selected placeholder should remove the complete image token'
);
assert.equal(
  projectionHelpers.sourceProjectionSegmentForEdit(0, projectedSource.display.length, 'insertText', projectedSource),
  null,
  'select-all replacement should remain available when the selection fully contains compact images'
);

const metadataStart = appSource.indexOf('function parseImageRowMetadata(');
const metadataEnd = appSource.indexOf('\n  function imageMetadataCommentBefore', metadataStart);
const metadataHelpers = vm.runInNewContext(`(() => {
  const IMAGE_MIN_WIDTH_PERCENT = 25;
  const IMAGE_MAX_WIDTH_PERCENT = 100;
  ${appSource.slice(metadataStart, metadataEnd)}
  return { parseImageRowMetadata, imageRowMetadataComment };
})()`);
assert.deepEqual(
  JSON.parse(JSON.stringify(metadataHelpers.parseImageRowMetadata('guanyi:image width=75 align=right'))),
  { width: 75, align: 'right' }
);
assert.equal(metadataHelpers.imageRowMetadataComment({ width: 60, align: 'left' }), '<!-- guanyi:image width=60 align=left -->');
assert.equal(metadataHelpers.imageRowMetadataComment({ width: 60, align: null }), '<!-- guanyi:image width=60 -->', 'resizing should not invent an alignment');
assert.equal(metadataHelpers.imageRowMetadataComment({ width: 'auto', align: 'center' }), '<!-- guanyi:image align=center -->', 'an explicit centered alignment should survive rerendering');

const aspectStart = appSource.indexOf('function imageNaturalAspect(');
const aspectEnd = appSource.indexOf('\n  function syncImageCellAspect', aspectStart);
assert.notEqual(aspectStart, -1, 'natural image aspect helper should exist');
assert.notEqual(aspectEnd, -1, 'natural image aspect helper should have a stable boundary');
const aspectHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(aspectStart, aspectEnd)}
  return { imageNaturalAspect };
})()`);
assert.equal(aspectHelpers.imageNaturalAspect({ naturalWidth: 1600, naturalHeight: 900 }), 1.777778, 'landscape images should retain their natural ratio');
assert.equal(aspectHelpers.imageNaturalAspect({ naturalWidth: 600, naturalHeight: 900 }), 0.666667, 'portrait images should retain their natural ratio');
assert.equal(aspectHelpers.imageNaturalAspect({ naturalWidth: 0, naturalHeight: 0, getAttribute: (name) => name === 'width' ? '1200' : '800' }), 1.5, 'declared dimensions should provide a pre-load ratio');

const rowSettingsStart = appSource.indexOf('function selectedImageRowSettings(');
const rowSettingsEnd = appSource.indexOf('\n  function clampImageWidthPercent', rowSettingsStart);
assert.notEqual(rowSettingsStart, -1, 'image row settings helper should exist');
assert.notEqual(rowSettingsEnd, -1, 'image row settings helper should have a stable boundary');
const rowSettingsHelpers = vm.runInNewContext(`(() => {
  let activeRow = null;
  function selectedImageRow() { return activeRow; }
  ${appSource.slice(rowSettingsStart, rowSettingsEnd)}
  return {
    settings(dataset) { activeRow = { dataset }; return selectedImageRowSettings(); },
    effective(dataset) { return effectiveImageRowAlign({ dataset }); }
  };
})()`);
assert.deepEqual(
  JSON.parse(JSON.stringify(rowSettingsHelpers.settings({ imageWidth: '50' }))),
  { width: 50, align: null },
  'a resized row without explicit alignment should remain unaligned'
);
assert.equal(rowSettingsHelpers.effective({ imageWidth: '50' }), 'left', 'an unaligned row should keep its original left-side layout');
assert.deepEqual(
  JSON.parse(JSON.stringify(rowSettingsHelpers.settings({ imageWidth: '50', imageAlign: 'right' }))),
  { width: 50, align: 'right' },
  'resizing should preserve an explicit alignment'
);

const resizeStart = appSource.indexOf('function clampImageWidthPercent(');
const resizeEnd = appSource.indexOf('\n  function selectedImageResizeMetrics', resizeStart);
assert.notEqual(resizeStart, -1, 'direct image resize helpers should exist');
assert.notEqual(resizeEnd, -1, 'direct image resize helpers should have a stable boundary');
const resizeHelpers = vm.runInNewContext(`(() => {
  const IMAGE_MIN_WIDTH_PERCENT = 25;
  const IMAGE_MAX_WIDTH_PERCENT = 100;
  ${appSource.slice(resizeStart, resizeEnd)}
  return { imageResizePercentFromPointer };
})()`);
assert.equal(resizeHelpers.imageResizePercentFromPointer(75, 400, 300, 50, 0, 2), 94, 'centered images should track a horizontal corner drag');
assert.equal(resizeHelpers.imageResizePercentFromPointer(50, 400, 200, 0, 50, 1), 63, 'vertical corner movement should preserve proportional resizing');
assert.equal(resizeHelpers.imageResizePercentFromPointer(60, 400, 300, -1000, -1000, 1), 25, 'direct resize should enforce the minimum size');
assert.equal(resizeHelpers.imageResizePercentFromPointer(60, 400, 300, 1000, 1000, 1), 100, 'direct resize should enforce the maximum size');
assert.equal(resizeHelpers.imageResizePercentFromPointer(100, 1200, 240, -300, 0, 1), 75, 'a full-width multi-image row should shrink to 75%');
assert.equal(resizeHelpers.imageResizePercentFromPointer(100, 1200, 240, -600, 0, 1), 50, 'a full-width multi-image row should shrink to 50%');
assert.equal(resizeHelpers.imageResizePercentFromPointer(100, 1200, 240, -900, 0, 1), 25, 'a full-width multi-image row should shrink to its 25% minimum');
assert.equal(resizeHelpers.imageResizePercentFromPointer(100, 1200, 240, 300, 0, 1), 100, 'a full-width multi-image row should stay capped when dragged outward');

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
assert.equal(
  insertionHelpers.insertImageBlocks('上一行', 3, 3, [imageBlock], { ensureTrailingLine: true }).text,
  `上一行\n\n${imageBlock}\n\n`,
  'source image insertion at the document end should leave an editable trailing line'
);
assert.equal(
  insertionHelpers.insertImageBlocks('上一行', 3, 3, [imageBlock], { ensureTrailingLine: true }).caret,
  `上一行\n\n${imageBlock}\n\n`.length,
  'source image insertion should place the caret after the trailing editable line'
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
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', fileHandle: {}, directoryHandle: {} }), true);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', desktopPath: '/docs/新建.md' }), true,
  'a desktop Save As path should allow beside-document image storage immediately');
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', fileHandle: {} }), false);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'local-file', fileHandle: null, openedWithoutHandle: true }), false);
assert.equal(storageHelpers.canStoreImageBesideDocument({ sourceKind: 'browser' }), false);
const managedDraftContext = vm.runInNewContext(`(() => {
  const managedCalls = [];
  const saveCalls = [];
  const managedDraft = { name: '未命名文档', content: '本地草稿', sourceKind: 'browser' };
  let saveTimer = null;
  function isDirectoryDoc(doc) { return doc?.sourceKind === 'directory-file'; }
  function isLocalFileDoc(doc) { return doc?.sourceKind === 'local-file'; }
  function desktopFileApi() { return { createManaged: async (...args) => {
    managedCalls.push(args);
    return { path: '/profile/documents/未命名文档.md', name: '未命名文档.md', storageKind: 'managed' };
  } }; }
  function documentFileName(doc) { return doc.name + '.md'; }
  function getCurrentMarkdown() { return managedDraft.content; }
  function currentDoc() { return managedDraft; }
  function attachDesktopSavedFile(doc, saved) {
    doc.sourceKind = 'local-file'; doc.desktopPath = saved.path; doc.storageKind = saved.storageKind;
  }
  function markDocSaved(doc, content) { doc.lastSavedContent = content; }
  function saveState() {}
  function renderDocList() {}
  function updateEditChrome() {}
  function tip() {}
  async function saveCurrentDocument(options) { saveCalls.push(options); return false; }
  ${appSource.slice(storageStart, storageEnd)}
  return { managedDraft, managedCalls, saveCalls, ensureDesktopImageDocumentPath };
})()`, { clearTimeout });
assert.equal(await managedDraftContext.ensureDesktopImageDocumentPath(managedDraftContext.managedDraft), true,
  'a desktop draft should use the managed local directory before Save As');
assert.deepEqual(JSON.parse(JSON.stringify(managedDraftContext.managedCalls)), [['未命名文档.md', '本地草稿']]);
assert.equal(managedDraftContext.managedDraft.storageKind, 'managed');
assert.equal(managedDraftContext.saveCalls.length, 0, 'successful managed storage must not open Save As');

const managedFailureContext = vm.runInNewContext(`(() => {
  const fallbackOptions = [];
  const draft = { name: '故障草稿', content: '', sourceKind: 'browser' };
  let saveTimer = null;
  function isDirectoryDoc(doc) { return doc?.sourceKind === 'directory-file'; }
  function isLocalFileDoc(doc) { return doc?.sourceKind === 'local-file'; }
  function desktopFileApi() { return { createManaged: async () => { throw new Error('disk unavailable'); } }; }
  function documentFileName(doc) { return doc.name + '.md'; }
  function getCurrentMarkdown() { return draft.content; }
  function currentDoc() { return draft; }
  function attachDesktopSavedFile() {}
  function markDocSaved() {}
  function saveState() {}
  function renderDocList() {}
  function updateEditChrome() {}
  function tip() {}
  async function saveCurrentDocument(options) {
    fallbackOptions.push(options); draft.sourceKind = 'local-file'; draft.desktopPath = '/external/故障草稿.md'; return true;
  }
  ${appSource.slice(storageStart, storageEnd)}
  return { draft, fallbackOptions, ensureDesktopImageDocumentPath };
})()`, { clearTimeout, console: { warn() {} } });
assert.equal(await managedFailureContext.ensureDesktopImageDocumentPath(managedFailureContext.draft), true,
  'managed storage failure should retain the existing native Save As recovery');
assert.equal(managedFailureContext.fallbackOptions[0].forceDesktopSaveAs, true);

const nativeDraftContext = vm.runInNewContext(`(() => {
  const nativeMessages = [];
  const nativeSaveOptions = [];
  const nativeDraft = { sourceKind: 'browser' };
  function isDirectoryDoc(doc) { return doc?.sourceKind === 'directory-file'; }
  function isLocalFileDoc(doc) { return doc?.sourceKind === 'local-file'; }
  function desktopFileApi() { return {}; }
  function tip(message) { nativeMessages.push(message); }
  async function saveCurrentDocument(options) {
    nativeSaveOptions.push(options);
    nativeDraft.sourceKind = 'local-file';
    nativeDraft.desktopPath = '/docs/新建.md';
    return true;
  }
  function currentDoc() { return nativeDraft; }
  ${appSource.slice(storageStart, storageEnd)}
  return { nativeDraft, nativeMessages, nativeSaveOptions, ensureDesktopImageDocumentPath };
})()`);
assert.equal(await nativeDraftContext.ensureDesktopImageDocumentPath(nativeDraftContext.nativeDraft), true,
  'a desktop draft should become eligible for beside-document asset storage after native Save As');
assert.equal(nativeDraftContext.nativeSaveOptions[0].forceDesktopSaveAs, true);
assert.equal(nativeDraftContext.nativeSaveOptions[0].silentSuccess, true);
assert.match(nativeDraftContext.nativeMessages[0], /选择文档保存位置/);
assert.match(appSource, /function ensureDesktopImageDocumentPath[\s\S]+forceDesktopSaveAs: true[\s\S]+需要先确定文档保存位置/,
  'desktop drafts should obtain a native document path before image storage');
assert.match(appSource, /function ensureDesktopImageDocumentPath[\s\S]+desktopApi\.createManaged[\s\S]+saveCurrentDocument/,
  'desktop image storage should prefer the managed local directory and preserve Save As as a fallback');
assert.match(appSource, /async function insertImageFiles[\s\S]+ensureDesktopImageDocumentPath\(doc, '插入图片'\)[\s\S]+storeDirectoryImage/,
  'desktop image insertion should establish the document path before choosing the storage backend');
assert.match(appSource, /async function saveCurrentDocument\(options\)[\s\S]+!opts\.forceDesktopSaveAs && doc\.desktopPath[\s\S]+!opts\.forceDesktopSaveAs && doc\.fileHandle/,
  'forced desktop Save As should bypass browser handles and attach a native path');

const fileValidationStart = appSource.indexOf('function imageExtensionForFile(');
const fileValidationEnd = appSource.indexOf('\n  function encodedMarkdownPath', fileValidationStart);
assert.notEqual(fileValidationStart, -1, 'image file validation helpers should exist');
const fileValidationHelpers = vm.runInNewContext(`(() => {
  const IMAGE_MIME_EXTENSIONS = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif'
  };
  ${appSource.slice(fileValidationStart, fileValidationEnd)}
  function safeFileName(value) { return String(value || '图片'); }
  return { imageExtensionForFile, isSupportedImageFile, imageStorageFileName };
})()`);
[
  ['sample.png', 'image/png'],
  ['sample.jpg', 'image/jpeg'],
  ['sample.jpeg', 'image/jpeg'],
  ['sample.gif', 'image/gif'],
  ['sample.webp', 'image/webp'],
  ['sample.avif', 'image/avif'],
  ['sample.GIF', '']
].forEach(([name, type]) => {
  assert.equal(fileValidationHelpers.isSupportedImageFile({ name, type, size: 1 }), true, `${name} should be selectable`);
});
assert.equal(fileValidationHelpers.isSupportedImageFile({ name: 'notes.md', type: 'text/markdown', size: 1 }), false);
assert.equal(fileValidationHelpers.imageStorageFileName({ name: 'image', type: 'image/png', size: 1 }), 'image.png',
  'clipboard images without a filename extension must be stored with their MIME extension');
assert.equal(fileValidationHelpers.imageStorageFileName({ name: '', type: 'image/jpeg', size: 1 }), '图片.jpg');

const removeImageStart = appSource.indexOf('function removeMarkdownImage(');
const removeImageEnd = appSource.indexOf('\n  function normalizedHttpImageUrl', removeImageStart);
assert.notEqual(removeImageStart, -1, 'preview image deletion helper should exist');
assert.notEqual(removeImageEnd, -1, 'preview image deletion helper should have a stable boundary');
const removeImageHelpers = vm.runInNewContext(`(() => {
  function imageInsertionLines(markdown) {
    const text = String(markdown || '');
    let offset = 0;
    return text.split('\\n').map((raw, index, lines) => {
      const line = { raw, start: offset, end: offset + raw.length };
      offset += raw.length + (index < lines.length - 1 ? 1 : 0);
      return line;
    });
  }
  function imageStructuralLine() { return null; }
  function markdownImageTokens(markdown) {
    const tokens = [];
    const pattern = /!\\[([^\\]]*)\\]\\(([^)]+)\\)/g;
    let match;
    while ((match = pattern.exec(String(markdown || '')))) tokens.push({ start: match.index, end: match.index + match[0].length });
    return tokens;
  }
  ${appSource.slice(removeImageStart, removeImageEnd)}
  return { removeMarkdownImage };
})()`);
assert.deepEqual(
  JSON.parse(JSON.stringify(removeImageHelpers.removeMarkdownImage('正文\n\n![图](assets/a.png)\n\n后文', 0))),
  { text: '正文\n\n后文', nextImageIndex: -1, caret: 4 },
  'deleting the only selected image should remove its Markdown block without leaving extra blank rows'
);
assert.equal(
  removeImageHelpers.removeMarkdownImage('![甲](a.png) ![乙](b.png)', 0).text,
  '![乙](b.png)',
  'deleting one image from a row should retain the other images'
);
assert.equal(
  removeImageHelpers.removeMarkdownImage('<!-- guanyi:image width=50 align=center -->\n![图](a.png)', 0).text,
  '',
  'deleting the last image in a row should also remove orphaned presentation metadata'
);

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
assert.match(indexSource, /class="app-image-edit-toolbar"[^>]+role="toolbar"/, 'selected images should expose a contextual image toolbar');
assert.match(indexSource, /data-image-tool="align"[\s\S]+data-image-tool="description"/, 'image toolbar should retain alignment and description tools');
assert.match(indexSource, /id="btn-image-crop"[\s\S]+id="btn-image-download"/, 'image toolbar should expose direct crop and download tools');
assert.doesNotMatch(indexSource, /data-image-tool="resize"|id="image-size-range"|id="btn-image-size-auto"/, 'image size controls should not remain in the toolbar');
assert.match(indexSource, /id="image-resize-handle"[^>]+role="slider"[^>]+aria-valuemin="25"[^>]+aria-valuemax="100"/, 'selected images should expose a bounded bottom-right resize handle');
assert.match(indexSource, /id="gicon-description"/, 'description tool should use a defined icon');
assert.doesNotMatch(indexSource, /href="#gicon-(?:expand|text)"/, 'image toolbar should not reference missing legacy icons');
assert.match(indexSource, /data-image-align="left"[\s\S]+data-image-align="center"[\s\S]+data-image-align="right"/, 'all alignment choices should exist');
assert.match(indexSource, /id="image-description-input"/, 'image description editing should exist');
assert.match(indexSource, /data-image-tool="description"[^>]+title="添加描述"[^>]+data-tooltip="添加描述"/, 'description tool should advertise the inline add-description affordance');
assert.match(indexSource, /app-image-tool__tooltip[^>]+role="tooltip"[^>]*>添加描述</, 'description tool should expose a visible hover tooltip');
assert.match(appSource, /function imageElementsInRow\([\s\S]+app-image-cell > img/, 'image rows should support per-image cell wrappers');
assert.match(appSource, /turndownService\.addRule\('imageRowMetadata'[\s\S]+const metadata = imageRowMetadataComment/, 'the image row should serialize presentation metadata without relying on dropped DOM comments');
assert.match(appSource, /function preserveImageRowMetadata\([\s\S]+const tokens = markdownImageTokens\(source\)[\s\S]+renderedImages[\s\S]+insertions/, 'image row metadata should be reinjected by rendered image-token order after Turndown');
assert.match(appSource, /function startSelectedImageDescriptionEdit\([\s\S]+app-image-caption-input/, 'image descriptions should edit inline below the selected image');
assert.match(appSource, /function cancelImageDescriptionEdit\([\s\S]+descriptionCancelled/, 'Escape should cancel an inline description without committing it');
assert.match(appSource, /function commitOpenImageDescriptionPanel\([\s\S]+commitPreviewImageOrder\(\)[\s\S]+closeImageEditPanels/, 'the toolbar description field should have one canonical commit path');
assert.match(appSource, /toggleImageEditPanel\(button\.dataset\.imageTool\)/, 'the description toolbar action should open its declared panel');
assert.match(appSource, /imageDescriptionInput\?\.addEventListener\('focusout'[\s\S]+commitOpenImageDescriptionPanel/, 'leaving the description field should not discard unsaved text');
assert.match(appSource, /imageDescriptionInput\?\.addEventListener\('keydown'[\s\S]+event\.key === 'Escape'[\s\S]+closeImageEditPanels/, 'Escape should cancel the toolbar description edit');
assert.match(appSource, /function continuePreviewEditingAfterImage\([\s\S]+placePreviewCaret\(paragraph, 0\)/, 'image editing should provide a direct route back to the following body paragraph');
assert.match(appSource, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowRight'[\s\S]+continuePreviewEditingAfterImage/, 'arrow navigation should continue editing after a selected image');
assert.match(appSource, /btnImageDownload\?\.addEventListener\('click', \(\) => \{[\s\S]+commitOpenImageDescriptionPanel/, 'switching to download should commit an open description first');
assert.match(appSource, /btnImageCrop\?\.addEventListener\('click', \(\) => \{[\s\S]+commitOpenImageDescriptionPanel/, 'switching to crop should commit an open description first');
assert.match(cssSource, /\.app-image-caption\s*\{[\s\S]+text-align: center/, 'image captions should use a compact centered caption treatment');
assert.match(cssSource, /\.app-image-tool__tooltip\s*\{[\s\S]+visibility: hidden/, 'description tooltip should stay hidden until hover or focus');
assert.match(cssSource, /\.app-export-capture \.app-image-caption\.is-placeholder\s*\{\s*display: none;/, 'empty image description placeholders should stay out of exports');
assert.match(indexSource, /id="btn-image-download"/, 'image download should exist');
assert.match(indexSource, /id="image-crop-canvas"/, 'image crop canvas should exist');
assert.match(cssSource, /img\.is-image-selected[\s\S]+outline: 2px solid/, 'selected images should have visible feedback');
assert.match(cssSource, /\.app-image-edit-popover \{[\s\S]+width: max-content[\s\S]+max-width: calc\(100vw - 16px\)/, 'image toolbar should stay compact beside the selected image');
assert.match(cssSource, /\.app-image-tool \{[\s\S]+width: 32px[\s\S]+height: 32px[\s\S]+font-size: 0/, 'image toolbar actions should use compact icon-first targets');
assert.match(cssSource, /\.app-image-tool > span:last-child \{[\s\S]+clip-path: inset\(50%\)/, 'image toolbar labels should remain available to assistive technology and tooltips');
assert.match(cssSource, /\.app-image-resize-handle \{[\s\S]+cursor: nwse-resize[\s\S]+touch-action: none/, 'the direct resize handle should provide mouse and touch drag feedback');
assert.match(cssSource, /\.app-image-edit-popover\[data-image-panel-open="align"\][\s\S]+\.app-image-align-menu \{ display: block; \}/, 'alignment should open as an anchored menu');
assert.match(indexSource, /class="[^"]*app-image-align-menu[^"]*"[^>]+id="image-panel-align"/, 'alignment should use a compact anchored menu');
assert.match(indexSource, /role="menuitemradio"[^>]+data-image-align="center"/, 'alignment choices should expose checked menu semantics');
assert.match(indexSource, /data-image-tool="align"[^>]+aria-haspopup="menu"[\s\S]+gicon-chevron-down/, 'alignment trigger should advertise its dropdown affordance');
assert.match(cssSource, /\.app-image-row\[data-image-width\]/, 'persisted image width should affect preview layout');
assert.match(cssSource, /\.app-image-row\[data-image-count="1"\]\[data-image-width\] \.app-image-cell \{ width: 100%; \}/, 'explicit sizing should resize small single-image cells instead of preserving intrinsic width');
assert.match(cssSource, /\.app-image-row > img \{[\s\S]+object-fit: contain;/, 'equal-height image rows should show the complete image');
assert.match(cssSource, /\.app-image-row \{[\s\S]+display: flex;[\s\S]+flex-flow: row nowrap;/, 'multi-image rows should remain on one line while resizing');
assert.match(cssSource, /\.app-image-cell \{[\s\S]+flex: var\(--app-image-aspect, 1\) 1 0;/, 'cell widths should be distributed from each image natural ratio');
assert.doesNotMatch(cssSource, /aspect-ratio:\s*(?:4\s*\/\s*3|1\s*\/\s*1)/, 'equal-height rows must not force fixed crop ratios');
assert.match(appSource, /function syncImageCellAspect\([\s\S]+--app-image-aspect[\s\S]+addEventListener\('load'/, 'image loading should refresh the dynamic equal-height layout');
assert.match(appSource, /function captureImageInsertion\([\s\S]+flushPendingPreviewCommit\(\);[\s\S]+previewMarkdownSelection/, 'pending preview line breaks should be committed before locating an image');
assert.match(appSource, /function imageInsertionSelectionAfterPreviewBlock\([\s\S]+previousElementSibling[\s\S]+markdownToPlain/, 'empty preview blocks should anchor insertion after the preceding text block');
assert.match(appSource, /function insertImageBlocks\([\s\S]+ensureTrailingLine[\s\S]+anchor\.surface === 'source'/, 'source image insertion should preserve a following editable line');
assert.match(appSource, /function sourceProjectionForMarkdown\([\s\S]+图片编码[\s\S]+function expandSourceProjection/, 'source view should compact and reversibly restore data URI payloads');
assert.match(appSource, /function setProgrammaticSourceSelection\([\s\S]+sourceDisplayPosition/, 'programmatic source navigation should map canonical positions into the compact display');
assert.match(appSource, /sourceEditor\.addEventListener\('input'[\s\S]+currentSourceMarkdownSelection\(\)[\s\S]+sourceSelection/, 'source input should commit canonical Markdown while preserving the display caret');
assert.match(appSource, /sourceEditor\.addEventListener\('beforeinput'[\s\S]+sourceProjectionSegmentForEdit[\s\S]+removeProjectedImageSegment/, 'compact image encodings should be edited as atomic source regions');
assert.match(cssSource, /\.editor-source\s*\{[\s\S]+white-space: pre-wrap[\s\S]+overflow-wrap: anywhere[\s\S]+word-break: break-word/, 'source editor should soft-wrap long image encodings for readable cursor navigation');
assert.match(indexSource, /class="editor-source"[^>]+wrap="soft"/, 'source textarea should use browser soft wrapping');
assert.match(indexSource, /id="image-file-open"[^>]+accept="[^"]*\.png[^"]*\.jpg[^"]*\.jpeg[^"]*\.gif[^"]*\.webp[^"]*\.avif[^"]*image\/png[^"]*image\/jpeg[^"]*image\/gif/, 'the native image picker should enable every supported image extension and MIME type');
assert.match(appSource, /function canStoreImageBesideDocument\([\s\S]+isLocalFileDoc\(doc\)[\s\S]+doc\.fileHandle[\s\S]+doc\.directoryHandle/, 'local files should store beside-document images only after parent-directory access is granted');
assert.match(appSource, /function inlineImageStorageMessage\([\s\S]+!doc\.fileHandle && !doc\.desktopPath/, 'desktop-saved documents should not be reported as detached browser downloads');
const localPickerHandler = appSource.slice(
  appSource.indexOf("els.btnImageFile.addEventListener('click'"),
  appSource.indexOf("els.imageFileOpen.addEventListener('change'", appSource.indexOf("els.btnImageFile.addEventListener('click'"))
);
assert.match(localPickerHandler, /pendingImageInsertion = captureImageInsertion\(\)[\s\S]+imageFileOpen\.click\(\)/, 'one click on local image should open the native image file picker');
assert.doesNotMatch(localPickerHandler, /showDirectoryPicker|selectParentDirectory|needsImageDirectoryAuthorization/, 'the local image picker must never be replaced by a directory authorization dialog');
assert.match(appSource, /function toggleImageEditPanel\([\s\S]+closeImageEditPanels\(\)[\s\S]+aria-expanded/, 'image toolbar buttons should toggle one auxiliary panel at a time');
assert.match(appSource, /querySelectorAll\('\[data-image-tool\]'\)[\s\S]+toggleImageEditPanel/, 'image toolbar controls should be wired to their panels');
assert.match(appSource, /function imageAssetLocation\([\s\S]+selectParentDirectory\(doc\)/, 'local file assets should request and retain parent-directory access');
assert.match(appSource, /function bindPreviewImageResizeHandle\([\s\S]+pointerdown[\s\S]+pointermove[\s\S]+finishImageResizeDrag/, 'the selected-image corner handle should resize through pointer capture and persist on release');
assert.match(appSource, /function bindPreviewImageEditing\([\s\S]+event\.key === 'Backspace'[\s\S]+event\.key === 'Delete'[\s\S]+deleteSelectedPreviewImage\(\)/, 'Backspace and Delete should remove the selected preview image');
assert.match(appSource, /function deleteSelectedPreviewImage\([\s\S]+removeMarkdownImage\(getCurrentMarkdown\(\), imageIndex\)[\s\S]+setCurrentMarkdown\(result\.text\)/, 'preview deletion should update canonical Markdown and participate in undo history');
assert.match(appSource, /function bindPreviewImageResizeHandle\([\s\S]+dblclick[\s\S]+width: null/, 'double-clicking the resize handle should restore automatic sizing');
assert.match(appSource, /const metadata = imageRowMetadataFor\(paragraph\);[\s\S]+applyImageRowPresentation\(row, metadata\);/, 'overflow image rows should inherit presentation metadata');
assert.match(appSource, /event\.key !== 'Escape' \|\| els\.imageCropModal\?\.hidden[\s\S]+closeImageCrop\(\);/, 'Escape should close the crop modal');

console.log('image editing tests passed: selection UI, direct corner resize, metadata, alignment, descriptions, download and crop contracts verified');
