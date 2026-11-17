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
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function navigationHarness({ reader = true, view = 'document' } = {}) {
  const initial = { id: 'initial', name: '当前阅读', readerFormat: reader ? 'pdf' : undefined, lastOpenedAt: 10 };
  const next = { id: 'next', name: '后续文档', content: 'next content', lastOpenedAt: 0 };
  const directory = { id: 'directory', name: '目录文档', sourceKind: 'directory-file', contentLoaded: false, lastOpenedAt: 0 };
  const state = { docs: [initial, next, directory], currentDocId: initial.id, workspaceView: view,
    documentMode: 'reading', openDocIds: [initial.id] };
  const calls = { touched: [], saved: [], persisted: [], tips: [], focus: 0, hides: 0, reads: [] };
  let flush = async () => {}, read = async () => true, desktop = null, clock = 10;
  const context = {
    state, console: { warn() {} }, Math, Date, tabSessions: new Map(), activeSearchNavigation: null, documentOutlineOpen: true,
    draftCommentAnchor: null, selectedPreviewBlock: null, activeCommentId: null, confirmDocActionId: null,
    window: { GuanyiReaderHost: { flush: () => flush(), hide: () => { calls.hides += 1; } } },
    homeWorkspace: { show() {}, hide() {} },
    els: { sourceEditor: { focus: () => { calls.focus += 1; } }, previewWrap: { focus: () => { calls.focus += 1; } } },
    currentDoc: () => state.docs.find(doc => doc.id === state.currentDocId),
    isReaderDocument: doc => Boolean((doc || state.docs.find(item => item.id === state.currentDocId))?.readerFormat),
    isDirectoryDoc: doc => doc?.sourceKind === 'directory-file',
    directoryForDoc: () => ({ removing: false }),
    readDirectoryDocument: doc => { calls.reads.push(doc.id); return read(doc); },
    flushPendingPreviewCommit() {}, captureActiveTabSession() {},
    syncWorkspaceView: view => { state.workspaceView = view; },
    ensureDocOpen: id => { if (!state.openDocIds.includes(id)) state.openDocIds.push(id); },
    touchDoc: doc => { calls.touched.push(doc.id); doc.lastOpenedAt = ++clock; },
    saveState: options => { calls.saved.push(options); },
    persistDocHandles: doc => { calls.persisted.push(doc); },
    ensureHistory: () => ({}), resetHistoryCoalescing() {}, syncSourceToDOM() {}, render() {},
    renderDocList() {}, renderDocumentTabs() {}, updateStatus() {}, updateConflictBar() {},
    closeCommentComposer() {}, revealDoc() {}, restoreActiveTabSession() {}, updateEditChrome() {},
    markSemanticIndexDirty() {}, reviewStateFor: () => ({ comments: [] }), syncReviewSidecars() {},
    tip: value => { calls.tips.push(value); }, desktopFileApi: () => desktop, safeFileName: value => value,
    attachDesktopSavedFile: (doc, saved) => {
      Object.assign(doc, { desktopPath: saved.path, localFileName: saved.name, storageKind: saved.storageKind, sourceKind: 'local-file' });
      return saved.name;
    }
  };
  const api = vm.runInNewContext(`(() => {
    ${extract('enterDocumentWorkspace', 'async function showHomeWorkspace')}
    ${extract('showHomeWorkspace', 'function configureWorkspaceModel')}
    ${extract('switchDoc', 'function formatScanTime')}
    ${extract('nextUntitledName', 'function uniqueDocName')}
    ${extract('uniqueDocName', 'async function createDoc')}
    ${extract('createDoc', '// ── 打开本地文档')}
    ${extract('activateImportedDocs', 'async function openLocalDocuments')}
    return { showHomeWorkspace, switchDoc, createDoc, activateImportedDocs, enterDocumentWorkspace };
  })()`, context);
  return { ...api, state, initial, next, directory, calls, tabSessions: context.tabSessions,
    setFlush: value => { flush = value; }, setRead: value => { read = value; }, setDesktop: value => { desktop = value; } };
}

