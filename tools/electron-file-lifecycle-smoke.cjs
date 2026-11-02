const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('missing output directory');
const fixture = fs.mkdtempSync(path.join(outputDirectory, 'lifecycle-'));
const profile = path.join(fixture, 'profile');
const sourceDirectory = path.join(fixture, 'source');
const addedDirectory = path.join(fixture, 'added');
const selectedDirectory = path.join(fixture, 'selected');
const movedDirectory = path.join(fixture, 'moved');
const sourceBase = '中文 书稿';
const sourcePath = path.join(sourceDirectory, `${sourceBase}.md`);
const content = `# 客户端文件验收\n\n原始内容。\n\n![封面](assets/${encodeURIComponent(sourceBase)}/cover.png)`;
for (const directory of [path.join(profile, 'state'), path.join(sourceDirectory, 'assets', sourceBase), addedDirectory, selectedDirectory, movedDirectory]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(sourcePath, content);
fs.copyFileSync(path.join(projectRoot, 'build-resources', 'icon-512.png'), path.join(sourceDirectory, 'assets', sourceBase, 'cover.png'));
fs.writeFileSync(path.join(sourceDirectory, `${sourceBase}.REVIEW.md`), [
  '# 文档协作任务', `- 目标文件：${sourceBase}.md`, '- 文档标识：external-source',
  '- 文档版本：external-version', '## 待处理批注', '磁盘中的已有批注必须保留'
].join('\n'));
const sourceStats = fs.statSync(sourcePath);
fs.writeFileSync(path.join(profile, 'state', 'editor-state-v1.json'), JSON.stringify({
  docs: [{ id: 'lifecycle-document', name: sourceBase, content, lastSavedContent: content,
    desktopPath: sourcePath, localFileName: path.basename(sourcePath), storageKind: 'external',
    sourceKind: 'local-file', externalModifiedAt: sourceStats.mtimeMs, externalSize: sourceStats.size,
    syncState: 'synced', contentLoaded: true, lastOpenedAt: Date.now() }],
  directories: [{ id: 'added-directory', name: '已添加目录', rootPath: addedDirectory,
    scanMode: 'manual', permissionState: 'granted', order: 0, collapsedPaths: [] }],
  currentDocId: 'lifecycle-document', openDocIds: ['lifecycle-document'],
  viewMode: 'preview', splitRatio: 0.5, theme: 'light', savedAt: Date.now()
}));
process.env.NODE_ENV = 'test';
process.env.GUANYI_TEST_USER_DATA = profile;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(predicate, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out: ${label}`);
}
let pickerCalls = 0;
let saveDialogCalls = 0;
dialog.showOpenDialog = async (_parent, options) => {
  assert.ok(options.properties.includes('openDirectory'));
  pickerCalls += 1;
  if (pickerCalls === 1) { await wait(180); return { canceled: true, filePaths: [] }; }
  return { canceled: false, filePaths: [pickerCalls === 2 ? selectedDirectory : movedDirectory] };
};
dialog.showSaveDialog = async () => {
  saveDialogCalls += 1;
  throw new Error('unexpected Save As fallback');
};

// Load the production main process, preload and renderer with an isolated profile.
require('../desktop/main.cjs');
const watchdog = setTimeout(() => { console.error('file lifecycle smoke timed out'); app.exit(1); }, 45000);

async function main() {
  await app.whenReady();
  // Search is unrelated to file lifecycle and has its own Electron acceptance suite.
  for (const [channel, result] of [
    ['guanyi-semantic:status', { available: false, state: 'disabled' }],
    ['guanyi-semantic:index', { available: false, indexed: 0 }],
    ['guanyi-semantic:search', { available: false, results: [] }]
  ]) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => result);
  }
  let window = BrowserWindow.getAllWindows()[0];
  assert.ok(window, 'production main window must exist');
  const ready = async () => {
    return window.webContents.executeJavaScript('Boolean(window.__MD_EDITOR_TEST__)').catch(() => false);
  };
  await until(ready, 'renderer boot');
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const current = () => evaluate(`(() => {
    const state = window.__MD_EDITOR_TEST__.getState();
    return state.docs.find((doc) => doc.id === state.currentDocId);
  })()`);
  const imagesReady = () => until(() => evaluate(`(() => {
    const images = Array.from(document.querySelectorAll('#preview-editor img'));
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
  })()`), 'managed images rendered');
  await imagesReady();

  // Enter preview text and immediately open Save As, before the debounce commits it.
  await evaluate(`(async () => {
    const editor = document.getElementById('preview-editor');
    const p = document.createElement('p'); p.textContent = '预览区最后输入'; editor.appendChild(p);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '入' }));
    await window.__MD_EDITOR_TEST__.openFileActionModal('save-as');
  })()`);
  const destinations = await evaluate(`Array.from(document.querySelectorAll('#file-action-destinations button'), (button) => button.textContent)`);
  assert.ok(destinations.some((label) => label.includes('当前位置')));
  assert.ok(destinations.some((label) => label.includes('已添加目录')));
  await evaluate(`document.getElementById('btn-file-action-other').click(); document.getElementById('btn-file-action-other').click()`);
  await until(() => evaluate(`!document.getElementById('btn-file-action-other').disabled`), 'picker cancellation');
  assert.equal(pickerCalls, 1);
  assert.equal(await evaluate(`document.getElementById('file-action-status').textContent`), '');
  await evaluate(`document.getElementById('btn-file-action-other').click()`);
  await until(() => evaluate(`document.getElementById('file-action-selected').textContent.includes('selected')`), 'selected folder');
  await evaluate(`document.getElementById('file-action-name').value = '中文 副本.md'`);
  await evaluate(`document.getElementById('btn-file-action-submit').click()`);
  await until(() => evaluate(`document.getElementById('file-action-modal').hidden`), 'save-as');
  const copied = await current();
  assert.equal(copied.desktopPath, path.join(selectedDirectory, '中文 副本.md'));
  const copiedContent = fs.readFileSync(copied.desktopPath, 'utf8');
  assert.ok(copiedContent.includes('预览区最后输入'));
  assert.ok(copiedContent.includes(`assets/${encodeURIComponent('中文 副本')}/cover.png`));
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), content, 'Save As must preserve the original');
  assert.ok(fs.existsSync(path.join(selectedDirectory, 'assets', '中文 副本', 'cover.png')));
  assert.ok(fs.existsSync(path.join(selectedDirectory, '中文 副本.REVIEW.md')));
  assert.ok(fs.readFileSync(path.join(selectedDirectory, '中文 副本.REVIEW.md'), 'utf8').includes('磁盘中的已有批注必须保留'));
  await imagesReady();

  // Move the saved copy, then save again through its new native identity.
  await evaluate(`window.__MD_EDITOR_TEST__.openFileActionModal('move')`);
  await evaluate(`document.getElementById('btn-file-action-other').click()`);
  await until(() => evaluate(`document.getElementById('file-action-selected').textContent.includes('moved')`), 'move folder');
  await evaluate(`document.getElementById('btn-file-action-submit').click()`);
  await until(() => evaluate(`document.getElementById('file-action-modal').hidden`), 'move');
  const moved = await current();
  assert.equal(moved.id, copied.id);
  assert.equal(moved.desktopPath, path.join(movedDirectory, '中文 副本.md'));
  assert.equal(fs.existsSync(copied.desktopPath), false);
  assert.equal(fs.existsSync(path.join(selectedDirectory, 'assets', '中文 副本')), false);
  assert.equal(fs.existsSync(path.join(selectedDirectory, '中文 副本.REVIEW.md')), false);
  assert.ok(fs.existsSync(path.join(movedDirectory, 'assets', '中文 副本', 'cover.png')));
  assert.ok(fs.existsSync(path.join(movedDirectory, '中文 副本.REVIEW.md')));
  assert.ok(fs.readFileSync(path.join(movedDirectory, '中文 副本.REVIEW.md'), 'utf8').includes('磁盘中的已有批注必须保留'));
  await imagesReady();
  await evaluate(`window.__MD_EDITOR_TEST__.setCurrentMarkdown(${JSON.stringify(copiedContent + '\n\n移动后继续保存')})`);
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), true);
  assert.ok(fs.readFileSync(moved.desktopPath, 'utf8').includes('移动后继续保存'));

  // A write failure must keep edits and path, and must never open a save dialog.
  const writeFile = fs.promises.writeFile;
  fs.promises.writeFile = async (target, ...args) => {
    if (target === moved.desktopPath) throw new Error('injected write failure');
    return writeFile(target, ...args);
  };
  await evaluate(`window.__MD_EDITOR_TEST__.setCurrentMarkdown('保存失败时保留的编辑')`);
  try { assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), false); }
  finally { fs.promises.writeFile = writeFile; }
  assert.equal((await current()).content, '保存失败时保留的编辑');
  assert.equal((await current()).desktopPath, moved.desktopPath);
  assert.equal(saveDialogCalls, 0);
  fs.writeFileSync(moved.desktopPath, '外部程序更新的磁盘内容');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), false);
  assert.equal((await current()).syncState, 'conflict');
  assert.equal(fs.readFileSync(moved.desktopPath, 'utf8'), '外部程序更新的磁盘内容');

  // Finder-style events must restore/foreground the app and activate the requested tab.
  const emitOpen = (filePath) => app.emit('open-file', { preventDefault() {} }, filePath);
  const assertOpened = async (filePath) => {
    await until(async () => (await current())?.desktopPath === filePath, 'requested document activation');
    await until(() => window.isVisible() && !window.isMinimized() && window.isFocused(), 'main window foreground');
    assert.equal(await evaluate(`document.activeElement.id`), 'preview-editor');
  };
  window.minimize();
  await until(() => window.isMinimized(), 'minimize');
  emitOpen(sourcePath);
  await assertOpened(sourcePath);
  await imagesReady();
  const screenshot = path.join(outputDirectory, 'desktop-file-lifecycle.png');
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  window.hide();
  emitOpen(moved.desktopPath);
  await assertOpened(moved.desktopPath);

  // Keep a helper window alive so close/reopen is exercised on every platform.
  const helper = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  window.destroy();
  emitOpen(sourcePath);
  window = BrowserWindow.getAllWindows().find((item) => item !== helper);
  assert.ok(window, 'opening a file must recreate a closed main window');
  await until(ready, 'recreated renderer boot');
  await assertOpened(sourcePath);
  // Older browser drafts restored in the desktop app can be saved without a source path.
  await evaluate(`(async () => {
    const api = window.__MD_EDITOR_TEST__;
    const state = api.getState();
    const draft = { id: 'unlinked-draft', name: '无路径草稿', localFileName: '无路径草稿.md',
      sourceKind: 'local-file', desktopPath: null, openedWithoutHandle: true,
      content: '旧版恢复的编辑内容', lastSavedContent: '' };
    state.docs.push(draft); state.openDocIds.push(draft.id); state.currentDocId = draft.id;
    api.setCurrentMarkdown(draft.content);
    await api.openFileActionModal('save-as');
    document.querySelector('[data-target-key="directory:added-directory"]').click();
    document.getElementById('btn-file-action-submit').click();
  })()`);
  await until(() => evaluate(`document.getElementById('file-action-modal').hidden`), 'unlinked draft save-as');
  assert.equal(fs.readFileSync(path.join(addedDirectory, '无路径草稿.md'), 'utf8'), '旧版恢复的编辑内容');
  helper.destroy();
  clearTimeout(watchdog);
  process.stdout.write(`Electron production file lifecycle passed: ${screenshot}\n`);
  app.quit();
}

main().catch((error) => { console.error(error); clearTimeout(watchdog); app.exit(1); });
