const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'directory-removal-race-electron');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, 'run-'));
const directoryPath = path.join(fixture, '仅有一本书');
const pdfPath = path.join(directoryPath, '正在读取.pdf');
fs.mkdirSync(directoryPath);
const pdf = new jsPDF();
pdf.text('Pending directory read', 20, 30);
const pdfBytes = Buffer.from(pdf.output('arraybuffer'));
fs.writeFileSync(pdfPath, pdfBytes);
process.env.NODE_ENV = 'test';
process.env.GUANYI_TEST_USER_DATA = path.join(fixture, 'profile');

dialog.showOpenDialog = async (_window, options) => {
  assert.ok(options.properties.includes('openDirectory'));
  return { canceled: false, filePaths: [directoryPath] };
};
require('../desktop/main.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('directory removal race Electron smoke timed out');
  app.exit(1);
}, 90000);
async function until(predicate, label, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    await wait(50);
  }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  await app.whenReady();
  for (const [channel, result] of [
    ['guanyi-semantic:status', { available: false, state: 'disabled' }],
    ['guanyi-semantic:index', { available: false, indexed: 0 }],
    ['guanyi-semantic:search', { available: false, results: [] }]
  ]) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => result);
  }
  const window = BrowserWindow.getAllWindows()[0];
  assert.ok(window, 'production window must exist');
  window.webContents.setBackgroundThrottling(false);
  const errors = [];
  window.webContents.on('console-message', (_event, _level, message) => {
    if (/Uncaught (?:TypeError|ReferenceError|Error)/.test(message)) errors.push(message);
  });
  const evaluate = source => window.webContents.executeJavaScript(source);
  await until(() => evaluate('Boolean(window.__MD_EDITOR_TEST__)').catch(() => false), 'app boot');

  async function addDirectory() {
    await evaluate("document.getElementById('btn-add-directory').click(); document.getElementById('btn-directory-add').click()");
    const directory = await until(async () => {
      const value = await evaluate(`(() => {
        const directory = window.__MD_EDITOR_TEST__.getState().directories.find(d => d.rootPath === ${JSON.stringify(directoryPath)});
        return directory?.lastScanStatus === 'success' ? {id: directory.id, docs: window.__MD_EDITOR_TEST__.getState().docs.filter(d => d.directoryId === directory.id).map(d => ({id:d.id, file:d.localFileName, contentLoaded:d.contentLoaded}))} : null;
      })()`);
      return value;
    }, 'single PDF directory scan');
    assert.equal(directory.docs.length, 1);
    assert.equal(directory.docs[0].file, path.basename(pdfPath));
    assert.equal(directory.docs[0].contentLoaded, false);
    await evaluate("document.getElementById('btn-directory-done').click()");
    return { directoryId: directory.id, docId: directory.docs[0].id };
  }

  async function clickDoc(docId) {
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('#doc-list .app-doc-item')].find(item => item.dataset.docId === ${JSON.stringify(docId)});
      if (!item) throw new Error('document is not listed');
      item.click();
    })()`);
  }

  async function removeDirectory(directoryId) {
    await evaluate("document.getElementById('btn-add-directory').click()");
    await evaluate(`document.querySelector('.app-directory-item[data-directory-id="${directoryId}"] [data-action="remove-directory"]').click()`);
    await evaluate(`document.querySelector('.app-directory-item[data-directory-id="${directoryId}"] [data-action="confirm-remove-directory"]').click()`);
  }

  const first = await addDirectory();
  let readStarted = false;
  let releaseRead;
  ipcMain.removeHandler('guanyi-directories:read');
  ipcMain.handle('guanyi-directories:read', async (_event, payload) => {
    assert.equal(payload.rootPath, directoryPath);
    assert.equal(payload.relativePath, path.basename(pdfPath));
    readStarted = true;
    await new Promise(resolve => { releaseRead = resolve; });
    const stats = fs.statSync(pdfPath);
    return { path: pdfPath, name: path.basename(pdfPath), bytes: pdfBytes,
      lastModified: stats.mtimeMs, size: stats.size };
  });

  await clickDoc(first.docId);
  await until(() => readStarted, 'lazy PDF read started');
  await removeDirectory(first.directoryId);
  await wait(120);
  assert.ok(await evaluate(`window.__MD_EDITOR_TEST__.getState().directories.some(d => d.id === ${JSON.stringify(first.directoryId)})`),
    'directory removal must wait for the pending read');
  releaseRead();
  await until(() => evaluate(`!window.__MD_EDITOR_TEST__.getState().directories.some(d => d.id === ${JSON.stringify(first.directoryId)})`), 'directory removed after read');
  const retained = await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(first.docId)}) && (() => {const d = window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(first.docId)}); return {sourceKind:d.sourceKind,directoryId:d.directoryId,contentLoaded:d.contentLoaded};})()`);
  assert.deepEqual(retained, { sourceKind: 'local-file', directoryId: null, contentLoaded: true });
  await evaluate("document.getElementById('btn-directory-done').click()");
  await clickDoc(first.docId);
  await until(() => evaluate("document.querySelector('.app-reader-container:not([hidden]) iframe')?.contentWindow?.PDFViewerApplication?.pdfDocument?.numPages === 1"), 'retained PDF opens');

  const second = await addDirectory();
  await evaluate(`(() => {
    const state = window.__MD_EDITOR_TEST__.getState();
    const sole = state.docs.find(doc => doc.id === ${JSON.stringify(second.docId)});
    state.docs.splice(0, state.docs.length, sole);
    state.currentDocId = sole.id;
    state.openDocIds = [sole.id];
  })()`);
  await removeDirectory(second.directoryId);
  await until(() => evaluate(`!window.__MD_EDITOR_TEST__.getState().directories.some(d => d.id === ${JSON.stringify(second.directoryId)})`), 'sole directory removed');
  const fallback = await evaluate(`(() => {
    const state = window.__MD_EDITOR_TEST__.getState();
    return {count:state.docs.length,current:state.currentDocId,doc:state.docs[0] && {id:state.docs[0].id,sourceKind:state.docs[0].sourceKind,content:state.docs[0].content}};
  })()`);
  assert.equal(fallback.count, 1, 'a usable blank document must remain');
  assert.equal(fallback.current, fallback.doc.id);
  assert.equal(fallback.doc.sourceKind, 'browser');
  assert.equal(fallback.doc.content, '');
  await evaluate("document.getElementById('btn-directory-done').click()");
  await evaluate(`(() => {
    const input = document.getElementById('source-editor');
    input.value = '# 继续阅读';
    input.dispatchEvent(new InputEvent('input', {bubbles:true}));
  })()`);
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().docs[0].content'), '# 继续阅读');
  assert.deepEqual(errors, []);
  console.log('Directory removal race smoke passed: pending PDF read retained; sole directory removal left an editable blank document.');
  console.log(fixture);
  clearTimeout(watchdog);
  app.exit(0);
})().catch(async error => {
  console.error(error);
  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript('window.__MD_EDITOR_BOOT_ERROR__ || document.querySelector("#doc-list")?.textContent').catch(() => 'renderer unavailable'));
  clearTimeout(watchdog);
  app.exit(1);
});