test('a later click on the current PDF wins over an earlier tab switch waiting for its checkpoint', async () => {
  const h = navigationHarness(), pending = deferred();
  h.setFlush(() => pending.promise);
  const earlier = h.switchDoc(h.next.id);
  assert.equal(await h.switchDoc(h.initial.id), true);
  pending.resolve();
  assert.equal(await earlier, false);
  assert.equal(h.state.currentDocId, h.initial.id);
  assert.equal(h.state.workspaceView, 'document');
  assert.equal(h.next.lastOpenedAt, 0);
  assert.deepEqual(h.state.openDocIds, [h.initial.id]);
  assert.deepEqual(h.calls.touched, [h.initial.id]);
});

test('Home supersedes an earlier tab switch without opening or touching its stale target', async () => {
  const h = navigationHarness(), first = deferred(), second = deferred();
  const checkpoints = [first.promise, second.promise];
  h.setFlush(() => checkpoints.shift());
  const earlier = h.switchDoc(h.next.id), home = h.showHomeWorkspace();
  first.resolve();
  assert.equal(await earlier, false);
  assert.equal(h.state.currentDocId, h.initial.id);
  second.resolve();
  assert.equal(await home, true);
  assert.equal(h.state.workspaceView, 'home');
  assert.equal(h.next.lastOpenedAt, 0);
  assert.deepEqual(h.calls.touched, []);
  assert.deepEqual(h.state.openDocIds, [h.initial.id]);
});

test('a newer current-PDF click prevents a delayed Home transition and suppresses its stale save error', async () => {
  const h = navigationHarness(), pending = deferred();
  h.setFlush(() => pending.promise);
  const home = h.showHomeWorkspace();
  assert.equal(await h.switchDoc(h.initial.id), true);
  pending.reject(new Error('old checkpoint failed'));
  assert.equal(await home, false);
  assert.equal(h.state.workspaceView, 'document');
  assert.equal(h.state.currentDocId, h.initial.id);
  assert.equal(h.calls.hides, 0);
  assert.deepEqual(h.calls.tips, []);
});

test('a late directory read preserves loaded content but cannot replace a newer document navigation', async () => {
  const h = navigationHarness({ reader: false }), pending = deferred();
  h.setRead(() => pending.promise.then(() => { h.directory.contentLoaded = true; h.directory.content = 'loaded from directory'; return true; }));
  const earlier = h.switchDoc(h.directory.id);
  assert.deepEqual(h.calls.reads, [h.directory.id]);
  assert.equal(await h.switchDoc(h.next.id), true);
  pending.resolve();
  assert.equal(await earlier, false);
  assert.equal(h.state.currentDocId, h.next.id);
  assert.equal(h.directory.content, 'loaded from directory');
  assert.equal(h.directory.lastOpenedAt, 0);
  assert.ok(!h.state.openDocIds.includes(h.directory.id));
  assert.deepEqual(h.calls.touched, [h.next.id]);
});

test('a managed document created after navigation is retained with its file identity but remains unopened', async () => {
  const h = navigationHarness({ reader: false, view: 'home' }), pending = deferred(), started = deferred();
  h.setDesktop({ createManaged: () => { started.resolve(); return pending.promise; } });
  const creating = h.createDoc({ name: '新的思考', content: '# My new thought' });
  await started.promise;
  assert.equal(await h.switchDoc(h.next.id), true);
  pending.resolve({ path: '/isolated-profile/documents/新的思考.md', name: '新的思考.md', storageKind: 'managed' });
  const created = await creating;
  assert.ok(h.state.docs.includes(created));
  assert.equal(created.desktopPath, '/isolated-profile/documents/新的思考.md');
  assert.equal(created.storageKind, 'managed');
  assert.equal(created.content, '# My new thought');
  assert.equal(created.lastOpenedAt, 0);
  assert.equal(h.state.currentDocId, h.next.id);
  assert.ok(!h.state.openDocIds.includes(created.id));
  assert.deepEqual(h.calls.touched, [h.next.id]);
  assert.equal(h.calls.focus, 0);
});

