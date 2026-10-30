import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const main = read('desktop/main.cjs');
const preload = read('desktop/preload.cjs');
const app = read('js/app.js');
const css = read('css/app.css');
const index = read('index.html');
const packageJson = JSON.parse(read('package.json'));

for (const marker of [
  "app.on('open-file'",
  "app.on('second-instance'",
  "guanyi:open-files",
  "guanyi-files:choose",
  "guanyi-files:save-as",
  "guanyi-files:transaction",
  "guanyi-files:create-managed",
  "guanyi-files:read",
  "guanyi-files:read-asset",
  "guanyi-files:write",
  "guanyi-files:stat",
  "guanyi-files:show-in-folder",
  "guanyi-files:rename",
  'runNativePicker',
  'performDesktopFileTransaction',
  '20 * 1024 * 1024'
]) assert.ok(main.includes(marker), `desktop/main.cjs 缺少 ${marker}`);

for (const marker of ['choose', 'saveAs', 'transaction', 'createManaged', 'onOpen', 'queuedOpenFiles', 'readAsset', 'write', 'stat', 'showInFolder', 'rename']) {
  assert.match(preload, new RegExp(marker), `desktop/preload.cjs 缺少 ${marker}`);
}

for (const marker of ['desktopFileApi', 'desktopApi.choose', 'desktopApi.saveAs', 'desktop-save-as', 'desktopImportMatch', 'shouldKeepDesktopLocalEdit', 'keepLocalEdit', 'importDesktopFiles', 'bindDesktopFileOpen', 'desktopPath', 'guanyiDesktop.files.write', 'showDocMenu', 'showInFolder']) {
  assert.ok(app.includes(marker), `js/app.js 缺少 ${marker}`);
}

const createDocStart = app.indexOf('function nextUntitledName(');
const createDocEnd = app.indexOf('\n  // ── 打开本地文档', createDocStart);
assert.notEqual(createDocStart, -1, 'new document helpers should exist');
assert.notEqual(createDocEnd, -1, 'new document helpers should have a stable boundary');
const managedNewDocument = vm.runInNewContext(`(() => {
  const state = { docs: [], openDocIds: [], currentDocId: null };
  const createManagedCalls = [];
  const els = { sourceEditor: { focus() {} } };
  function desktopFileApi() { return { createManaged: async (...args) => {
    createManagedCalls.push(args);
    return { path: '/profile/guanyi-md/documents/未命名文档.md', name: '未命名文档.md', size: 0, lastModified: 3000, storageKind: 'managed' };
  } }; }
  function safeFileName(value) { return value; }
  function attachDesktopSavedFile(doc, saved) {
    doc.desktopPath = saved.path; doc.localFileName = saved.name; doc.sourceKind = 'local-file'; doc.storageKind = saved.storageKind;
  }
  function markSemanticIndexDirty() {}
  function ensureDocOpen(docId) { if (!state.openDocIds.includes(docId)) state.openDocIds.push(docId); }
  function touchDoc(doc) { doc.lastOpenedAt = 1; }
  function ensureHistory() { return {}; }
  function resetHistoryCoalescing() {}
  function syncSourceToDOM() {}
  function saveState() {}
  function renderDocList() {}
  function revealDoc() {}
  function render() {}
  function updateEditChrome() {}
  function tip() {}
  ${app.slice(createDocStart, createDocEnd)}
  return { state, createManagedCalls, createDoc };
})()`, { console: { warn() {} }, Math, Date });
await managedNewDocument.createDoc();
assert.equal(managedNewDocument.state.docs.length, 1);
assert.deepEqual([...managedNewDocument.state.openDocIds], [managedNewDocument.state.docs[0].id]);
assert.equal(managedNewDocument.state.docs[0].sourceKind, 'local-file');
assert.equal(managedNewDocument.state.docs[0].storageKind, 'managed');
assert.equal(managedNewDocument.state.docs[0].desktopPath, '/profile/guanyi-md/documents/未命名文档.md');
assert.deepEqual(JSON.parse(JSON.stringify(managedNewDocument.createManagedCalls)), [['未命名文档.md', '']]);

