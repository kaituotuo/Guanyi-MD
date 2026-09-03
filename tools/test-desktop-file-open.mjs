import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  "guanyi-files:create-managed",
  "guanyi-files:read",
  "guanyi-files:read-asset",
  "guanyi-files:write",
  "guanyi-files:stat",
  "guanyi-files:show-in-folder",
  "guanyi-files:rename",
  '20 * 1024 * 1024'
]) assert.ok(main.includes(marker), `desktop/main.cjs 缺少 ${marker}`);

for (const marker of ['choose', 'saveAs', 'createManaged', 'onOpen', 'queuedOpenFiles', 'readAsset', 'write', 'stat', 'showInFolder', 'rename']) {
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
const revealEnd = main.indexOf('\nfunction installDesktopFileHandlers', revealStart);
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