test('a create action cancelled by a newer navigation before its checkpoint completes does not allocate a file', async () => {
  const h = navigationHarness(), pending = deferred(); let createdFiles = 0;
  h.setFlush(() => pending.promise);
  h.setDesktop({ createManaged: async () => { createdFiles += 1; return {}; } });
  const creating = h.createDoc();
  assert.equal(await h.switchDoc(h.initial.id), true);
  pending.resolve();
  assert.equal(await creating, null);
  assert.equal(createdFiles, 0);
  assert.equal(h.state.docs.length, 3);
  assert.equal(h.state.currentDocId, h.initial.id);
});

test('an imported document finishing after Home retains its handle and persistence without changing recent order', async () => {
  const h = navigationHarness(), pending = deferred();
  const handle = { kind: 'file', name: '导入资料.md' };
  const imported = { id: 'imported', name: '导入资料', content: 'imported content', fileHandle: handle, lastOpenedAt: 0 };
  h.state.docs.push(imported);
  h.setFlush(() => pending.promise);
  const opening = h.activateImportedDocs([imported]), home = h.showHomeWorkspace();
  pending.resolve();
  assert.equal(await opening, false);
  assert.equal(await home, true);
  assert.equal(h.state.workspaceView, 'home');
  assert.equal(h.state.currentDocId, h.initial.id);
  assert.ok(h.state.docs.includes(imported));
  assert.equal(imported.fileHandle, handle);
  assert.equal(imported.lastOpenedAt, 0);
  assert.ok(h.calls.persisted.includes(imported));
  assert.ok(!h.state.openDocIds.includes(imported.id));
  assert.deepEqual(h.calls.touched, []);
  assert.equal(h.calls.focus, 0);
});

test('a target removed during an outstanding PDF checkpoint cannot be revived as a tab', async () => {
  const h = navigationHarness(), pending = deferred();
  h.setFlush(() => pending.promise);
  const opening = h.switchDoc(h.next.id);
  h.state.docs = h.state.docs.filter(doc => doc !== h.next);
  pending.resolve();
  assert.equal(await opening, false);
  assert.equal(h.state.currentDocId, h.initial.id);
  assert.ok(!h.state.openDocIds.includes(h.next.id));
  assert.equal(h.next.lastOpenedAt, 0);
  assert.deepEqual(h.calls.touched, []);
});


test('text documents keep the complete editing workspace by default while explicit reading and saved sessions remain available', async () => {
  const h = navigationHarness();
  assert.equal(await h.switchDoc(h.next.id), true);
  assert.equal(h.state.documentMode, 'editing');
  assert.equal(await h.switchDoc(h.initial.id), true);
  assert.equal(h.state.documentMode, 'reading');
  assert.equal(await h.switchDoc(h.next.id, { mode: 'reading' }), true);
  assert.equal(h.state.documentMode, 'reading');
  h.tabSessions.set(h.next.id, { documentMode: 'reading' });
  await h.switchDoc(h.initial.id);
  await h.switchDoc(h.next.id);
  assert.equal(h.state.documentMode, 'reading');
  await h.switchDoc(h.next.id, { mode: 'editing' });
  assert.equal(h.state.documentMode, 'editing');
  h.enterDocumentWorkspace();
  assert.equal(h.state.documentMode, 'editing');
});

test('native or browser imports activate Markdown and TXT editing, and retain PDF/EPUB reader modes', async () => {
  const h = navigationHarness({ view: 'home' });
  for (const [id, readerFormat] of [['markdown', undefined], ['plain-text', undefined], ['pdf', 'pdf'], ['epub', 'epub']]) {
    const doc = { id, name: id, content: 'imported', readerFormat, lastOpenedAt: 0 };
    h.state.docs.push(doc);
    await h.activateImportedDocs([doc]);
    assert.equal(h.state.currentDocId, id);
    assert.equal(h.state.documentMode, readerFormat ? 'reading' : 'editing');
  }
});
