const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { SemanticSearchService } = require('./semantic-search.cjs');

const PRODUCT_NAME = '观绎 MD';
const APP_URL_PROTOCOLS = new Set(['file:']);
const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:']);

let mainWindow = null;
let semanticSearch = null;

function semanticModelDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', 'bge-small-zh-v1.5')
    : path.join(__dirname, '..', 'models', 'bge-small-zh-v1.5');
}

function installSemanticSearchHandlers() {
  semanticSearch = new SemanticSearchService({
    modelDir: semanticModelDirectory(),
    indexFile: path.join(app.getPath('userData'), 'search', 'bge-small-zh-v1.5-index.bin')
  });
  const progressFor = (event) => (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('guanyi-semantic:progress', payload);
  };
  const trusted = (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('不受信任的语义搜索请求');
  };
  ipcMain.handle('guanyi-semantic:status', async (event) => {
    trusted(event);
    return semanticSearch.status();
  });
  ipcMain.handle('guanyi-semantic:index', async (event, payload) => {
    trusted(event);
    return semanticSearch.indexDocuments(payload?.documents, payload?.options, progressFor(event));
  });
  ipcMain.handle('guanyi-semantic:search', async (event, payload) => {
    trusted(event);
    return semanticSearch.search(payload?.query, payload?.limit, progressFor(event));
  });
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!EXTERNAL_URL_PROTOCOLS.has(url.protocol)) return;
    shell.openExternal(url.toString());
  } catch (_error) {
    // Ignore malformed links from document content.
  }
}

function installApplicationMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about', label: `关于${PRODUCT_NAME}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏${PRODUCT_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出${PRODUCT_NAME}` }
      ]
    });
  }
  template.push(
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '恢复' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#f6f4f1',
    icon: path.join(__dirname, '..', 'build-resources', 'icon-512.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (APP_URL_PROTOCOLS.has(new URL(url).protocol)) return;
    } catch (_error) {
      // Block malformed navigation below.
    }
    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'), {
    query: { client: 'desktop' }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(PRODUCT_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('com.guanyi.md');

  app.whenReady().then(() => {
    installApplicationMenu();
    installSemanticSearchHandlers();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { semanticSearch?.dispose(); });
}