const importHelpersStart = app.indexOf('function desktopImportMatch(');
const importHelpersEnd = app.indexOf('\n  async function importDesktopFiles', importHelpersStart);
assert.notEqual(importHelpersStart, -1, 'desktopImportMatch should exist');
assert.notEqual(importHelpersEnd, -1, 'desktop import helpers should end before importDesktopFiles');
const { desktopImportMatch, shouldKeepDesktopLocalEdit } = vm.runInNewContext(
  `(() => { ${app.slice(importHelpersStart, importHelpersEnd)}; return { desktopImportMatch, shouldKeepDesktopLocalEdit }; })()`
);

const current = { id: 'current', sourceKind: 'local-file', localFileName: '当前.md', desktopPath: '/docs/当前.md' };
const legacy = { id: 'legacy', sourceKind: 'local-file', localFileName: '旧文档.md', desktopPath: null };
assert.equal(desktopImportMatch([current, legacy], '/docs/当前.md', '当前.md').id, 'current');
assert.equal(desktopImportMatch([current, legacy], '/new/旧文档.md', '旧文档.md').id, 'legacy');
assert.equal(desktopImportMatch([legacy, { ...legacy, id: 'duplicate' }], '/new/旧文档.md', '旧文档.md'), null,
  'ambiguous legacy names must not attach the wrong file');
assert.equal(shouldKeepDesktopLocalEdit({ content: '应用内编辑', lastSavedContent: '旧内容' }, '磁盘新内容'), true);
assert.equal(shouldKeepDesktopLocalEdit({ content: '磁盘新内容', lastSavedContent: '旧内容' }, '磁盘新内容'), false);

const attachStart = app.indexOf('function desktopFileName(');
const attachEnd = app.indexOf('\n  function desktopImportMatch', attachStart);
assert.notEqual(attachStart, -1, 'desktop saved-file attachment helpers should exist');
assert.notEqual(attachEnd, -1, 'desktop saved-file attachment helpers should have a stable boundary');
const { attachDesktopSavedFile } = vm.runInNewContext(
  `(() => { ${app.slice(attachStart, attachEnd)}; return { attachDesktopSavedFile }; })()`,
  { Date, TextEncoder }
);
const newlySaved = { sourceKind: 'browser', openedWithoutHandle: false, fileHandle: null, directoryHandle: null };
assert.equal(attachDesktopSavedFile(newlySaved, {
  path: '/docs/新建文档.md', name: '新建文档.md', size: 12, lastModified: 1234
}, '新建内容'), '新建文档.md');
assert.deepEqual(JSON.parse(JSON.stringify(newlySaved)), {
  sourceKind: 'local-file', openedWithoutHandle: false, fileHandle: null, directoryHandle: null,
  desktopPath: '/docs/新建文档.md', localFileName: '新建文档.md', syncState: 'synced',
  storageKind: 'external', externalContent: null, externalModifiedAt: 1234, externalSize: 12
});

const saveAsStart = main.indexOf('async function saveDesktopFileAs(');
const saveAsEnd = main.indexOf('\nfunction managedDocumentsDirectory', saveAsStart);
assert.notEqual(saveAsStart, -1, 'desktop Save As implementation should exist');
assert.notEqual(saveAsEnd, -1, 'desktop Save As implementation should end before managed storage helpers');
const saveWrites = [];
const saveDialogCalls = [];
const saveDesktopFileAs = vm.runInNewContext(
  `(${main.slice(saveAsStart, saveAsEnd)})`,
  {
    Buffer,
    path,
    DESKTOP_MAX_FILE_SIZE: 20 * 1024 * 1024,
    DESKTOP_OPEN_EXTENSIONS: new Set(['.md', '.markdown', '.txt']),
    normalizedOpenPath: (value) => value,
    dialog: null,
    fs: null,
    mainWindow: null
  }
);
const savedRecord = await saveDesktopFileAs({ suggestedName: '新建文档.md', content: '保存后插图' }, {
  window: {},
  dialogApi: { showSaveDialog: async (_window, options) => {
    saveDialogCalls.push(options);
    return { canceled: false, filePath: '/docs/保存后插图.md' };
  } },
  fileSystem: {
    writeFile: async (...args) => saveWrites.push(args),
    stat: async () => ({ size: 15, mtimeMs: 5678 })
  }
});
assert.deepEqual(JSON.parse(JSON.stringify(savedRecord)), {
  canceled: false, path: '/docs/保存后插图.md', name: '保存后插图.md', size: 15, lastModified: 5678,
  storageKind: 'external'
});
assert.deepEqual(saveWrites, [['/docs/保存后插图.md', '保存后插图', 'utf8']]);
assert.equal(saveDialogCalls[0].defaultPath, '新建文档.md');
assert.deepEqual(
  JSON.parse(JSON.stringify(await saveDesktopFileAs({ suggestedName: '取消.md', content: '' }, {
    dialogApi: { showSaveDialog: async () => ({ canceled: true }) }, fileSystem: {}
  }))),
  { canceled: true },
  'canceling Save As must not create a file identity'
);

