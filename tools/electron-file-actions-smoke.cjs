const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('missing screenshot output directory');

const userDataDirectory = path.join(outputDirectory, `user-data-${process.pid}`);
const sourceDirectory = path.join(outputDirectory, `source-${process.pid}`);
const addedDirectory = path.join(outputDirectory, `added-${process.pid}`);
const selectedDirectory = path.join(outputDirectory, `selected-${process.pid}`);
app.setPath('userData', userDataDirectory);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRenderer(window, timeout = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await window.webContents.executeJavaScript(`({
      ready: Boolean(window.__MD_EDITOR_TEST__),
      error: window.__MD_EDITOR_BOOT_ERROR__ || ''
    })`).catch((error) => ({ ready: false, error: error.message }));
    if (result.error) throw new Error(result.error);
    if (result.ready) return;
    await wait(80);
  }
  throw new Error('renderer boot timed out');
}

async function main() {
  await app.whenReady();
  await Promise.all([
    fs.promises.mkdir(sourceDirectory, { recursive: true }),
    fs.promises.mkdir(addedDirectory, { recursive: true }),
    fs.promises.mkdir(selectedDirectory, { recursive: true })
  ]);
  const sourcePath = path.join(sourceDirectory, '客户端选择器验收.md');
  const content = '# 客户端选择器验收\n\n不应调用浏览器文件夹选择器。';
  await fs.promises.writeFile(sourcePath, content, 'utf8');

  let pickerCalls = 0;
  let transactionCalls = 0;
  let lastTransaction = null;
  ipcMain.handle('guanyi-state:load', async () => ({
    docs: [{
      id: 'desktop-file-action-smoke',
      name: '客户端选择器验收',
      content,
      lastSavedContent: content,
      localFileName: path.basename(sourcePath),
      desktopPath: sourcePath,
      storageKind: 'external',
      sourceKind: 'local-file',
      externalModifiedAt: Date.now(),
      externalSize: Buffer.byteLength(content),
      syncState: 'synced',
      contentLoaded: true,
      lastOpenedAt: Date.now()
    }],
    directories: Array.from({ length: 8 }, (_value, index) => ({
      id: index === 0 ? 'desktop-added-directory' : `desktop-directory-${index}`,
      name: index === 0 ? '已添加目录' : `目录 ${index} · 较长的目录名称`,
      handleName: path.basename(addedDirectory),
      rootPath: index === 0 ? addedDirectory : path.join(addedDirectory, String(index)),
      permissionState: 'granted',
      scanMode: 'manual',
      order: index,
      collapsed: false,
      collapsedPaths: [],
      createdAt: Date.now()
    })),
    currentDocId: 'desktop-file-action-smoke',
    openDocIds: ['desktop-file-action-smoke'],
    viewMode: 'preview',
    splitRatio: 0.5,
    theme: 'light',
    savedAt: Date.now()
  }));
  ipcMain.handle('guanyi-state:save', async (event, payload) => ({ savedAt: Number(payload?.savedAt) || Date.now() }));
  ipcMain.handle('guanyi-app:version', async () => 'test');
  ipcMain.handle('guanyi-directories:inspect', async (event, rootPath) => ({ path: rootPath, name: path.basename(rootPath) }));
  ipcMain.handle('guanyi-directories:scan', async (event, rootPath) => ({
    path: rootPath, name: path.basename(rootPath), entries: [], errors: [], truncated: false, depthLimited: false
  }));
  ipcMain.handle('guanyi-directories:choose', async () => {
    pickerCalls += 1;
    if (pickerCalls === 1) {
      await wait(180);
      return null;
    }
    return { path: selectedDirectory, name: path.basename(selectedDirectory) };
  });
  ipcMain.handle('guanyi-files:read-sibling', async () => ({ exists: false, content: '' }));
  ipcMain.handle('guanyi-files:transaction', async (event, payload) => {
    transactionCalls += 1;
    lastTransaction = payload;
    const name = String(payload.fileName || 'copy.md');
    return {
      canceled: false,
      mode: payload.mode,
      path: path.join(selectedDirectory, name),
      name,
      directoryPath: selectedDirectory,
      directoryName: path.basename(selectedDirectory),
      size: Buffer.byteLength(payload.content || ''),
      lastModified: Date.now(),
      storageKind: 'external',
      content: String(payload.content || '')
    };
  });
  ipcMain.handle('guanyi-semantic:status', async () => ({ available: false, state: 'disabled' }));
  ipcMain.handle('guanyi-semantic:index', async () => ({ available: false, indexed: 0 }));
  ipcMain.handle('guanyi-semantic:search', async () => ({ available: false, results: [] }));
  ipcMain.handle('guanyi-ai:models', async () => ({ data: [] }));
  ipcMain.handle('guanyi-ai:cancel', async () => ({ canceled: true }));

  const consoleErrors = [];
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#f6f4f1',
    webPreferences: {
      preload: path.join(projectRoot, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  window.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'error' || Number(level) >= 3) consoleErrors.push(String(message || 'unknown renderer error'));
  });
  await window.loadFile(path.join(projectRoot, 'index.html'), { query: { client: 'desktop' } });
  await waitForRenderer(window);

  const opened = await window.webContents.executeJavaScript(`(async () => {
    await window.__MD_EDITOR_TEST__.openFileActionModal('save-as');
    const labels = [...document.querySelectorAll('#file-action-destinations .app-file-destination')]
      .map((button) => button.textContent.trim());
    return {
      open: !document.getElementById('file-action-modal').hidden,
      labels,
      selected: document.getElementById('file-action-selected').textContent,
      transactionType: typeof window.guanyiDesktop?.files?.transaction,
      directoryApiType: typeof window.guanyiDesktop?.directories?.choose,
      currentDoc: window.__MD_EDITOR_TEST__.getState().docs.find((doc) => doc.id === window.__MD_EDITOR_TEST__.getState().currentDocId),
      directories: window.__MD_EDITOR_TEST__.getState().directories
    };
  })()`);
  if (!opened.open) throw new Error('save-as modal did not open');
  if (!opened.labels.some((label) => label.includes('当前位置'))) {
    throw new Error(`current native directory is missing: ${JSON.stringify(opened)}`);
  }
  if (!opened.labels.some((label) => label.includes('已添加目录'))) {
    throw new Error(`added native directory is missing: ${JSON.stringify(opened)}`);
  }

  const screenshot = path.join(outputDirectory, 'desktop-save-as-native-destinations.png');
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) throw new Error('file-action screenshot is empty');
  await fs.promises.writeFile(screenshot, image.toPNG());

  // The primary action must remain visible with many folders and short/zoomed windows.
  for (const scenario of [
    { width: 1280, height: 820, zoom: 1, theme: 'light' },
    { width: 920, height: 640, zoom: 1.25, theme: 'dark' },
    { width: 640, height: 480, zoom: 1, theme: 'light', error: true },
    { width: 320, height: 568, zoom: 1, theme: 'dark' }
  ]) {
    window.setContentSize(scenario.width, scenario.height);
    window.webContents.setZoomFactor(scenario.zoom);
    await window.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(scenario.theme)}`);
    await window.webContents.executeJavaScript(`(() => {
      const status = document.getElementById('file-action-status');
      status.textContent = ${JSON.stringify(scenario.error ? '目标文件夹无法写入，请选择其他文件夹。修改和原文件均已保留。'.repeat(4) : '')};
      status.classList.toggle('is-error', ${!!scenario.error});
    })()`);
    await wait(100);
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.app-file-action-modal').getBoundingClientRect();
      const button = document.getElementById('btn-file-action-submit').getBoundingClientRect();
      const center = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
      const body = document.querySelector('.app-file-action-body');
      const before = button.top;
      if (body) body.scrollTop = body.scrollHeight;
      return { buttonTop: button.top, buttonBottom: button.bottom, modalBottom: modal.bottom,
        viewportHeight: innerHeight, reachable: center?.closest('button')?.id === 'btn-file-action-submit',
        footerStable: Math.abs(before - document.getElementById('btn-file-action-submit').getBoundingClientRect().top) < 1,
        bodyScrollable: !!body && body.scrollHeight > body.clientHeight,
        overflow: document.querySelector('.app-file-action-modal').scrollWidth > modal.width + 1 };
    })()`);
    await fs.promises.writeFile(path.join(outputDirectory, `file-modal-${scenario.width}x${scenario.height}-${scenario.zoom}-${scenario.theme}.png`), (await window.webContents.capturePage()).toPNG());
    if (geometry.buttonBottom > Math.min(geometry.modalBottom, geometry.viewportHeight) || !geometry.reachable || !geometry.footerStable || geometry.overflow) {
      throw new Error(`file-action buttons are clipped or obscured: ${JSON.stringify({ scenario, geometry })}`);
    }
    if (scenario.width <= 640 && !geometry.bodyScrollable) throw new Error('short modal body should scroll independently');
  }
  window.setContentSize(1280, 820);
  window.webContents.setZoomFactor(1);
  await window.webContents.executeJavaScript("document.documentElement.dataset.theme = 'light'");
  await window.webContents.executeJavaScript("document.getElementById('file-action-status').textContent = ''; document.getElementById('file-action-status').classList.remove('is-error')");

  await window.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('btn-file-action-other');
    button.click();
    button.click();
  })()`);
  await wait(60);
  if (pickerCalls !== 1) throw new Error(`expected one picker call during re-entry, received ${pickerCalls}`);
  const duringPicker = await window.webContents.executeJavaScript(`({
    disabled: document.getElementById('btn-file-action-other').disabled,
    status: document.getElementById('file-action-status').textContent
  })`);
  if (!duringPicker.disabled || !duringPicker.status.includes('正在选择')) throw new Error('picker busy state is not visible');
  await wait(180);
  const afterCancel = await window.webContents.executeJavaScript(`({
    disabled: document.getElementById('btn-file-action-other').disabled,
    status: document.getElementById('file-action-status').textContent
  })`);
  if (afterCancel.disabled) throw new Error('canceling the picker did not re-enable the button');
  if (afterCancel.status.includes('失败')) throw new Error(`canceling the picker displayed an error: ${afterCancel.status}`);

  await window.webContents.executeJavaScript("document.getElementById('btn-file-action-other').click()");
  await wait(80);
  const selected = await window.webContents.executeJavaScript("document.getElementById('file-action-selected').textContent");
  if (!selected.includes(path.basename(selectedDirectory))) throw new Error('the selected native directory was not retained');

  await window.webContents.executeJavaScript("document.getElementById('btn-file-action-submit').click()");
  await wait(160);
  if (transactionCalls !== 1) throw new Error(`expected one desktop transaction, received ${transactionCalls}`);
  if (lastTransaction?.targetRootPath !== selectedDirectory) throw new Error('desktop transaction received the wrong target path');
  if (lastTransaction?.mode !== 'save-as') throw new Error('desktop transaction received the wrong mode');
  const completed = await window.webContents.executeJavaScript(`({
    modalHidden: document.getElementById('file-action-modal').hidden,
    currentPath: window.__MD_EDITOR_TEST__.getState().docs.find((doc) => doc.id === window.__MD_EDITOR_TEST__.getState().currentDocId)?.desktopPath
  })`);
  if (!completed.modalHidden || !String(completed.currentPath || '').startsWith(selectedDirectory)) {
    throw new Error(`desktop transaction did not update the active file identity: ${JSON.stringify(completed)}`);
  }
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`);

  window.destroy();
  process.stdout.write(`Electron file-action smoke passed: ${screenshot}\n`);
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
