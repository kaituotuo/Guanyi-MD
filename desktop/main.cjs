const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { SemanticSearchWorkerClient } = require('./semantic-search-worker-client.cjs');
const { disposeDesktopAiRequests, installDesktopAiHandlers } = require('./ai-transport.cjs');
const {
  BINARY_DOCUMENT_EXTENSIONS,
  MAX_BINARY_DOCUMENT_SIZE,
  binaryDocumentBytes,
  saveBinaryDocumentAs,
  cacheBinaryDocument,
  readCachedBinaryDocument
} = require('./binary-documents.cjs');
const {
  APPLICATION_MENU_COMMANDS,
  buildApplicationMenuTemplate,
  updateApplicationMenuState
} = require('./application-menu.cjs');

const PRODUCT_NAME = '观译阅读器';
const MEILISEARCH_VERSION = '1.53.1';
const APP_URL_PROTOCOLS = new Set(['file:']);
const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:']);
const DESKTOP_OPEN_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const DESKTOP_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
const DESKTOP_MAX_FILE_SIZE = 20 * 1024 * 1024;
const DESKTOP_DIRECTORY_MAX_DEPTH = 5;
const DESKTOP_DIRECTORY_MAX_FILES = 500;
const DESKTOP_STATE_MAX_SIZE = 128 * 1024 * 1024;

// Keep upgrades on one stable profile even if product metadata changes later.
const testUserDataPath = process.env.NODE_ENV === 'test' && path.isAbsolute(process.env.GUANYI_TEST_USER_DATA || '')
  ? process.env.GUANYI_TEST_USER_DATA
  : null;
app.setPath('userData', testUserDataPath || path.join(app.getPath('appData'), 'guanyi-md'));

let mainWindow = null;
let helpWindow = null;
let applicationMenu = null;
let semanticSearch = null;
let quitRequested = false;
let quitPrepared = false;
let windowClosePreparation = null;
const preparedWindows = new WeakSet();
let rendererReady = false;
let pendingOpenPaths = [];
let stateWriteQueue = Promise.resolve();
let nativePickerActive = false;

async function runNativePicker(task) {
  if (nativePickerActive) {
    const error = new Error('系统文件选择窗口已打开，请先完成或取消当前选择');
    error.code = 'NATIVE_PICKER_ACTIVE';
    throw error;
  }
  nativePickerActive = true;
  try { return await task(); }
  finally { nativePickerActive = false; }
}

function normalizedOpenPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const value = rawPath.trim();
  if (value.startsWith('-')) return null;
  const extension = path.extname(value).toLowerCase();
  return DESKTOP_OPEN_EXTENSIONS.has(extension) || BINARY_DOCUMENT_EXTENSIONS.has(extension)
    ? path.resolve(value) : null;
}

function normalizedOpenPaths(rawPaths) {
  return [...new Set((Array.isArray(rawPaths) ? rawPaths : [rawPaths])
    .map(normalizedOpenPath).filter(Boolean))];
}

function flushPendingOpenPaths() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || !pendingOpenPaths.length) return;
  const paths = pendingOpenPaths;
  pendingOpenPaths = [];
  mainWindow.webContents.send('guanyi:open-files', paths);
}

function queueOpenPaths(rawPaths) {
  const paths = normalizedOpenPaths(rawPaths);
  if (!paths.length) return;
  pendingOpenPaths = [...new Set([...pendingOpenPaths, ...paths])];
  showMainWindow();
  flushPendingOpenPaths();
}

function showMainWindow() {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.focus();
}

async function flushWindowBeforeClose(window) {
  if (!window || window.isDestroyed()) return;
  let timeout;
  try {
    const result = await Promise.race([
      (async () => {
        const flushed = await window.webContents.executeJavaScript(`(async () => {
          document.body.inert = true;
          return await (window.GuanyiReaderHost?.flush?.() ?? true);
        })()`);
        await stateWriteQueue;
        return flushed;
      })(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('保存阅读批注超时，请稍后重试')), 30000);
      })
    ]);
    if (result === false) throw new Error('阅读批注尚未保存，请重试');
  } finally {
    clearTimeout(timeout);
  }
}

function prepareNativeClose(window) {
  if (windowClosePreparation) return windowClosePreparation;
  windowClosePreparation = (async () => {
    try {
      await flushWindowBeforeClose(window);
      if (quitRequested) {
        disposeDesktopAiRequests();
        await semanticSearch?.dispose().catch(error => console.warn('关闭搜索服务失败', error));
        quitPrepared = true;
        app.quit();
      } else if (window && !window.isDestroyed()) {
        preparedWindows.add(window);
        window.close();
      }
    } catch (error) {
      quitRequested = false;
      if (window && !window.isDestroyed()) {
        await window.webContents.executeJavaScript('document.body.inert = false; true').catch(() => {});
      }
      const options = {
        type: 'warning',
        title: '阅读记录尚未保存',
        message: '请保存阅读记录后再关闭观译阅读器',
        detail: error?.message || '保存失败，请重试。',
        buttons: ['返回文档'],
        defaultId: 0,
        noLink: true
      };
      if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
      else await dialog.showMessageBox(options);
    } finally {
      windowClosePreparation = null;
      // On Windows/Linux, window-all-closed can request Quit during window.close().
      if (quitRequested && !quitPrepared) void prepareNativeClose(mainWindow);
    }
  })();
  return windowClosePreparation;
}

function trustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('不受信任的文件请求');
}

function desktopImageMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif'
  })[extension] || 'application/octet-stream';
}

async function readDesktopFile(filePath) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) throw new Error('目标不是文件');
  const binary = BINARY_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const maximum = binary ? MAX_BINARY_DOCUMENT_SIZE : DESKTOP_MAX_FILE_SIZE;
  if (stats.size > maximum) throw new Error(binary ? '文件超过 100 MB' : '文件超过 20 MB');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length > maximum) throw new Error(binary ? '文件超过 100 MB' : '文件超过 20 MB');
  if (binary) binaryDocumentBytes(bytes, path.extname(filePath).toLowerCase());
  return {
    path: filePath,
    name: path.basename(filePath),
    size: bytes.byteLength,
    lastModified: stats.mtimeMs,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function safeDirectoryEntryPath(rootPath, relativePath) {
  const root = path.resolve(String(rootPath || ''));
  const relative = String(relativePath || '').replace(/\\/g, '/');
  if (!rootPath || !relative || path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('目录内路径无效');
  }
  const candidate = path.resolve(root, ...relative.split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('路径超出已添加目录');
  return candidate;
}

function relativeDirectoryPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function shouldIgnoreDesktopDirectoryEntry(name, kind, depth) {
  const value = String(name || '');
  if (!value || value.startsWith('.')) return true;
  if (kind === 'directory') return value === 'node_modules' || depth >= DESKTOP_DIRECTORY_MAX_DEPTH;
  const lower = value.toLowerCase();
  if (lower.endsWith('.review.md') || lower.endsWith('.review.json')) return true;
  return !DESKTOP_OPEN_EXTENSIONS.has(path.extname(lower));
}

async function inspectDesktopDirectory(rawPath) {
  const rootPath = path.resolve(String(rawPath || ''));
  const rootStats = await fs.promises.stat(rootPath);
  if (!rootStats.isDirectory()) throw new Error('目标不是文件夹');
  return { path: rootPath, name: path.basename(rootPath) || rootPath };
}

async function scanDesktopDirectory(rawPath) {
  const root = await inspectDesktopDirectory(rawPath);
  const entries = [], errors = [];
  let visited = 0, truncated = false, depthLimited = false;

  async function walk(directoryPath, prefix, depth) {
    let children;
    try { children = await fs.promises.readdir(directoryPath, { withFileTypes: true }); }
    catch (error) { errors.push({ path: prefix || root.name, reason: error.message || '无法访问目录' }); return; }
    children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const child of children) {
      if (entries.length >= DESKTOP_DIRECTORY_MAX_FILES) { truncated = true; return; }
      if (child.isSymbolicLink()) continue;
      const relativePath = relativeDirectoryPath(path.join(prefix, child.name));
      if (child.isDirectory()) {
        if (shouldIgnoreDesktopDirectoryEntry(child.name, 'directory', depth)) {
          if (!child.name.startsWith('.') && child.name !== 'node_modules' && depth >= DESKTOP_DIRECTORY_MAX_DEPTH) depthLimited = true;
          continue;
        }
        await walk(path.join(directoryPath, child.name), relativePath, depth + 1);
      } else if (child.isFile() && !shouldIgnoreDesktopDirectoryEntry(child.name, 'file', depth)) {
        try {
          const filePath = safeDirectoryEntryPath(root.path, relativePath);
          const stats = await fs.promises.stat(filePath);
          if (stats.size > DESKTOP_MAX_FILE_SIZE) {
            errors.push({ path: relativePath, reason: '文件超过 20 MB，未载入' });
          } else {
            entries.push({
              relativePath,
              fileName: child.name,
              path: filePath,
              lastModified: stats.mtimeMs,
              size: stats.size
            });
          }
        } catch (error) {
          errors.push({ path: relativePath, reason: error.message || '无法读取' });
        }
      }
      visited += 1;
    }
  }

  await walk(root.path, '', 0);
  return { ...root, entries, errors, truncated, depthLimited };
}

function stateFilePath() {
  return path.join(app.getPath('userData'), 'state', 'editor-state-v1.json');
}

async function saveDesktopState(payload) {
  const serialized = JSON.stringify(payload || {});
  if (Buffer.byteLength(serialized, 'utf8') > DESKTOP_STATE_MAX_SIZE) throw new Error('编辑状态超过本地备份上限');
  const target = stateFilePath();
  const temporary = `${target}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(temporary, serialized, 'utf8');
  await fs.promises.rename(temporary, target);
  return { savedAt: Number(payload?.savedAt) || Date.now() };
}

async function readDesktopState() {
  try { return JSON.parse(await fs.promises.readFile(stateFilePath(), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function decodedDesktopAssetSourceParts(source) {
  const cleanSource = String(source || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const parts = [];
  for (const rawPart of cleanSource.split('/')) {
    if (!rawPart || rawPart === '.') continue;
    let part;
    try { part = decodeURIComponent(rawPart); }
    catch (_error) { throw new Error('图片路径编码无效'); }
    if (!part || part === '.') continue;
    if (part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) {
      throw new Error('图片路径无效');
    }
    parts.push(part);
  }
  if (!parts.length) throw new Error('图片路径无效');
  return parts;
}

function desktopAssetPath(documentPath, source) {
  if (typeof documentPath !== 'string' || !documentPath || typeof source !== 'string' || !source) {
    throw new Error('图片路径无效');
  }
  const baseDirectory = path.dirname(path.resolve(documentPath));
  const candidate = path.resolve(baseDirectory, ...decodedDesktopAssetSourceParts(source));
  if (candidate !== baseDirectory && !candidate.startsWith(`${baseDirectory}${path.sep}`)) {
    throw new Error('图片路径超出文档目录');
  }
  if (!DESKTOP_IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error('不支持的图片格式');
  return candidate;
}

async function saveDesktopFileAs(payload, options = {}) {
  const content = String(payload?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > DESKTOP_MAX_FILE_SIZE) throw new Error('文件超过 20 MB');
  const requestedName = path.basename(String(payload?.suggestedName || '未命名文档.md'));
  const requestedExtension = DESKTOP_OPEN_EXTENSIONS.has(path.extname(requestedName).toLowerCase())
    ? path.extname(requestedName).toLowerCase()
    : '.md';
  const suggestedName = DESKTOP_OPEN_EXTENSIONS.has(path.extname(requestedName).toLowerCase())
    ? requestedName
    : `${requestedName || '未命名文档'}${requestedExtension}`;
  const dialogApi = options.dialogApi || dialog;
  const fileSystem = options.fileSystem || fs.promises;
  const result = await dialogApi.showSaveDialog(options.window || mainWindow, {
    title: '保存本地文档',
    defaultPath: suggestedName,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: '纯文本', extensions: ['txt'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const candidate = path.extname(result.filePath)
    ? result.filePath
    : `${result.filePath}${requestedExtension}`;
  const filePath = normalizedOpenPath(candidate);
  if (!filePath || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('只能保存为 Markdown 或 TXT 文件');
  }
  await fileSystem.writeFile(filePath, content, 'utf8');
  const stats = await fileSystem.stat(filePath);
  return {
    canceled: false,
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    lastModified: stats.mtimeMs,
    storageKind: 'external'
  };
}

function managedDocumentsDirectory(options = {}) {
  return path.join(options.userDataPath || app.getPath('userData'), 'documents');
}

function managedDocumentFileName(rawName) {
  const requested = path.basename(String(rawName || '未命名文档.md').replace(/\\/g, '/'));
  const parsed = path.parse(requested);
  const requestedExtension = parsed.ext.toLowerCase();
  const extension = DESKTOP_OPEN_EXTENSIONS.has(requestedExtension) ? requestedExtension : '.md';
  let stem = (parsed.name || '未命名文档')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || '未命名文档';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return { stem, extension };
}

async function createManagedDesktopFile(payload, options = {}) {
  const content = String(payload?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > DESKTOP_MAX_FILE_SIZE) throw new Error('文件超过 20 MB');
  const fileSystem = options.fileSystem || fs.promises;
  const directoryPath = managedDocumentsDirectory(options);
  const { stem, extension } = managedDocumentFileName(payload?.suggestedName);
  await fileSystem.mkdir(directoryPath, { recursive: true });

  let index = 1;
  while (index < 10000) {
    const suffix = index === 1 ? '' : `-${index}`;
    const filePath = path.join(directoryPath, `${stem}${suffix}${extension}`);
    try {
      await fileSystem.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
      const stats = await fileSystem.stat(filePath);
      return {
        canceled: false,
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        lastModified: stats.mtimeMs,
        storageKind: 'managed'
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      index += 1;
    }
  }
  throw new Error('默认文档目录中同名文件过多');
}

async function showDesktopFileInFolder(rawPath, options = {}) {
  const filePath = normalizedOpenPath(rawPath);
  if (!filePath) throw new Error('文件路径无效');
  const fileSystem = options.fileSystem || fs.promises;
  const shellApi = options.shellApi || shell;
  const stats = await fileSystem.stat(filePath);
  if (!stats.isFile()) throw new Error('目标不是文件');
  shellApi.showItemInFolder(filePath);
  return { path: filePath };
}

async function pathExists(fileSystem, filePath) {
  try { await fileSystem.access(filePath); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function uniqueDesktopFilePath(fileSystem, directoryPath, requestedName) {
  const requestedPath = path.join(directoryPath, requestedName);
  if (!await pathExists(fileSystem, requestedPath)) return requestedPath;
  const parsed = path.parse(requestedName);
  let number = 2;
  while (await pathExists(fileSystem, path.join(directoryPath, `${parsed.name} ${number}${parsed.ext}`))) number += 1;
  return path.join(directoryPath, `${parsed.name} ${number}${parsed.ext}`);
}

async function removeDesktopEntry(fileSystem, filePath) {
  await fileSystem.rm(filePath, { recursive: true, force: true });
}

async function copyDesktopEntry(fileSystem, sourcePath, targetPath) {
  if (!await pathExists(fileSystem, sourcePath)) return false;
  const stats = await fileSystem.stat(sourcePath);
  if (stats.isDirectory()) await fileSystem.cp(sourcePath, targetPath, { recursive: true });
  else await fileSystem.copyFile(sourcePath, targetPath);
  return true;
}

function validatedDesktopTransactionName(rawName) {
  const value = String(rawName || '').trim();
  const name = path.basename(value);
  if (!value || name !== value || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw new Error('目标文件名无效');
  }
  return name;
}

function desktopTransactionDirectory(rootPath, relativePrefix = '') {
  const root = path.resolve(String(rootPath || ''));
  if (!rootPath) throw new Error('目标文件夹无效');
  const relative = String(relativePrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return relative ? safeDirectoryEntryPath(root, relative) : root;
}

function desktopReviewHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function desktopTransactionReviewContent(reviewContent, targetName, targetDocId, targetContent) {
  return String(reviewContent || '')
    .replace(/^- 目标文件：.*$/m, () => `- 目标文件：${targetName}`)
    .replace(/^- 文档标识：.*$/m, () => `- 文档标识：${String(targetDocId || '').trim()}`)
    .replace(/^- 文档版本：.*$/m, () => `- 文档版本：${desktopReviewHash(targetContent)}`);
}

function rewriteDesktopManagedImageSources(content, sourceBase, targetBase) {
  if (!sourceBase || sourceBase === targetBase) return content;
  return content.replace(/(?<![\w./:-])(\.\/)?assets\/([^/\r\n]+)\//g, (match, prefix = '', base) => {
    try {
      if (decodeURIComponent(base) === sourceBase) return `${prefix}assets/${encodeURIComponent(targetBase)}/`;
    } catch (_error) { /* Leave unrelated or malformed references intact. */ }
    return match;
  });
}

async function performDesktopFileTransaction(payload, options = {}) {
  const fileSystem = options.fileSystem || fs.promises;
  const mode = payload?.mode;
  if (!['save-as', 'move'].includes(mode)) throw new Error('文件操作类型无效');
  const content = String(payload?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > DESKTOP_MAX_FILE_SIZE) throw new Error('文件超过 20 MB');

  const targetRoot = desktopTransactionDirectory(payload?.targetRootPath, payload?.targetRelativePrefix);
  const targetStats = await fileSystem.stat(targetRoot);
  if (!targetStats.isDirectory()) throw new Error('目标位置不是文件夹');
  const requestedName = validatedDesktopTransactionName(payload?.fileName);
  const conflict = ['keep-both', 'replace', 'cancel'].includes(payload?.conflict) ? payload.conflict : 'keep-both';
  let targetPath = path.join(targetRoot, requestedName);
  const targetExists = await pathExists(fileSystem, targetPath);
  if (targetExists && conflict === 'cancel') throw new Error('已取消：目标文件夹存在同名文件');
  if (targetExists && conflict === 'keep-both') targetPath = await uniqueDesktopFilePath(fileSystem, targetRoot, requestedName);

  const sourcePath = payload?.sourcePath ? normalizedOpenPath(payload.sourcePath) : null;
  if (sourcePath && !DESKTOP_OPEN_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error('PDF 和 EPUB 请使用阅读器中的另存功能');
  }
  if (mode === 'move' && !sourcePath) throw new Error('无法确认原文件位置，已停止移动');
  if (sourcePath) {
    const sourceStats = await fileSystem.stat(sourcePath);
    if (!sourceStats.isFile()) throw new Error('原位置不是文档文件');
    if (mode === 'move' && payload.expectedModifiedAt
      && (Number(payload.expectedModifiedAt) !== sourceStats.mtimeMs || Number(payload.expectedSize) !== sourceStats.size)) {
      throw new Error('原文件已被其他程序修改，请重新打开后再移动');
    }
  }
  if (sourcePath && mode === 'save-as' && path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('另存为不能替换原文件，请更改文件名或选择“保留两份”');
  }
  if (sourcePath && mode === 'move' && path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('文档已经位于所选位置');
  }

  const targetName = path.basename(targetPath);
  const targetBase = path.parse(targetName).name;
  const sourceDirectory = sourcePath ? path.dirname(sourcePath) : null;
  const sourceBase = sourcePath ? path.parse(sourcePath).name : '';
  const targetContent = rewriteDesktopManagedImageSources(content, sourceBase, targetBase);
  if (Buffer.byteLength(targetContent, 'utf8') > DESKTOP_MAX_FILE_SIZE) throw new Error('文件超过 20 MB');
  const sourceReviewPath = sourcePath ? path.join(sourceDirectory, `${sourceBase}.REVIEW.md`) : null;
  const sourceAssetsPath = sourcePath ? path.join(sourceDirectory, 'assets', sourceBase) : null;
  if (sourceAssetsPath && (targetRoot === sourceAssetsPath || targetRoot.startsWith(`${sourceAssetsPath}${path.sep}`))) {
    throw new Error('不能将文档保存到它自身的托管图片目录');
  }
  const targetReviewPath = path.join(targetRoot, `${targetBase}.REVIEW.md`);
  const targetAssetsPath = path.join(targetRoot, 'assets', targetBase);
  const shouldWriteReview = !!payload?.writeReview;
  const reviewContent = desktopTransactionReviewContent(
    payload?.reviewContent,
    targetName,
    payload?.targetDocId,
    targetContent
  );
  const stageRoot = await fileSystem.mkdtemp(path.join(targetRoot, '.guanyi-transaction-'));
  const stagedDocument = path.join(stageRoot, targetName);
  const stagedReview = path.join(stageRoot, `${targetBase}.REVIEW.md`);
  const stagedAssets = path.join(stageRoot, 'assets');
  const targetBackups = [];
  const sourceBackups = [];
  let sourceRemoved = false;
  let targetDocumentInstalled = false;
  let targetReviewInstalled = false;
  let targetAssetsInstalled = false;
  let rollbackComplete = true;

  const backupTarget = async (entryPath, backupName) => {
    if (!await pathExists(fileSystem, entryPath)) return;
    const backupPath = path.join(stageRoot, backupName);
    await fileSystem.rename(entryPath, backupPath);
    targetBackups.push([entryPath, backupPath]);
  };
  const backupSource = async (entryPath, backupName) => {
    if (!entryPath || !await pathExists(fileSystem, entryPath)) return;
    const backupPath = path.join(stageRoot, backupName);
    await copyDesktopEntry(fileSystem, entryPath, backupPath);
    sourceBackups.push([entryPath, backupPath]);
  };

  try {
    await fileSystem.writeFile(stagedDocument, targetContent, 'utf8');
    if (shouldWriteReview && reviewContent) await fileSystem.writeFile(stagedReview, reviewContent, 'utf8');
    if (sourceAssetsPath) await copyDesktopEntry(fileSystem, sourceAssetsPath, stagedAssets);
    if ((await fileSystem.readFile(stagedDocument, 'utf8')) !== targetContent) throw new Error('目标文件写入后校验失败');

    await backupTarget(targetPath, 'target-document.backup');
    await backupTarget(targetReviewPath, 'target-review.backup');
    await backupTarget(targetAssetsPath, 'target-assets.backup');
    await fileSystem.rename(stagedDocument, targetPath);
    targetDocumentInstalled = true;
    if (await pathExists(fileSystem, stagedReview)) {
      await fileSystem.rename(stagedReview, targetReviewPath);
      targetReviewInstalled = true;
    }
    if (await pathExists(fileSystem, stagedAssets)) {
      await fileSystem.mkdir(path.dirname(targetAssetsPath), { recursive: true });
      await fileSystem.rename(stagedAssets, targetAssetsPath);
      targetAssetsInstalled = true;
    }

    if (mode === 'move' && sourcePath) {
      await backupSource(sourcePath, 'source-document.backup');
      await backupSource(sourceReviewPath, 'source-review.backup');
      await backupSource(sourceAssetsPath, 'source-assets.backup');
      sourceRemoved = true;
      await removeDesktopEntry(fileSystem, sourcePath);
      await removeDesktopEntry(fileSystem, sourceReviewPath);
      await removeDesktopEntry(fileSystem, sourceAssetsPath);
    }

    const stats = await fileSystem.stat(targetPath);
    return {
      canceled: false,
      mode,
      path: targetPath,
      name: targetName,
      directoryPath: targetRoot,
      directoryName: path.basename(targetRoot) || targetRoot,
      size: stats.size,
      lastModified: stats.mtimeMs,
      storageKind: 'external',
      content: targetContent
    };
  } catch (error) {
    const restore = async (task) => {
      try { await task(); }
      catch (_restoreError) { rollbackComplete = false; }
    };
    if (targetDocumentInstalled) await restore(() => removeDesktopEntry(fileSystem, targetPath));
    if (targetReviewInstalled) await restore(() => removeDesktopEntry(fileSystem, targetReviewPath));
    if (targetAssetsInstalled) await restore(() => removeDesktopEntry(fileSystem, targetAssetsPath));
    for (const [entryPath, backupPath] of targetBackups.reverse()) {
      await restore(() => fileSystem.rename(backupPath, entryPath));
    }
    if (sourceRemoved) {
      for (const [entryPath, backupPath] of sourceBackups) {
        await restore(async () => {
          await removeDesktopEntry(fileSystem, entryPath);
          await copyDesktopEntry(fileSystem, backupPath, entryPath);
        });
      }
    }
    const detail = rollbackComplete ? '原位置没有变化' : `恢复未完成，备份已保留在 ${stageRoot}`;
    const failure = new Error(`${error?.message || '文件操作失败'}；${detail}`);
    failure.cause = error;
    throw failure;
  } finally {
    if (rollbackComplete) await removeDesktopEntry(fileSystem, stageRoot).catch(() => {});
  }
}

function installDesktopFileHandlers() {
  ipcMain.handle('guanyi-files:choose', async (event) => {
    trustedRenderer(event);
    const result = await runNativePicker(() => dialog.showOpenDialog(mainWindow, {
      title: '打开本地文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文档', extensions: ['md', 'markdown', 'txt', 'pdf', 'epub'] },
        { name: 'Markdown 与文本', extensions: ['md', 'markdown', 'txt'] },
        { name: 'PDF 文档', extensions: ['pdf'] },
        { name: 'EPUB 电子书', extensions: ['epub'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }));
    return result.canceled ? [] : normalizedOpenPaths(result.filePaths);
  });
  ipcMain.handle('guanyi-files:save-as', async (event, payload) => {
    trustedRenderer(event);
    return runNativePicker(() => saveDesktopFileAs(payload));
  });
  ipcMain.handle('guanyi-files:save-binary-as', async (event, payload) => {
    trustedRenderer(event);
    return runNativePicker(() => saveBinaryDocumentAs(payload, { dialogApi: dialog, window: mainWindow }));
  });
  ipcMain.handle('guanyi-files:cache-binary', async (event, payload) => {
    trustedRenderer(event);
    return cacheBinaryDocument(app.getPath('userData'), payload?.id, payload?.bytes);
  });
  ipcMain.handle('guanyi-files:read-cached-binary', async (event, id) => {
    trustedRenderer(event);
    return readCachedBinaryDocument(app.getPath('userData'), id);
  });
  ipcMain.handle('guanyi-files:transaction', async (event, payload) => {
    trustedRenderer(event);
    return performDesktopFileTransaction(payload);
  });
  ipcMain.handle('guanyi-files:create-managed', async (event, payload) => {
    trustedRenderer(event);
    return createManagedDesktopFile(payload);
  });
  ipcMain.handle('guanyi-files:read', async (event, rawPaths) => {
    trustedRenderer(event);
    const paths = normalizedOpenPaths(rawPaths);
    return Promise.all(paths.map(async (filePath) => {
      try { return await readDesktopFile(filePath); }
      catch (error) { return { path: filePath, name: path.basename(filePath), error: error.message || '读取失败' }; }
    }));
  });
  ipcMain.handle('guanyi-files:read-asset', async (event, payload) => {
    trustedRenderer(event);
    const filePath = desktopAssetPath(payload?.documentPath, payload?.source);
    const record = await readDesktopFile(filePath);
    return { ...record, mime: desktopImageMime(filePath) };
  });
  ipcMain.handle('guanyi-files:write', async (event, payload) => {
    trustedRenderer(event);
    const filePath = normalizedOpenPath(payload?.filePath);
    if (!filePath || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      throw new Error('只能写入 Markdown 或 TXT 文件');
    }
    const content = String(payload?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > DESKTOP_MAX_FILE_SIZE) throw new Error('文件超过 20 MB');
    await fs.promises.writeFile(filePath, content, 'utf8');
    const stats = await fs.promises.stat(filePath);
    return { path: filePath, size: stats.size, lastModified: stats.mtimeMs };
  });
  ipcMain.handle('guanyi-files:stat', async (event, rawPath) => {
    trustedRenderer(event);
    const filePath = normalizedOpenPath(rawPath);
    if (!filePath) throw new Error('不支持的文档路径');
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error('目标不是文件');
    return { path: filePath, size: stats.size, lastModified: stats.mtimeMs };
  });
  ipcMain.handle('guanyi-files:show-in-folder', async (event, rawPath) => {
    trustedRenderer(event);
    return showDesktopFileInFolder(rawPath);
  });
  ipcMain.handle('guanyi-files:rename', async (event, payload) => {
    trustedRenderer(event);
    const oldPath = normalizedOpenPath(payload?.filePath);
    const nextName = path.basename(String(payload?.nextName || ''));
    if (!oldPath || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(oldPath).toLowerCase())
      || !nextName || nextName !== String(payload?.nextName || '') || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(nextName).toLowerCase())) {
      throw new Error('新文件名无效');
    }
    const nextPath = path.join(path.dirname(oldPath), nextName);
    try { await fs.promises.access(nextPath); throw new Error(`文件夹中已存在「${nextName}」`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fs.promises.rename(oldPath, nextPath);
    const stats = await fs.promises.stat(nextPath);
    return { path: nextPath, name: nextName, size: stats.size, lastModified: stats.mtimeMs };
  });
  ipcMain.handle('guanyi-files:read-sibling', async (event, payload) => {
    trustedRenderer(event);
    const documentPath = normalizedOpenPath(payload?.documentPath);
    const name = path.basename(String(payload?.name || ''));
    if (!documentPath || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(documentPath).toLowerCase())
      || !name || name !== String(payload?.name || '')) throw new Error('伴随文件名无效');
    const siblingPath = path.join(path.dirname(documentPath), name);
    try { return { exists: true, content: await fs.promises.readFile(siblingPath, 'utf8') }; }
    catch (error) { if (error?.code === 'ENOENT') return { exists: false, content: '' }; throw error; }
  });
  ipcMain.handle('guanyi-files:write-sibling', async (event, payload) => {
    trustedRenderer(event);
    const documentPath = normalizedOpenPath(payload?.documentPath);
    const name = path.basename(String(payload?.name || ''));
    if (!documentPath || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(documentPath).toLowerCase())
      || !name || name !== String(payload?.name || '')
      || BINARY_DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error('伴随文件名无效');
    const content = String(payload?.content ?? '');
    await fs.promises.writeFile(path.join(path.dirname(documentPath), name), content, 'utf8');
    return { name, size: Buffer.byteLength(content, 'utf8') };
  });
}

function installDesktopDirectoryHandlers() {
  ipcMain.handle('guanyi-directories:choose', async (event, options) => {
    trustedRenderer(event);
    const result = await runNativePicker(() => dialog.showOpenDialog(mainWindow, {
      title: options?.title || '添加文档目录',
      defaultPath: typeof options?.defaultPath === 'string' ? options.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    }));
    if (result.canceled || !result.filePaths[0]) return null;
    return inspectDesktopDirectory(result.filePaths[0]);
  });
  ipcMain.handle('guanyi-directories:inspect', async (event, rootPath) => {
    trustedRenderer(event);
    return inspectDesktopDirectory(rootPath);
  });
  ipcMain.handle('guanyi-directories:scan', async (event, rootPath) => {
    trustedRenderer(event);
    return scanDesktopDirectory(rootPath);
  });
  ipcMain.handle('guanyi-directories:read', async (event, payload) => {
    trustedRenderer(event);
    const filePath = safeDirectoryEntryPath(payload?.rootPath, payload?.relativePath);
    return readDesktopFile(filePath);
  });
  ipcMain.handle('guanyi-directories:rename', async (event, payload) => {
    trustedRenderer(event);
    const oldPath = safeDirectoryEntryPath(payload?.rootPath, payload?.relativePath);
    const nextPath = safeDirectoryEntryPath(payload?.rootPath, payload?.nextRelativePath);
    if (!DESKTOP_OPEN_EXTENSIONS.has(path.extname(oldPath).toLowerCase())
      || !DESKTOP_OPEN_EXTENSIONS.has(path.extname(nextPath).toLowerCase())
      || path.dirname(oldPath) !== path.dirname(nextPath)) throw new Error('只能在原文件夹内重命名文档');
    try { await fs.promises.access(nextPath); throw new Error(`文件夹中已存在「${path.basename(nextPath)}」`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await fs.promises.rename(oldPath, nextPath);
    const stats = await fs.promises.stat(nextPath);
    return {
      path: nextPath,
      relativePath: relativeDirectoryPath(path.relative(path.resolve(payload.rootPath), nextPath)),
      fileName: path.basename(nextPath),
      size: stats.size,
      lastModified: stats.mtimeMs
    };
  });
  ipcMain.handle('guanyi-directories:store-asset', async (event, payload) => {
    trustedRenderer(event);
    const root = await inspectDesktopDirectory(payload?.rootPath);
    const documentPath = safeDirectoryEntryPath(root.path, payload?.documentRelativePath);
    if (!DESKTOP_OPEN_EXTENSIONS.has(path.extname(documentPath).toLowerCase())) throw new Error('目标文档无效');
    const extension = path.extname(String(payload?.fileName || '')).toLowerCase();
    if (!DESKTOP_IMAGE_EXTENSIONS.has(extension)) throw new Error('不支持的图片格式');
    const bytes = Buffer.from(payload?.bytes || []);
    if (!bytes.length || bytes.length > DESKTOP_MAX_FILE_SIZE) throw new Error('图片为空或超过 20 MB');
    const documentBase = path.basename(documentPath, path.extname(documentPath)).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || '图片';
    const assetsDirectory = path.join(path.dirname(documentPath), 'assets', documentBase);
    await fs.promises.mkdir(assetsDirectory, { recursive: true });
    const requestedBase = path.basename(String(payload.fileName || '图片'), extension).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || '图片';
    let fileName = `${requestedBase}${extension}`, index = 1;
    while (true) {
      try { await fs.promises.access(path.join(assetsDirectory, fileName)); index += 1; fileName = `${requestedBase}-${index}${extension}`; }
      catch (error) { if (error?.code === 'ENOENT') break; throw error; }
    }
    const filePath = path.join(assetsDirectory, fileName);
    await fs.promises.writeFile(filePath, bytes);
    const source = relativeDirectoryPath(path.relative(path.dirname(documentPath), filePath));
    return { source, assetPath: filePath };
  });
  ipcMain.handle('guanyi-directories:remove-asset', async (event, assetPath) => {
    trustedRenderer(event);
    const filePath = path.resolve(String(assetPath || ''));
    if (!DESKTOP_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || !filePath.split(path.sep).includes('assets')) {
      throw new Error('资源路径无效');
    }
    await fs.promises.unlink(filePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    return true;
  });
}

function installDesktopStateHandlers() {
  ipcMain.handle('guanyi-state:load', async (event) => {
    trustedRenderer(event);
    return readDesktopState();
  });
  ipcMain.handle('guanyi-state:save', async (event, payload) => {
    trustedRenderer(event);
    stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => saveDesktopState(payload));
    return stateWriteQueue;
  });
}

function installDesktopAppHandlers() {
  ipcMain.handle('guanyi-app:version', async (event) => {
    trustedRenderer(event);
    return app.getVersion();
  });
}

function semanticModelDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', 'bge-small-zh-v1.5')
    : path.join(__dirname, '..', 'models', 'bge-small-zh-v1.5');
}

function meilisearchBinaryPath() {
  const executable = process.platform === 'win32' ? 'meilisearch.exe' : 'meilisearch';
  if (app.isPackaged) return path.join(process.resourcesPath, 'runtime', 'meilisearch', executable);
  const platformDirectory = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'mac-arm64'
    : process.platform === 'win32' && process.arch === 'x64'
      ? 'win-x64'
      : `${process.platform}-${process.arch}`;
  return path.join(__dirname, '..', 'runtime', 'meilisearch', `v${MEILISEARCH_VERSION}`, platformDirectory, executable);
}

function installSemanticSearchHandlers() {
  const searchDataDirectory = path.join(app.getPath('userData'), 'search', 'meilisearch-v4');
  semanticSearch = new SemanticSearchWorkerClient({
    modelDir: semanticModelDirectory(),
    binaryPath: meilisearchBinaryPath(),
    dataDir: searchDataDirectory,
    metadataFile: path.join(searchDataDirectory, 'guanyi-index-metadata.json'),
    logFile: path.join(searchDataDirectory, 'semantic-search.log'),
    resourcesPath: app.isPackaged ? process.resourcesPath : ''
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
    return semanticSearch.search(payload?.query, payload?.limit, payload?.options, progressFor(event));
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

function sendApplicationMenuCommand(command) {
  if (windowClosePreparation || !APPLICATION_MENU_COMMANDS.has(command) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('guanyi:command', command);
}

function configureAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    copyright: '让阅读、摘录与思考留在本地。',
    credits: '支持 Markdown、TXT、PDF 和 EPUB 的本地阅读与批注工具。',
    iconPath: path.join(__dirname, '..', 'build-resources', 'icon-512.png')
  });
}

function guardWindowNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (APP_URL_PROTOCOLS.has(new URL(url).protocol)) return;
    } catch (_error) {
      // Block malformed navigation below.
    }
    event.preventDefault();
    openExternalUrl(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function openHelpWindow(section = 'guide') {
  const allowedSections = new Set(['guide', 'markdown', 'shortcuts', 'search', 'privacy']);
  const target = allowedSections.has(section) ? section : 'guide';
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.loadFile(path.join(__dirname, 'help.html'), { hash: target });
    if (helpWindow.isMinimized()) helpWindow.restore();
    helpWindow.show();
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    title: `${PRODUCT_NAME} 帮助`,
    width: 920,
    height: 720,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#f6f4f1',
    icon: path.join(__dirname, '..', 'build-resources', 'icon-512.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  guardWindowNavigation(helpWindow);
  helpWindow.once('ready-to-show', () => helpWindow?.show());
  helpWindow.on('closed', () => { helpWindow = null; });
  helpWindow.loadFile(path.join(__dirname, 'help.html'), { hash: target });
}

async function openDiagnosticLogFolder() {
  const logDirectory = path.join(app.getPath('userData'), 'search', 'meilisearch-v4');
  try {
    await fs.promises.mkdir(logDirectory, { recursive: true });
    const error = await shell.openPath(logDirectory);
    if (error) throw new Error(error);
  } catch (error) {
    dialog.showErrorBox('无法打开诊断日志', error?.message || '日志文件夹不可用');
  }
}

function installApplicationMenu() {
  const template = buildApplicationMenuTemplate({
    platform: process.platform,
    productName: PRODUCT_NAME,
    actions: {
      command: sendApplicationMenuCommand,
      help: openHelpWindow,
      diagnostics: openDiagnosticLogFolder
    }
  });
  applicationMenu = Menu.buildFromTemplate(template);
  updateApplicationMenuState(applicationMenu, {});
  Menu.setApplicationMenu(applicationMenu);
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#f6f4f1',
    icon: path.join(__dirname, '..', 'build-resources', 'icon-512.png'),
    // The renderer owns the tab strip in the titlebar safe area; native traffic lights remain visible.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 13 }
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    flushPendingOpenPaths();
  });
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
  const window = mainWindow;
  window.on('close', (event) => {
    if (quitPrepared || preparedWindows.has(window)) return;
    event.preventDefault();
    void prepareNativeClose(window);
  });

  guardWindowNavigation(mainWindow);

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
    configureAboutPanel();
    installApplicationMenu();
    installSemanticSearchHandlers();
    installDesktopFileHandlers();
    installDesktopDirectoryHandlers();
    installDesktopStateHandlers();
    installDesktopAppHandlers();
    installDesktopAiHandlers(ipcMain, trustedRenderer);
    ipcMain.on('guanyi-menu:state', (event, state) => {
      try { trustedRenderer(event); }
      catch (_error) { return; }
      updateApplicationMenuState(applicationMenu, state);
    });
    createWindow();
    queueOpenPaths(process.argv.slice(1));
    app.on('activate', showMainWindow);
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenPaths([filePath]);
  });

  app.on('second-instance', (_event, commandLine) => {
    queueOpenPaths(commandLine.slice(1));
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitPrepared) return;
    event.preventDefault();
    quitRequested = true;
    void prepareNativeClose(mainWindow);
  });
}