const managedStart = main.indexOf('function managedDocumentsDirectory(');
const managedEnd = main.indexOf('\nasync function showDesktopFileInFolder', managedStart);
assert.notEqual(managedStart, -1, 'managed document storage helpers should exist');
assert.notEqual(managedEnd, -1, 'managed document storage helpers should have a stable boundary');
const { managedDocumentsDirectory, managedDocumentFileName, createManagedDesktopFile } = vm.runInNewContext(
  `(() => { ${main.slice(managedStart, managedEnd)}; return { managedDocumentsDirectory, managedDocumentFileName, createManagedDesktopFile }; })()`,
  {
    app: { getPath: () => '/unused-profile' },
    Buffer,
    path,
    fs: null,
    DESKTOP_MAX_FILE_SIZE: 20 * 1024 * 1024,
    DESKTOP_OPEN_EXTENSIONS: new Set(['.md', '.markdown', '.txt'])
  }
);
assert.equal(managedDocumentsDirectory({ userDataPath: '/profile/guanyi-md' }), '/profile/guanyi-md/documents');
assert.deepEqual(JSON.parse(JSON.stringify(managedDocumentFileName('../风险:文档.txt'))), { stem: '风险_文档', extension: '.txt' });
assert.deepEqual(JSON.parse(JSON.stringify(managedDocumentFileName('CON.md'))), { stem: '_CON', extension: '.md' });
assert.deepEqual(JSON.parse(JSON.stringify(managedDocumentFileName('草稿.exe'))), { stem: '草稿', extension: '.md' });

