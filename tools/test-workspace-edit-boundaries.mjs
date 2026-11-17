import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
function extract(name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n  ${next}`, start);
  assert.ok(start >= 0 && end > start, `${name} has a stable function boundary`);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
}
function load(name, next, context) {
  return vm.runInNewContext(`(${extract(name, next)})`, context);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function editHarness() {
  const doc = { id: 'a', content: 'original', name: 'notes' };
  const state = { currentDocId: doc.id, workspaceView: 'document', documentMode: 'editing', viewMode: 'source' };
  const counts = { writes: 0, cleanup: 0, stores: 0, renders: 0, tips: [] };
  const context = {
    state, currentDoc: () => doc, isReaderDocument: () => false, isPlainTextDocument: () => false,
    tip: value => counts.tips.push(value), console: { warn() {}, error() {} },
    renderPreview: () => { counts.renders += 1; },
    setCurrentMarkdown: value => { counts.writes += 1; doc.content = value; },
    canStoreImageBesideDocument: () => true,
    ensureDesktopImageDocumentPath: async () => true,
    isSupportedImageFile: () => true, imageBaseName: () => 'image',
    markdownImageSyntax: (_alt, value) => `![image](${value})`,
    storeDirectoryImage: async () => {
      counts.stores += 1;
      return { source: 'assets/image.png', cleanup: async () => { counts.cleanup += 1; } };
    },
    relocateCapturedRange: (_anchor, markdown) => ({ markdown, start: 0, end: 0 }),
    insertImageBlocks: (markdown, _start, _end, blocks) => ({ text: `${markdown}\n${blocks.join(' ')}`, caret: 1 }),
    placePreviewCaretAfterInsertedImages() {}, setProgrammaticSourceSelection() {},
    els: { sourceEditor: { focus() {} } }
  };
  const anchor = { docId: doc.id, surface: 'source', selectedText: '', sourceMarkdown: doc.content };
  return { context, doc, state, counts, anchor };
}

test('preview editing handlers cannot mutate a reading document or the Home workspace', () => {
  const handlers = new Map();
  const counts = { mutations: 0, renders: 0, timers: 0 };
  const state = { workspaceView: 'document', documentMode: 'reading' };
  const editor = { addEventListener: (type, fn) => handlers.set(type, fn), contains: () => true };
  const mutation = () => { counts.mutations += 1; return false; };
  const context = {
    state, els: { previewEditor: editor }, document: { addEventListener() {} }, isReaderDocument: () => false,
    isImeCompositionEvent: () => false, movePreviewListItem: mutation, backspacePreviewEmptyList: mutation,
    backspacePreviewEmptyFormattedBlock: mutation, continuePreviewList: mutation,
    handleInternalMarkdownPaste: mutation, toggleTaskByIndex: mutation,
    renderPreview: () => { counts.renders += 1; }, previewEditing: false, previewInputTimer: null,
    renderTimer: null, clearTimeout() {}, setTimeout: () => { counts.timers += 1; },
    activeSearchNavigation: {}, imageFilesFromTransfer: () => []
  };
  load('bindPreviewEdit', 'function bindPreviewLinks', context)();
  const event = { target: { closest: () => null }, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  handlers.get('beforeinput')(event);
  assert.equal(event.prevented, true);
  handlers.get('keydown')({ key: 'Enter' });
  handlers.get('paste')({ ...event, prevented: false });
  const checkbox = { dataset: { mdTaskIndex: '0' }, checked: true };
  handlers.get('change')({ ...event, target: { closest: () => checkbox } });
  handlers.get('input')(event);
  assert.equal(counts.mutations, 0);
  assert.equal(counts.timers, 0);
  assert.equal(counts.renders, 2, 'synthetic checkbox/input changes restore the source preview');
  state.documentMode = 'editing'; state.workspaceView = 'home';
  handlers.get('keydown')({ key: 'Tab' });
  assert.equal(counts.mutations, 0);
  delete state.workspaceView; delete state.documentMode;
  handlers.get('keydown')({ key: 'Enter' });
  assert.equal(counts.mutations, 4, 'legacy extracted-function editing harness remains supported');
});

test('image application rejects readonly, Home, chat, and reader documents', () => {
  const h = editHarness();
  const apply = load('applyImageBlocks', 'async function insertImageFiles', h.context);
  for (const [view, mode] of [['document', 'reading'], ['home', 'editing'], ['chat', 'editing']]) {
    h.state.workspaceView = view; h.state.documentMode = mode;
    assert.equal(apply(h.anchor, ['image']), false);
  }
  h.state.workspaceView = 'document'; h.state.documentMode = 'editing';
  h.context.isReaderDocument = () => true;
  assert.equal(apply(h.anchor, ['image']), false);
  assert.equal(h.counts.writes, 0);
  h.context.isReaderDocument = () => false;
  delete h.state.workspaceView; delete h.state.documentMode;
  assert.equal(apply(h.anchor, ['image']), true);
  assert.equal(h.counts.writes, 1);
});

test('image insertion stops before asset storage if reading mode changes during path preparation', async () => {
  const h = editHarness(), pending = deferred();
  h.context.ensureDesktopImageDocumentPath = () => pending.promise;
  h.context.applyImageBlocks = () => { h.counts.writes += 1; return true; };
  const insert = load('insertImageFiles', 'function insertImageUrl', h.context);
  const result = insert([{}], h.anchor);
  h.state.documentMode = 'reading'; pending.resolve(true);
  assert.equal(await result, false);
  assert.equal(h.counts.stores, 0); assert.equal(h.counts.writes, 0);
});

test('image insertion rolls back completed assets when the active document changes', async () => {
  const h = editHarness(), pending = deferred(), started = deferred();
  h.context.storeDirectoryImage = () => { h.counts.stores += 1; started.resolve(); return pending.promise; };
  h.context.applyImageBlocks = () => { h.counts.writes += 1; return true; };
  const insert = load('insertImageFiles', 'function insertImageUrl', h.context);
  const result = insert([{}, {}], h.anchor);
  await started.promise;
  h.state.currentDocId = 'b';
  pending.resolve({ source: 'assets/a.png', cleanup: async () => { h.counts.cleanup += 1; } });
  assert.equal(await result, false);
  assert.equal(h.counts.stores, 1); assert.equal(h.counts.cleanup, 1); assert.equal(h.counts.writes, 0);
});

test('internal Markdown paste rejects readonly input before capturing or materializing anything', () => {
  const h = editHarness(); h.state.documentMode = 'reading';
  let prevented = false;
  const paste = load('handleInternalMarkdownPaste', 'function transferMayContainImages', h.context);
  assert.equal(paste({ preventDefault: () => { prevented = true; }, stopPropagation() {} }, 'preview'), true);
  assert.equal(prevented, true); assert.equal(h.counts.writes, 0);
});

test('internal Markdown paste rolls back copied assets after leaving editing mode', async () => {
  const h = editHarness(), pending = deferred();
  Object.assign(h.context, {
    internalMarkdownClipboardForTransfer: () => ({ markdown: 'copied' }),
    captureImageInsertion: () => h.anchor,
    materializeMarkdownClipboardImages: () => pending.promise,
    markdownImageTokens: () => []
  });
  const paste = load('handleInternalMarkdownPaste', 'function transferMayContainImages', h.context);
  const result = paste({ preventDefault() {}, stopPropagation() {} }, 'source');
  h.state.workspaceView = 'home';
  pending.resolve({ markdown: 'copied', cleanups: [async () => { h.counts.cleanup += 1; }] });
  assert.equal(await result, true);
  assert.equal(h.counts.cleanup, 1); assert.equal(h.counts.writes, 0);
  assert.equal(h.doc.content, 'original');
});

test('clipboard materialization revalidates the target after asynchronous source-image reads', async () => {
  const h = editHarness(), pending = deferred(); let editable = true;
  Object.assign(h.context, {
    desktopFileApi: () => null,
    markdownImageTokens: () => [{ source: 'assets/a.png' }], isRelativeImageSource: () => true,
    localImageFileForDoc: () => pending.promise,
    clipboardImageFile: () => ({}), replaceMarkdownImageSources: markdown => markdown
  });
  const materialize = load('materializeMarkdownClipboardImages', 'function handleInternalMarkdownPaste', h.context);
  const result = materialize({ markdown: 'image', sourceDocument: { id: 'source' } }, h.doc, {
    assertTarget: () => { if (!editable) throw new Error('target changed'); }
  });
  editable = false; pending.resolve({});
  await assert.rejects(result, /target changed/);
  assert.equal(h.counts.stores, 0); assert.equal(h.counts.writes, 0);
});

for (const [name, next, activeKey, textKey] of [
  ['appendOriginalAnswerToCurrentDocument', 'async function generateOriginalAnswer', 'activeOriginalAnswer', 'originalAnswerMarkdown'],
  ['appendWorkAnswerToCurrentDocument', 'async function askWorkPrototype', 'activeWorkAnswer', 'workAnswerMarkdown']
]) {
  test(`${name} enters editing before committing and reports only actual writes`, () => {
    const h = editHarness(); h.state.documentMode = 'reading'; h.state.workspaceView = 'home';
    Object.assign(h.context, {
      [activeKey]: {}, [textKey]: () => 'answer', originalAnswerInsertAnchor: null,
      captureOriginalAnswerInsertionAnchor: () => h.anchor,
      enterDocumentWorkspace: ({ mode }) => { h.state.documentMode = mode; h.state.workspaceView = 'document'; },
      renderDocumentTabs() {}, closeSearchModal() {}, requestAnimationFrame() {},
      insertMarkdownBlock: markdown => ({ text: `${markdown}\nanswer`, caret: 1 })
    });
    const append = load(name, next, h.context);
    assert.equal(append(), true);
    assert.equal(h.state.documentMode, 'editing'); assert.equal(h.state.workspaceView, 'document');
    assert.equal(h.doc.content, 'original\nanswer');
    h.context.setCurrentMarkdown = () => {};
    assert.equal(append(), false);
    assert.equal(h.counts.tips.length, 1, 'a rejected commit must not show a second success');
    h.context.isReaderDocument = () => true;
    assert.equal(append(), false);
  });
}

test('image crop cannot write its completed result into a different active document', async () => {
  const h = editHarness(), pending = deferred(), started = deferred();
  Object.assign(h.context, {
    markdownImageTokens: () => [{ source: 'assets/original.png', alt: '' }],
    safeFileName: name => name, File: class File {}, updateMarkdownImage: () => 'cropped',
    storeDirectoryImage: () => { started.resolve(); return pending.promise; }
  });
  const crop = load('storeCroppedImage', 'async function applyImageCrop', h.context);
  const result = crop({}, 0);
  await started.promise;
  h.state.workspaceView = 'home';
  pending.resolve({ source: 'assets/crop.png', cleanup: async () => { h.counts.cleanup += 1; } });
  await assert.rejects(result, /裁剪位置已变化/);
  assert.equal(h.counts.cleanup, 1); assert.equal(h.counts.writes, 0);
});
