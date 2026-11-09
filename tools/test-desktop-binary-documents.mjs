import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = require('../desktop/binary-documents.cjs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'guanyi-binary-'));
const pdf = Buffer.from('%PDF-1.7\nfixture A\n%%EOF');
const pdfNext = Buffer.from('%PDF-1.7\nfixture B\n%%EOF');
const epub = Buffer.from('PK\x03\x04epub fixture container');
const fsApi = fs.promises;

try {
  assert.throws(() => binary.binaryDocumentBytes('string'), /数据无效/);
  assert.throws(() => binary.binaryDocumentBytes(Buffer.alloc(0)), /为空/);
  assert.throws(() => binary.binaryDocumentBytes(pdf, '.epub'), /格式不符/);
  assert.throws(() => binary.binaryDocumentBytes(epub, '.pdf'), /格式不符/);
  assert.throws(() => binary.binaryDocumentBytes(Buffer.alloc(binary.MAX_BINARY_DOCUMENT_SIZE + 1)), /100 MB/);
  const padded = Buffer.concat([Buffer.from('ignore'), pdf, Buffer.from('ignore')]);
  assert.deepEqual(binary.binaryDocumentBytes(padded.subarray(6, 6 + pdf.length), '.pdf'), pdf);

  assert.equal(await binary.readCachedBinaryDocument(fixture, 'reader-missing'), null);
  await assert.rejects(binary.cacheBinaryDocument(fixture, '../outside', pdf), /标识无效/);
  await assert.rejects(binary.readCachedBinaryDocument(fixture, '../outside'), /标识无效/);
  const writes = [binary.cacheBinaryDocument(fixture, 'reader-same-draft', pdf), binary.cacheBinaryDocument(fixture, 'reader-same-draft', pdfNext)];
  await Promise.all(writes);
  assert.deepEqual(Buffer.from(await binary.readCachedBinaryDocument(fixture, 'reader-same-draft')), pdfNext);

  let selected = { canceled: false, filePath: path.join(fixture, '另存文件') };
  let dialogCount = 0;
  const options = {
    dialogApi: { showSaveDialog: async (_window, settings) => {
      dialogCount += 1;
      assert.deepEqual(settings.filters[0].extensions, ['pdf']);
      return selected;
    } }
  };
  const saved = await binary.saveBinaryDocumentAs({ suggestedName: '来源.PDF', bytes: pdf }, options);
  assert.equal(saved.path, path.join(fixture, '另存文件.pdf'));
  assert.deepEqual(fs.readFileSync(saved.path), pdf);
  await assert.rejects(binary.saveBinaryDocumentAs({ suggestedName: '来源.epub', bytes: pdf }, options), /格式不符/);
  assert.equal(dialogCount, 1, 'invalid bytes must fail before opening a picker');
  selected = { canceled: true };
  assert.deepEqual(await binary.saveBinaryDocumentAs({ suggestedName: '来源.pdf', bytes: pdf }, options), { canceled: true });
  selected = { canceled: false, filePath: path.join(fixture, '错误格式.md') };
  await assert.rejects(binary.saveBinaryDocumentAs({ suggestedName: '来源.pdf', bytes: pdf }, options), /扩展名/);
  assert.equal(fs.existsSync(selected.filePath), false);

  const originalPath = saved.path;
  fs.chmodSync(originalPath, 0o640);
  await assert.rejects(binary.atomicWriteBinary(originalPath, pdfNext, {
    ...fsApi,
    rename: async () => { throw new Error('injected commit failure'); }
  }), /injected commit failure/);
  assert.deepEqual(fs.readFileSync(originalPath), pdf, 'failed commit preserves previous file');
  assert.equal(fs.readdirSync(fixture).some(name => name.endsWith('.tmp')), false, 'failed stage removed');
  await binary.atomicWriteBinary(originalPath, pdfNext);
  assert.deepEqual(fs.readFileSync(originalPath), pdfNext);
  assert.equal(fs.statSync(originalPath).mode & 0o777, 0o640);
  const linkPath = path.join(fixture, 'symlink.pdf');
  fs.symlinkSync(originalPath, linkPath);
  await assert.rejects(binary.atomicWriteBinary(linkPath, pdf), /普通文件/);
  assert.deepEqual(fs.readFileSync(originalPath), pdfNext);

  // Execute the production main module with a stub Electron host. All filesystem
  // calls and registered IPC implementations are real; the window/dialog are fixtures.
  const handlers = new Map();
  const sender = {};
  const openPath = path.join(fixture, '原文件.pdf');
  fs.writeFileSync(openPath, pdf);
  fs.writeFileSync(path.join(fixture, '电子书.epub'), epub);
  fs.writeFileSync(path.join(fixture, '文本.md'), '# text');
  fs.writeFileSync(path.join(fixture, '伪装.pdf'), 'not a PDF');
  const electron = {
    app: {
      setPath() {}, getPath: () => fixture,
      requestSingleInstanceLock: () => false, quit() {}
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [openPath, path.join(fixture, '电子书.epub')] }),
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(fixture, 'IPC另存.pdf') })
    },
    shell: { showItemInFolder() {} }
  };
  const mainSource = fs.readFileSync(path.join(projectRoot, 'desktop/main.cjs'), 'utf8');
  const mainRequire = createRequire(path.join(projectRoot, 'desktop/main.cjs'));
  const context = vm.createContext({
    require: id => id === 'electron' ? electron : mainRequire(id),
    process, Buffer, console, URL, setTimeout, clearTimeout,
    __dirname: path.join(projectRoot, 'desktop')
  });
  vm.runInContext(`${mainSource}\nmainWindow = { webContents: testSender }; installDesktopFileHandlers();`, Object.assign(context, { testSender: sender }));
  const invoke = (channel, payload, source = sender) => handlers.get(channel)({ sender: source }, payload);
  const chosen = await invoke('guanyi-files:choose');
  assert.deepEqual(Array.from(chosen), [openPath, path.join(fixture, '电子书.epub')]);
  const records = await invoke('guanyi-files:read', chosen);
  assert.deepEqual(Buffer.from(records[0].bytes), pdf);
  assert.deepEqual(Buffer.from(records[1].bytes), epub);
  const broken = await invoke('guanyi-files:read', [path.join(fixture, '伪装.pdf')]);
  assert.match(broken[0].error, /格式不符/);
  const largePath = path.join(fixture, '大型.pdf');
  fs.writeFileSync(largePath, pdf);
  fs.truncateSync(largePath, 21 * 1024 * 1024);
  assert.equal((await invoke('guanyi-files:read', [largePath]))[0].bytes.byteLength, 21 * 1024 * 1024);
  const hugePath = path.join(fixture, '超大.pdf');
  fs.writeFileSync(hugePath, pdf);
  fs.truncateSync(hugePath, binary.MAX_BINARY_DOCUMENT_SIZE + 1);
  assert.match((await invoke('guanyi-files:read', [hugePath]))[0].error, /100 MB/);
  const hugeText = path.join(fixture, '大型.txt');
  fs.writeFileSync(hugeText, 'text');
  fs.truncateSync(hugeText, 21 * 1024 * 1024);
  assert.match((await invoke('guanyi-files:read', [hugeText]))[0].error, /20 MB/);
  await assert.rejects(invoke('guanyi-files:write', { filePath: openPath, content: 'corruption' }), /Markdown 或 TXT/);
  await assert.rejects(invoke('guanyi-files:save-as', { suggestedName: 'a.md', content: 'corruption' }), /Markdown 或 TXT/);
  await assert.rejects(invoke('guanyi-files:rename', { filePath: openPath, nextName: 'renamed.md' }), /文件名无效/);
  await assert.rejects(invoke('guanyi-files:transaction', { mode: 'move', sourcePath: openPath, targetRootPath: fixture, fileName: 'moved.md' }), /阅读器/);
  await assert.rejects(invoke('guanyi-files:write-sibling', { documentPath: path.join(fixture, '文本.md'), name: '原文件.pdf', content: 'corruption' }), /伴随文件名无效/);
  assert.deepEqual(fs.readFileSync(openPath), pdf, 'binary source survives every text mutation entry point');
  const nativeSaved = await invoke('guanyi-files:save-binary-as', { suggestedName: 'original.pdf', bytes: pdf });
  assert.deepEqual(fs.readFileSync(nativeSaved.path), pdf);
  await invoke('guanyi-files:cache-binary', { id: 'reader-ipc', bytes: pdf });
  assert.deepEqual(Buffer.from(await invoke('guanyi-files:read-cached-binary', 'reader-ipc')), pdf);
  await assert.rejects(invoke('guanyi-files:cache-binary', { id: 'reader-ipc', bytes: pdf }, {}), /不受信任/);
  await assert.rejects(invoke('guanyi-files:save-binary-as', { suggestedName: 'x.pdf', bytes: pdf }, {}), /不受信任/);
  await assert.rejects(invoke('guanyi-files:read-cached-binary', 'reader-ipc', {}), /不受信任/);
  assert.equal(vm.runInContext(`shouldIgnoreDesktopDirectoryEntry('book.epub', 'file', 0)`, context), true);
  assert.equal(vm.runInContext(`shouldIgnoreDesktopDirectoryEntry('book.pdf', 'file', 0)`, context), true);
  assert.equal(vm.runInContext(`shouldIgnoreDesktopDirectoryEntry('book.md', 'file', 0)`, context), false);
  let quitCount = 0;
  let closed = false;
  electron.app.quit = () => { quitCount += 1; };
  context.closingWindow = {
    isDestroyed: () => closed,
    webContents: { executeJavaScript: async () => true },
    close: () => {
      closed = true;
      // Simulate Windows/Linux requesting Quit synchronously in window-all-closed.
      vm.runInContext('mainWindow = null; quitRequested = true', context);
    }
  };
  await vm.runInContext('prepareNativeClose(closingWindow)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCount, 1, 'a Quit requested during close must resume after the close checkpoint');
  console.log('desktop binary documents: PASS (read/open, atomic save, cache, size limits, text write isolation)');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