const managedWrites = [];
const managedDirectories = [];
const managedRecord = await createManagedDesktopFile({ suggestedName: '未命名文档.md', content: '默认本地内容' }, {
  userDataPath: '/profile/guanyi-md',
  fileSystem: {
    mkdir: async (...args) => managedDirectories.push(args),
    writeFile: async (...args) => {
      managedWrites.push(args);
      if (managedWrites.length === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
    stat: async () => ({ size: 21, mtimeMs: 2468 })
  }
});
assert.deepEqual(JSON.parse(JSON.stringify(managedDirectories)), [['/profile/guanyi-md/documents', { recursive: true }]]);
assert.equal(managedWrites[0][0], '/profile/guanyi-md/documents/未命名文档.md');
assert.equal(managedWrites[1][0], '/profile/guanyi-md/documents/未命名文档-2.md');
assert.deepEqual(JSON.parse(JSON.stringify(managedWrites[1].slice(1))), ['默认本地内容', { encoding: 'utf8', flag: 'wx' }]);
assert.deepEqual(JSON.parse(JSON.stringify(managedRecord)), {
  canceled: false,
  path: '/profile/guanyi-md/documents/未命名文档-2.md',
  name: '未命名文档-2.md',
  size: 21,
  lastModified: 2468,
  storageKind: 'managed'
});
await assert.rejects(
  createManagedDesktopFile({ suggestedName: 'oversized.md', content: 'x'.repeat(20 * 1024 * 1024 + 1) }, {
    userDataPath: '/profile/guanyi-md', fileSystem: {}
  }),
  /20 MB/
);

const revealStart = main.indexOf('async function showDesktopFileInFolder(');
const revealEnd = main.indexOf('\nasync function pathExists', revealStart);
assert.notEqual(revealStart, -1, 'desktop reveal implementation should exist');
assert.notEqual(revealEnd, -1, 'desktop reveal implementation should have a stable boundary');
const showDesktopFileInFolder = vm.runInNewContext(
  `(${main.slice(revealStart, revealEnd)})`,
  { normalizedOpenPath: (value) => value === '/docs/文档.md' ? value : null, fs: null, shell: null }
);
const revealedPaths = [];
assert.deepEqual(
  JSON.parse(JSON.stringify(await showDesktopFileInFolder('/docs/文档.md', {
    fileSystem: { stat: async () => ({ isFile: () => true }) },
    shellApi: { showItemInFolder: (value) => revealedPaths.push(value) }
  }))),
  { path: '/docs/文档.md' }
);
assert.deepEqual(revealedPaths, ['/docs/文档.md']);
await assert.rejects(
  showDesktopFileInFolder('/docs/文档.md', {
    fileSystem: { stat: async () => ({ isFile: () => false }) },
    shellApi: { showItemInFolder: () => { throw new Error('must not reveal a directory'); } }
  }),
  /目标不是文件/
);
await assert.rejects(showDesktopFileInFolder('/docs/脚本.exe', {}), /文件路径无效/);

const pickerStart = main.indexOf('let nativePickerActive = false;');
const pickerEnd = main.indexOf('\nfunction normalizedOpenPath', pickerStart);
assert.notEqual(pickerStart, -1, 'native picker lock should exist');
assert.notEqual(pickerEnd, -1, 'native picker lock should have a stable boundary');
const { runNativePicker } = vm.runInNewContext(`(() => {
  ${main.slice(pickerStart, pickerEnd)}
  return { runNativePicker };
})()`);
let releasePicker;
const activePicker = runNativePicker(() => new Promise((resolve) => { releasePicker = resolve; }));
await Promise.resolve();
await assert.rejects(
  runNativePicker(async () => 'duplicate'),
  (error) => error?.code === 'NATIVE_PICKER_ACTIVE' && /文件选择窗口已打开/.test(error.message),
  'only one OS file picker may be active at a time'
);
releasePicker('done');
assert.equal(await activePicker, 'done');
assert.equal(await runNativePicker(async () => 'reopened'), 'reopened', 'picker cancellation/completion must release the lock');

const transactionStart = main.indexOf('async function pathExists(');
const transactionEnd = main.indexOf('\nfunction installDesktopFileHandlers', transactionStart);
assert.notEqual(transactionStart, -1, 'desktop transaction helpers should exist');
assert.notEqual(transactionEnd, -1, 'desktop transaction helpers should have a stable boundary');
const { performDesktopFileTransaction } = vm.runInNewContext(`(() => {
  ${main.slice(transactionStart, transactionEnd)}
  return { performDesktopFileTransaction };
})()`, {
  Buffer,
  fs,
  path,
  DESKTOP_MAX_FILE_SIZE: 20 * 1024 * 1024,
  DESKTOP_OPEN_EXTENSIONS: new Set(['.md', '.markdown', '.txt']),
  normalizedOpenPath: (value) => {
    const resolved = path.resolve(String(value || ''));
    return ['.md', '.markdown', '.txt'].includes(path.extname(resolved).toLowerCase()) ? resolved : null;
  },
  safeDirectoryEntryPath: (rootPath, relativePath) => {
    const root = path.resolve(String(rootPath || ''));
    const relative = String(relativePath || '').replace(/\\/g, '/');
    if (!rootPath || !relative || path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('目录内路径无效');
    }
    const candidate = path.resolve(root, ...relative.split('/'));
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('路径超出已添加目录');
    return candidate;
  }
});

const transactionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guanyi-desktop-transaction-'));
const sourceRoot = path.join(transactionRoot, 'source');
const targetRoot = path.join(transactionRoot, 'target');
fs.mkdirSync(path.join(sourceRoot, 'assets', 'book'), { recursive: true });
fs.mkdirSync(targetRoot, { recursive: true });
const sourceBook = path.join(sourceRoot, 'book.md');
fs.writeFileSync(sourceBook, 'source-on-disk', 'utf8');
fs.writeFileSync(path.join(sourceRoot, 'book.REVIEW.md'), 'source-review', 'utf8');
fs.writeFileSync(path.join(sourceRoot, 'assets', 'book', 'cover.png'), 'image', 'utf8');
const reviewTemplate = [
  '# 文档协作任务',
  '- 目标文件：book.md',
  '- 文档标识：source-id',
  '- 文档版本：fnv1a32:00000000'
].join('\n');

try {
  const savedCopy = await performDesktopFileTransaction({
    mode: 'save-as',
    sourcePath: sourceBook,
    targetRootPath: targetRoot,
    fileName: 'copy.md',
    content: '![cover](assets/book/cover.png)',
    targetDocId: 'copy-id',
    writeReview: true,
    reviewContent: reviewTemplate,
    conflict: 'keep-both'
  });
  assert.equal(savedCopy.name, 'copy.md');
  assert.equal(savedCopy.content, '![cover](assets/copy/cover.png)');
  assert.equal(fs.readFileSync(savedCopy.path, 'utf8'), savedCopy.content);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', 'copy', 'cover.png'), 'utf8'), 'image');
  const savedReview = fs.readFileSync(path.join(targetRoot, 'copy.REVIEW.md'), 'utf8');
  assert.match(savedReview, /- 目标文件：copy\.md/);
  assert.match(savedReview, /- 文档标识：copy-id/);
  assert.doesNotMatch(savedReview, /fnv1a32:00000000/);
  assert.equal(fs.readFileSync(sourceBook, 'utf8'), 'source-on-disk', 'save-as must preserve the original file');

  const keptCopy = await performDesktopFileTransaction({
    mode: 'save-as', sourcePath: sourceBook, targetRootPath: targetRoot, fileName: 'copy.md',
    content: '![cover](assets/book/cover.png)', targetDocId: 'copy-2-id', writeReview: true,
    reviewContent: reviewTemplate, conflict: 'keep-both'
  });
  assert.equal(keptCopy.name, 'copy 2.md');
  assert.equal(keptCopy.content, '![cover](assets/copy%202/cover.png)');
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', 'copy 2', 'cover.png'), 'utf8'), 'image');

  const replacePath = path.join(targetRoot, 'replace.md');
  fs.mkdirSync(path.join(targetRoot, 'assets', 'replace'), { recursive: true });
  fs.writeFileSync(replacePath, 'old-target', 'utf8');
  fs.writeFileSync(path.join(targetRoot, 'replace.REVIEW.md'), 'old-review', 'utf8');
  fs.writeFileSync(path.join(targetRoot, 'assets', 'replace', 'old.png'), 'old-image', 'utf8');
  await performDesktopFileTransaction({
    mode: 'save-as', sourcePath: sourceBook, targetRootPath: targetRoot, fileName: 'replace.md',
    content: 'new-target', targetDocId: 'replace-id', writeReview: false, reviewContent: '', conflict: 'replace'
  });
  assert.equal(fs.readFileSync(replacePath, 'utf8'), 'new-target');
  assert.equal(fs.existsSync(path.join(targetRoot, 'replace.REVIEW.md')), false, 'replace without review copy must remove stale target review');
  assert.equal(fs.existsSync(path.join(targetRoot, 'assets', 'replace', 'old.png')), false, 'replace must not retain stale target assets');
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', 'replace', 'cover.png'), 'utf8'), 'image');

  const moveSourceRoot = path.join(transactionRoot, 'move-source');
  fs.mkdirSync(path.join(moveSourceRoot, 'assets', 'move-me'), { recursive: true });
  const moveSource = path.join(moveSourceRoot, 'move-me.md');
  fs.writeFileSync(moveSource, 'move-source', 'utf8');
  fs.writeFileSync(path.join(moveSourceRoot, 'move-me.REVIEW.md'), 'move-review', 'utf8');
  fs.writeFileSync(path.join(moveSourceRoot, 'assets', 'move-me', 'move.png'), 'move-image', 'utf8');
  const moved = await performDesktopFileTransaction({
    mode: 'move', sourcePath: moveSource, targetRootPath: targetRoot, fileName: 'moved.md',
    content: '![move](assets/move-me/move.png)', targetDocId: 'move-id', writeReview: true,
    reviewContent: reviewTemplate, conflict: 'keep-both'
  });
  assert.equal(fs.existsSync(moveSource), false);
  assert.equal(fs.existsSync(path.join(moveSourceRoot, 'move-me.REVIEW.md')), false);
  assert.equal(fs.existsSync(path.join(moveSourceRoot, 'assets', 'move-me')), false);
  assert.equal(fs.readFileSync(moved.path, 'utf8'), '![move](assets/moved/move.png)');
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', 'moved', 'move.png'), 'utf8'), 'move-image');

  const protectedPath = path.join(targetRoot, 'protected.md');
  fs.writeFileSync(protectedPath, 'must-survive-staging-failure', 'utf8');
  const stagingFailureFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'writeFile') return async (filePath, ...args) => {
        if (String(filePath).includes('.guanyi-transaction-') && path.basename(filePath) === 'protected.md') {
          throw new Error('injected staging failure');
        }
        return target.writeFile(filePath, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  await assert.rejects(performDesktopFileTransaction({
    mode: 'save-as', sourcePath: sourceBook, targetRootPath: targetRoot, fileName: 'protected.md',
    content: 'new-content', targetDocId: 'protected-id', writeReview: false, conflict: 'replace'
  }, { fileSystem: stagingFailureFs }), /injected staging failure.*原位置没有变化/);
  assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'must-survive-staging-failure',
    'a failure before installation must never delete the pre-existing target');

  const rollbackSourceRoot = path.join(transactionRoot, 'rollback-source');
  fs.mkdirSync(path.join(rollbackSourceRoot, 'assets', 'rollback'), { recursive: true });
  const rollbackSource = path.join(rollbackSourceRoot, 'rollback.md');
  const rollbackReview = path.join(rollbackSourceRoot, 'rollback.REVIEW.md');
  fs.writeFileSync(rollbackSource, 'rollback-source-content', 'utf8');
  fs.writeFileSync(rollbackReview, 'rollback-source-review', 'utf8');
  fs.writeFileSync(path.join(rollbackSourceRoot, 'assets', 'rollback', 'rollback.png'), 'rollback-image', 'utf8');
  let injectedRemovalFailure = false;
  const removalFailureFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rm') return async (filePath, ...args) => {
        if (!injectedRemovalFailure && filePath === rollbackReview) {
          injectedRemovalFailure = true;
          throw new Error('injected source removal failure');
        }
        return target.rm(filePath, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  await assert.rejects(performDesktopFileTransaction({
    mode: 'move', sourcePath: rollbackSource, targetRootPath: targetRoot, fileName: 'rollback-target.md',
    content: 'rollback-new-content', targetDocId: 'rollback-id', writeReview: true,
    reviewContent: reviewTemplate, conflict: 'replace'
  }, { fileSystem: removalFailureFs }), /injected source removal failure.*原位置没有变化/);
  assert.equal(fs.readFileSync(rollbackSource, 'utf8'), 'rollback-source-content');
  assert.equal(fs.readFileSync(rollbackReview, 'utf8'), 'rollback-source-review');
  assert.equal(fs.readFileSync(path.join(rollbackSourceRoot, 'assets', 'rollback', 'rollback.png'), 'utf8'), 'rollback-image');
  assert.equal(fs.existsSync(path.join(targetRoot, 'rollback-target.md')), false);

  const chineseSource = path.join(sourceRoot, '中文 书稿.md');
  fs.mkdirSync(path.join(sourceRoot, 'assets', '中文 书稿'), { recursive: true });
  fs.writeFileSync(chineseSource, 'original');
  fs.writeFileSync(path.join(sourceRoot, 'assets', '中文 书稿', 'cover.png'), 'chinese-image');
  const chineseCopy = await performDesktopFileTransaction({
    mode: 'save-as', sourcePath: chineseSource, targetRootPath: targetRoot, fileName: '中文 副本.md',
    content: `![cover](assets/${encodeURIComponent('中文 书稿')}/cover.png)`, conflict: 'keep-both'
  });
  assert.equal(chineseCopy.content, `![cover](assets/${encodeURIComponent('中文 副本')}/cover.png)`);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'assets', '中文 副本', 'cover.png'), 'utf8'), 'chinese-image');
  await assert.rejects(performDesktopFileTransaction({
    mode: 'move', sourcePath: path.join(sourceRoot, 'missing.md'), targetRootPath: targetRoot,
    fileName: 'missing-target.md', content: 'must-not-create'
  }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(targetRoot, 'missing-target.md')), false);
  await assert.rejects(performDesktopFileTransaction({
    mode: 'move', sourcePath: chineseSource, targetRootPath: targetRoot,
    fileName: 'conflict-target.md', content: 'stale', expectedModifiedAt: 1, expectedSize: 1
  }), /原文件已被其他程序修改/);
  assert.equal(fs.readFileSync(chineseSource, 'utf8'), 'original');

  const restoreFailureFs = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rm') return async (filePath, ...args) => {
        if (filePath === rollbackReview) throw new Error('injected removal failure');
        return target.rm(filePath, ...args);
      };
      if (property === 'copyFile') return async (from, to, ...args) => {
        if (to === rollbackSource) throw new Error('injected restore failure');
        return target.copyFile(from, to, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  await assert.rejects(performDesktopFileTransaction({
    mode: 'move', sourcePath: rollbackSource, targetRootPath: targetRoot, fileName: 'restore-failure.md',
    content: 'new', conflict: 'keep-both'
  }, { fileSystem: restoreFailureFs }), /恢复未完成，备份已保留/);
  const retainedStage = fs.readdirSync(targetRoot).find((name) => name.startsWith('.guanyi-transaction-'));
  assert.ok(retainedStage, 'incomplete rollback must retain backups');
  assert.equal(fs.readFileSync(path.join(targetRoot, retainedStage, 'source-document.backup'), 'utf8'), 'rollback-source-content');
} finally {
  fs.rmSync(transactionRoot, { recursive: true, force: true });
}

const assetPathStart = main.indexOf('function decodedDesktopAssetSourceParts(');
const assetPathEnd = main.indexOf('\nasync function saveDesktopFileAs', assetPathStart);
assert.notEqual(assetPathStart, -1, 'desktop asset decoding helper should exist');
assert.notEqual(assetPathEnd, -1, 'desktop asset helper should have a stable boundary');
const { desktopAssetPath } = vm.runInNewContext(
  `(() => { ${main.slice(assetPathStart, assetPathEnd)}; return { desktopAssetPath }; })()`,
  { path, DESKTOP_IMAGE_EXTENSIONS: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']) }
);
assert.equal(
  desktopAssetPath('/docs/中秋回川行程安排.md', 'assets/%E4%B8%AD%E7%A7%8B%E5%9B%9E%E5%B7%9D%E8%A1%8C%E7%A8%8B%E5%AE%89%E6%8E%92/image.png'),
  '/docs/assets/中秋回川行程安排/image.png',
  'encoded Chinese asset paths must resolve to the file written beside the document'
);
assert.equal(desktopAssetPath('/docs/note.md', 'assets/My%20Images/image.png'), '/docs/assets/My Images/image.png');
assert.throws(() => desktopAssetPath('/docs/note.md', '%2E%2E/secret.png'), /图片路径无效/);
assert.throws(() => desktopAssetPath('/docs/note.md', 'assets/%2Fsecret.png'), /图片路径无效/);

assert.match(css, /\.editor-source\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word[^}]*\}/s);

