const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('missing output directory');
fs.mkdirSync(outputDirectory, { recursive: true });
const fixture = fs.mkdtempSync(path.join(outputDirectory, 'binary-'));
const profile = path.join(fixture, 'profile');
const source = path.join(fixture, '中文源文件.PDF');
const target = path.join(fixture, '中文副本.pdf');
const bytes = Buffer.from('%PDF-1.7\nNative IPC fixture\n%%EOF');
fs.writeFileSync(source, bytes);
process.env.NODE_ENV = 'test';
process.env.GUANYI_TEST_USER_DATA = profile;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
let cancelSave = true;
let closeErrors = 0;
dialog.showSaveDialog = async () => ({ canceled: cancelSave, filePath: target });
dialog.showMessageBox = async () => { closeErrors += 1; return { response: 0 }; };
require('../desktop/main.cjs');
const watchdog = setTimeout(() => { console.error('binary IPC smoke timed out'); app.exit(1); }, 30000);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('native close transition timed out');
    await wait(30);
  }
}

async function main() {
  await app.whenReady();
  for (const channel of ['guanyi-semantic:status', 'guanyi-semantic:index', 'guanyi-semantic:search']) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => ({ available: false, results: [] }));
  }
  const window = BrowserWindow.getAllWindows()[0];
  if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const record = await evaluate(`(async () => {
    const api = window.guanyiDesktop.files;
    const paths = await api.choose();
    const [record] = await api.read(paths);
    if (record.error) throw new Error(record.error);
    await api.cacheBinary('reader-native-draft', new Uint8Array(record.bytes));
    const restored = await api.readCachedBinary('reader-native-draft');
    return { path: record.path, bytes: Array.from(new Uint8Array(restored)), missing: await api.readCachedBinary('reader-missing') };
  })()`);
  assert.equal(record.path, source);
  assert.deepEqual(Buffer.from(record.bytes), bytes);
  assert.equal(record.missing, null);
  assert.equal(await evaluate(`(async () => {
    const api = window.guanyiDesktop.files;
    const bytes = await api.readCachedBinary('reader-native-draft');
    const result = await api.saveBinaryAs('中文副本.pdf', new Uint8Array(bytes));
    return result.canceled;
  })()`), true);
  assert.equal(fs.existsSync(target), false);
  cancelSave = false;
  const saved = await evaluate(`(async () => {
    const api = window.guanyiDesktop.files;
    return api.saveBinaryAs('中文副本.pdf', await api.readCachedBinary('reader-native-draft'));
  })()`);
  assert.equal(saved.path, target);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.match(await evaluate(`window.guanyiDesktop.files.write(${JSON.stringify(source)}, 'not PDF').then(() => 'unexpected success', error => error.message)`), /Markdown 或 TXT/);
  assert.deepEqual(fs.readFileSync(source), bytes);
  console.log('Electron binary IPC: PASS (preload ArrayBuffer/Uint8Array, cache, cancellation, save and UTF8 isolation)');

  await evaluate(`window.GuanyiReaderHost.flush = async () => { throw new Error('injected checkpoint failure'); }; true`);
  window.close();
  await until(() => closeErrors === 1);
  assert.equal(window.isDestroyed(), false, 'failed checkpoint must retain the document window');
  assert.equal(await evaluate('document.body.inert'), false, 'failed checkpoint must restore interaction');
  await evaluate(`window.GuanyiReaderHost.flush = async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    const api = window.guanyiDesktop;
    await api.files.cacheBinary('reader-close-draft', await api.files.readCachedBinary('reader-native-draft'));
    await api.state.save({ docs: [], savedAt: Date.now(), closeMarker: 'flushed' });
  }; true`);
  window.close();
  window.close();
  await wait(40);
  assert.equal(window.isDestroyed(), false, 'close must await the pending checkpoint');
  assert.equal(await evaluate('document.body.inert'), true, 'closing window must prevent new edits while committing');
  await until(() => window.isDestroyed());
  assert.deepEqual(fs.readFileSync(path.join(profile, 'binary-documents', 'reader-close-draft.bin')), bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'state', 'editor-state-v1.json'), 'utf8')).closeMarker, 'flushed');

  app.emit('activate');
  const reopened = BrowserWindow.getAllWindows()[0];
  if (reopened.webContents.isLoading()) await new Promise(resolve => reopened.webContents.once('did-finish-load', resolve));
  await reopened.webContents.executeJavaScript(`window.GuanyiReaderHost.flush = async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    await window.guanyiDesktop.files.cacheBinary('reader-quit-draft', await window.guanyiDesktop.files.readCachedBinary('reader-native-draft'));
  }; true`);
  await new Promise((resolve, reject) => {
    app.once('will-quit', () => {
      try {
        assert.deepEqual(fs.readFileSync(path.join(profile, 'binary-documents', 'reader-quit-draft.bin')), bytes);
        console.log('Electron close/quit checkpoint: PASS (wait, failure recovery, deduplication, disk persistence)');
        resolve();
      } catch (error) { reject(error); }
    });
    app.quit();
    app.quit();
  });
}
main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch(error => {
  clearTimeout(watchdog); console.error(error); app.exit(1);
});
