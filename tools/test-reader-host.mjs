import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../js/reader-host.js', import.meta.url), 'utf8');
const evidenceSource = fs.readFileSync(new URL('../js/pdf-evidence.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const bytes = text => new TextEncoder().encode(text);
const text = data => new TextDecoder().decode(data);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class Element {
  constructor() {
    this.children = [];
    this.hidden = false;
    this.removed = false;
    this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) };
  }
  setAttribute() {}
  insertBefore(child) { this.children.push(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  remove() { this.removed = true; }
}

// Exercise the production host with an engine that checkpoints annotations
// through the real onSnapshot callback. Only the DOM, native storage and PDF
// rendering are fixtures; failures occur at the binary persistence boundary.
function harness() {
  const main = new Element();
  const cache = new Map();
  const opens = [];
  const exports = [];
  const notices = [];
  let failWrites = false;
  let beforeCache = async () => {};
  let persists = 0;
  const files = {
    readCachedBinary: async id => cache.get(id),
    cacheBinary: async (id, data) => {
      await beforeCache(id);
      if (failWrites) throw new Error('injected disk full');
      cache.set(id, new Uint8Array(data));
    },
    saveBinaryAs: async (name, data) => {
      exports.push({ name, bytes: new Uint8Array(data) });
      return { canceled: false };
    }
  };
  const engine = {
    async open(options) {
      const entry = {
        options, note: text(options.bytes), revision: options.edits.revision || 'original', disposed: false,
        disposeCalls: 0,
        setNote(note) {
          this.note = note;
          this.revision = note;
          options.onChange({ revision: note });
        }
      };
      const checkpoint = async () => {
        const snapshot = { bytes: bytes(entry.note), revision: entry.revision };
        await options.onSnapshot(snapshot.bytes, snapshot.revision);
        return snapshot;
      };
      entry.instance = {
        study: { info: { sourceHash: options.sourceHash, numPages: 1 } },
        serializeSnapshot: checkpoint,
        flush: async () => (await checkpoint()).bytes,
        dispose: async () => {
          entry.disposeCalls += 1;
          await checkpoint();
          entry.disposed = true;
        }
      };
      opens.push(entry);
      return entry.instance;
    }
  };
  const context = vm.createContext({
    console, TextDecoder, Uint8Array, setTimeout, clearTimeout, Blob, URL, crypto: webcrypto,
    document: {
      querySelector: () => main,
      getElementById: () => new Element(),
      createElement: () => new Element()
    },
    window: { guanyiDesktop: { files }, GuanyiPdfReader: engine }
  });
  vm.runInContext(evidenceSource, context, { filename: 'js/pdf-evidence.js' });
  vm.runInContext(source, context, { filename: 'js/reader-host.js' });
  const host = context.window.GuanyiReaderHost;
  const hooks = {
    icon: () => '', notify: message => notices.push(message), changed() {}, save() {},
    persist: () => { persists += 1; }
  };
  const document = (id = 'reader-fixture') => {
    cache.set(id, bytes('%PDF-original'));
    return { id, name: id, localFileName: `${id}.pdf`, readerFormat: 'pdf',
      content: '{"revision":"original"}', lastSavedContent: '{"revision":"original"}' };
  };
  return {
    host, hooks, document, cache, opens, exports, notices, context,
    failWrites(value) { failWrites = value; },
    beforeCache(callback) { beforeCache = callback; },
    get persists() { return persists; }
  };
}

test('failed tab checkpoint retains the live annotations and blocks exit until persistence succeeds', async () => {
  const h = harness();
  const doc = h.document();
  await h.host.show(doc, h.hooks);
  const original = h.opens[0];
  original.setNote('%PDF-current-note');
  h.failWrites(true);
  h.host.hide();
  await turn();

  assert.equal(original.options.container.removed, false, 'failed close must retain the only live annotation state');
  assert.equal(original.options.container.hidden, true);
  assert.equal(original.disposed, false);
  assert.equal(h.cache.has(`${doc.id}-pdf-draft`), false);
  assert.match(h.notices[0], /批注仍保留/);
  await assert.rejects(h.host.flush(), /injected disk full/, 'exit must retry and reject while storage is unavailable');

  assert.equal(await h.host.show(doc, h.hooks), original.instance, 'reopen must resume the original instance');
  assert.equal(h.opens.length, 1, 'reopening a failed close must not load an older PDF');
  assert.equal(original.options.container.hidden, false);
  assert.equal(original.note, '%PDF-current-note');
  await assert.rejects(h.host.flush(), /injected disk full/);

  h.failWrites(false);
  await h.host.flush();
  assert.equal(text(h.cache.get(doc.readerDraftKey)), '%PDF-current-note');
  h.host.hide();
  await h.host.flush();
  assert.equal(original.disposed, true);
  assert.equal(original.options.container.removed, true);
  assert.equal(original.options.toolbar.removed, true);

  await h.host.show(doc, h.hooks);
  assert.equal(h.opens.length, 2);
  assert.equal(h.opens[1].note, '%PDF-current-note', 'successful reopen must use the latest cached annotations');
  h.host.hide();
  await h.host.flush();
});

test('fast reopen waits for the previous checkpoint and opens the resulting PDF draft', async () => {
  const h = harness();
  const doc = h.document();
  await h.host.show(doc, h.hooks);
  h.opens[0].setNote('%PDF-quick-switch-note');
  const checkpoint = deferred();
  h.beforeCache(() => checkpoint.promise);
  h.host.hide();
  const reopening = h.host.show(doc, h.hooks);
  await turn();
  assert.equal(h.opens.length, 1, 'a second renderer cannot open before the previous checkpoint completes');

  checkpoint.resolve();
  await reopening;
  assert.equal(h.opens.length, 2);
  assert.equal(h.opens[0].disposed, true);
  assert.equal(h.opens[1].note, '%PDF-quick-switch-note');
  h.host.hide();
  await h.host.flush();
});

test('a checkpoint that fails during fast reopen restores the original instance', async () => {
  const h = harness();
  const doc = h.document();
  await h.host.show(doc, h.hooks);
  const original = h.opens[0];
  original.setNote('%PDF-pending-note');
  const checkpoint = deferred();
  h.beforeCache(() => checkpoint.promise);
  h.failWrites(true);
  h.host.hide();
  const reopening = h.host.show(doc, h.hooks);
  await turn();
  checkpoint.resolve();
  assert.equal(await reopening, original.instance);
  assert.equal(h.opens.length, 1);
  assert.equal(original.options.container.hidden, false);
  assert.equal(original.options.container.removed, false);
  await assert.rejects(h.host.flush(), /injected disk full/);
  h.failWrites(false);
  h.host.hide();
  await h.host.flush();
  assert.equal(original.disposed, true);
});

test('export marks only the serialized revision as saved when another edit occurs during serialization', async () => {
  const h = harness();
  const doc = h.document();
  await h.host.show(doc, h.hooks);
  const current = h.opens[0];
  current.setNote('%PDF-exported-A');
  const checkpoint = deferred();
  h.beforeCache(() => checkpoint.promise);
  const save = h.host.saveAs(doc);
  await turn();
  current.setNote('%PDF-newer-B');
  checkpoint.resolve();
  assert.equal(await save, true);
  assert.equal(text(h.exports[0].bytes), '%PDF-exported-A');
  assert.equal(JSON.parse(doc.lastSavedContent).revision, '%PDF-exported-A');
  assert.equal(JSON.parse(doc.content).revision, '%PDF-newer-B');
  assert.notEqual(doc.content, doc.lastSavedContent, 'later annotation edits must remain dirty');
  h.host.hide();
  await h.host.flush();
});

test('reopening repairs missing originals but never replaces missing annotated drafts with the source', async () => {
  const h = harness();
  const doc = h.document();
  h.cache.delete(doc.id);
  assert.equal(await h.host.reuse(doc, bytes('%PDF-reopened')), true);
  assert.equal(text(h.cache.get(doc.id)), '%PDF-reopened');
  doc.readerDraftKey = `${doc.id}-pdf-draft`;
  doc.content = '{"revision":"kept-note"}';
  assert.equal(await h.host.reuse(doc, bytes('%PDF-original')), false);
  assert.equal(h.cache.has(doc.readerDraftKey), false);
  assert.equal(doc.content, '{"revision":"kept-note"}');
  assert.equal(text(h.cache.get(doc.id)), '%PDF-reopened');
});

test('legacy source SHA-256 migrates from pristine bytes and stays stable across annotation drafts', async () => {
  const h = harness(); const doc = h.document();
  const expected = createHash('sha256').update(bytes('%PDF-original')).digest('hex');
  await h.host.show(doc, h.hooks);
  assert.equal(doc.readerSourceHash, expected);
  assert.equal(h.opens[0].options.sourceHash, expected);
  h.opens[0].setNote('%PDF-added-note');
  h.host.hide(); await h.host.flush();
  delete doc.readerSourceHash;
  await h.host.show(doc, h.hooks);
  assert.equal(h.opens[1].note, '%PDF-added-note');
  assert.equal(doc.readerSourceHash, expected, 'annotation bytes cannot replace source identity');
  assert.equal(await h.host.getStudyReader('another-document'), null);
  assert.equal((await h.host.getStudyReader(doc.id)).info.sourceHash, expected);
  h.host.hide(); await h.host.flush();
});

test('study persistence failure retains the native PDF instance and can be retried', async () => {
  const h = harness(); const doc = h.document();
  let failStudy = true; let shown = 0; let disposed = 0;
  h.hooks.study = {};
  h.context.window.GuanyiPdfStudy = { mount: () => ({
    show() { shown += 1; },
    flush() { if (failStudy) throw new Error('study storage full'); },
    dispose() { disposed += 1; }
  }) };
  await h.host.show(doc, h.hooks);
  assert.equal(await h.host.openStudy(doc.id), true);
  assert.equal(shown, 1);
  h.host.hide(); await turn();
  assert.equal(h.opens[0].disposed, false);
  assert.equal(disposed, 0);
  await assert.rejects(h.host.flush(), /study storage full/);
  assert.equal(await h.host.show(doc, h.hooks), h.opens[0].instance);
  failStudy = false;
  h.host.hide(); await h.host.flush();
  assert.equal(disposed, 1);
  assert.equal(h.opens[0].disposed, true);
});

test('background source reads are bounded to selected cache identity and leave active PDF untouched', async () => {
  const h = harness(); const current = h.document('current'); const selected = h.document('selected');
  await h.host.show(current, h.hooks);
  const calls = [];
  h.context.window.GuanyiPdfEvidence.readPdf = async (data, options) => { calls.push({ text: text(data), options }); return { evidence: [], coverage: { complete: true } }; };
  await h.host.readSource(selected, { maxPages: 3, maxChars: 2000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '%PDF-original');
  assert.equal(calls[0].options.maxPages, 3);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].disposed, false);
  await assert.rejects(h.host.readSource({ ...selected, id: 'not-cached', desktopPath: '/not-selected.pdf' }), /尚未缓存/);
  h.host.hide(); await h.host.flush();
});

test('a native PDF checkpoint failure remounts study UI when its retained session is resumed', async () => {
  const h = harness(); const doc = h.document(); let mounts = 0;
  h.hooks.study = {};
  h.context.window.GuanyiPdfStudy = { mount: () => { mounts += 1; return { flush() {}, dispose() {} }; } };
  await h.host.show(doc, h.hooks);
  h.opens[0].setNote('%PDF-pending-native-note');
  h.failWrites(true); h.host.hide(); await turn();
  assert.equal(h.opens[0].disposed, false);
  assert.equal(mounts, 1);
  await h.host.show(doc, h.hooks);
  assert.equal(mounts, 2, 'a successfully closed study UI must be restored with the retained native reader');
  assert.equal(h.opens.length, 1);
  h.failWrites(false); h.host.hide(); await h.host.flush();
});