for (const marker of ['importDesktopFiles', 'white-space: pre-wrap', 'desktopPath', 'wrap="soft"']) {
  assert.ok(index.includes(marker), `index.html 缺少同步标记 ${marker}`);
}

assert.deepEqual(packageJson.build?.fileAssociations?.[0]?.ext, ['md', 'markdown', 'txt']);
assert.match(main, /async function saveDesktopFileAs[\s\S]+showSaveDialog[\s\S]+writeFile[\s\S]+lastModified/,
  'desktop Save As should persist content and return a reusable file identity');
assert.match(app, /desktopApi\.saveAs\(documentFileName\(doc\), content\)[\s\S]+attachDesktopSavedFile\(doc, saved, content\)/,
  'saving a new desktop document should attach its native path for later image storage');
assert.match(app, /async function createDoc\(\)[\s\S]+desktopApi\.createManaged[\s\S]+attachDesktopSavedFile\(doc, managed, doc\.content\)/,
  'new desktop documents should be materialized in the managed local directory immediately');
assert.match(main, /async function showDesktopFileInFolder[\s\S]+normalizedOpenPath\(rawPath\)[\s\S]+stats\.isFile\(\)[\s\S]+shellApi\.showItemInFolder\(filePath\)/,
  'revealing a document must validate a supported existing file before calling the OS shell');
assert.match(app, /contextmenu[\s\S]+doc\?\.desktopPath[\s\S]+showDocMenu\(event\.clientX, event\.clientY, doc\.id\)/,
  'the document menu should only open for desktop-backed documents');
assert.match(index, /id="doc-menu"[\s\S]+id="doc-menu-open-location"[\s\S]+\u6253\u5f00\u6587\u4ef6\u4f4d\u7f6e/,
  'the synchronized document menu should expose the native reveal action');
console.log('desktop file association/source display contracts: PASS');
