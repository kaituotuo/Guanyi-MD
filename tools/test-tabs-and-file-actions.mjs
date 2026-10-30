import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [appSource, cssSource, indexSource, designSource] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../docs/多页签设置与文件操作研发计划.md', import.meta.url), 'utf8')
]);

const tabStart = appSource.indexOf('  function normalizeSettings(');
const tabEnd = appSource.indexOf('\n\n  function currentDoc()', tabStart);
assert.ok(tabStart >= 0 && tabEnd > tabStart, 'tab and setting normalizers should be extractable');
const tabHelpers = vm.runInNewContext(`(() => {
  const HISTORY_LIMIT = 50;
  const DEFAULT_SETTINGS = { theme: 'light', historyLimit: 50, editorFontSize: 15, editorLineHeight: 1.75, startupView: 'split', defaultSearchScope: 'list', txtIndent: true, txtBlankLines: true };
  const state = { docs: [], openDocIds: [], settings: {} };
  ${appSource.slice(tabStart, tabEnd)}
  return { normalizeSettings, normalizeOpenDocIds };
})()`);

const docs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
assert.deepEqual([...tabHelpers.normalizeOpenDocIds(['a', 'b', 'a', 'missing'], docs, 'c')], ['a', 'b', 'c'],
  'open tabs should stay ordered, unique and include the active document');
assert.deepEqual([...tabHelpers.normalizeOpenDocIds([], docs, null)], ['a'],
  'at least one valid tab should remain open');
assert.equal(tabHelpers.normalizeSettings({ historyLimit: 100, theme: 'dark' }).historyLimit, 100);
assert.equal(tabHelpers.normalizeSettings({ historyLimit: 500 }).historyLimit, 50,
  'unsupported undo limits should fall back to the established 50-step default');

const rewriteStart = appSource.indexOf('  function escapeRegularExpression(');
const rewriteEnd = appSource.indexOf('\n\n  function fileNameWithOriginalExtension', rewriteStart);
assert.ok(rewriteStart >= 0 && rewriteEnd > rewriteStart, 'managed image rewriting helpers should be extractable');
const rewriteHelpers = vm.runInNewContext(`(() => {
  ${appSource.slice(rewriteStart, rewriteEnd)}
  return { rewriteManagedImageSources };
})()`);
assert.equal(
  rewriteHelpers.rewriteManagedImageSources('![a](assets/旧文档/a.png)\n![b](/external/b.png)', '旧文档', '新文档'),
  `![a](assets/${encodeURIComponent('新文档')}/a.png)\n![b](/external/b.png)`,
  'save-as should rewrite only Guanyi-managed image paths'
);
assert.equal(
  rewriteHelpers.rewriteManagedImageSources(`![a](assets/${encodeURIComponent('旧文档')}/a.png)`, '旧文档', '新文档 2'),
  `![a](assets/${encodeURIComponent('新文档 2')}/a.png)`,
  'encoded managed paths must follow the new file name, including spaces'
);
assert.equal(
  rewriteHelpers.rewriteManagedImageSources('![a](assets/book/a.png) ![b](https://example.com/assets/book/a.png)', 'book', '$& 2'),
  '![a](assets/%24%26%202/a.png) ![b](https://example.com/assets/book/a.png)',
  'replacement characters must stay literal and external image paths must remain intact'
);

const nameStart = appSource.indexOf('  function fileNameWithOriginalExtension(');
const nameEnd = appSource.indexOf('\n\n  async function uniqueFileName', nameStart);
assert.ok(nameStart >= 0 && nameEnd > nameStart, 'file naming helper should be extractable');
const nameHelper = vm.runInNewContext(`(() => {
  const fileExtension = () => '.txt';
  const documentFileName = () => 'book.txt';
  const validateFileBaseName = (value) => value ? '' : '文档名称不能为空';
  ${appSource.slice(nameStart, nameEnd)}
  return fileNameWithOriginalExtension;
})()`);
assert.equal(nameHelper('新书', {}), '新书.txt', 'missing extensions should inherit the source format');
assert.throws(() => nameHelper('新书.md', {}), /请保留原文档格式 \.txt/,
  'save-as and move must not silently convert TXT to Markdown');

const desktopPathStart = appSource.indexOf('  function normalizedDesktopPath(');
const desktopPathEnd = appSource.indexOf('\n\n  function newDirectoryRecord', desktopPathStart);
assert.ok(desktopPathStart >= 0 && desktopPathEnd > desktopPathStart, 'desktop path helpers should be extractable');
const desktopPathHelpers = vm.runInNewContext(`(() => {
  const normalizeRelativePath = (value) => String(value || '').replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, '');
  ${appSource.slice(desktopPathStart, desktopPathEnd)}
  return { normalizedDesktopPath, desktopParentPath, desktopPathBaseName, desktopTargetPathKey };
})()`);
assert.equal(desktopPathHelpers.desktopParentPath('/Users/test/Documents/文档.md'), '/Users/test/Documents');
assert.equal(desktopPathHelpers.desktopParentPath('C:\\Users\\test\\Documents\\文档.md'), 'C:/Users/test/Documents');
assert.equal(desktopPathHelpers.desktopParentPath('C:\\文档.md'), 'C:/');
assert.equal(desktopPathHelpers.desktopParentPath('\\\\server\\share\\文档.md'), '//server/share');
assert.equal(desktopPathHelpers.desktopPathBaseName('C:\\Users\\test\\Documents'), 'Documents');
assert.equal(
  desktopPathHelpers.desktopTargetPathKey({ rootPath: 'C:\\Users\\test\\Documents\\', relativePrefix: '书稿\\长篇' }),
  'C:/Users/test/Documents/书稿/长篇'
);

const chooseDirectoryStart = appSource.indexOf('  async function chooseOtherFileActionDirectory(');
const chooseDirectoryEnd = appSource.indexOf('\n\n  async function submitFileAction', chooseDirectoryStart);
assert.ok(chooseDirectoryStart >= 0 && chooseDirectoryEnd > chooseDirectoryStart,
  'file-action directory chooser should be extractable');

function createChooserHarness({ desktopChoose = null, webChoose = null } = {}) {
  const targets = [];
  const classNames = new Set();
  const fileActionState = { mode: 'save-as', docId: 'doc-1', target: null, busy: false, pickerBusy: false };
  const els = {
    btnFileActionOther: { disabled: false },
    fileActionStatus: {
      textContent: '',
      classList: {
        add: (value) => classNames.add(value),
        remove: (value) => classNames.delete(value)
      }
    }
  };
  const harness = vm.runInNewContext(`(() => {
    ${appSource.slice(desktopPathStart, desktopPathEnd)}
    ${appSource.slice(chooseDirectoryStart, chooseDirectoryEnd)}
    return { chooseOtherFileActionDirectory };
  })()`, {
    Date,
    fileActionState,
    els,
    normalizeRelativePath: (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    desktopDirectoryApi: () => desktopChoose ? { choose: desktopChoose } : null,
    ensureReadWritePermission: async () => true,
    setFileActionTarget: (target) => { fileActionState.target = target; targets.push(target); },
    window: { showDirectoryPicker: webChoose }
  });
  return { ...harness, fileActionState, els, targets, classNames };
}

let releaseDesktopPicker;
let desktopPickerCalls = 0;
const chooser = createChooserHarness({
  desktopChoose: async () => {
    desktopPickerCalls += 1;
    if (desktopPickerCalls === 1) return new Promise((resolve) => { releaseDesktopPicker = resolve; });
    return { path: '/Users/test/文稿', name: '文稿' };
  },
  webChoose: async () => { throw new Error('desktop must not call showDirectoryPicker'); }
});
const firstPicker = chooser.chooseOtherFileActionDirectory();
await Promise.resolve();
await chooser.chooseOtherFileActionDirectory();
assert.equal(desktopPickerCalls, 1, 'repeated clicks while the native picker is open must be ignored');
assert.equal(chooser.els.btnFileActionOther.disabled, true, 'the chooser button must be disabled while selecting');
releaseDesktopPicker(null);
await firstPicker;
assert.equal(chooser.fileActionState.pickerBusy, false, 'canceling must release picker state');
assert.equal(chooser.els.btnFileActionOther.disabled, false, 'canceling must re-enable the chooser');
assert.equal(chooser.els.fileActionStatus.textContent, '', 'canceling must clear the selecting status');
await chooser.chooseOtherFileActionDirectory();
assert.equal(desktopPickerCalls, 2, 'the chooser must be reusable after cancellation');
assert.equal(chooser.targets[0].rootPath, '/Users/test/文稿');

let webPickerCalls = 0;
const webHandle = { name: '网页目录' };
const webChooser = createChooserHarness({ webChoose: async () => { webPickerCalls += 1; return webHandle; } });
await webChooser.chooseOtherFileActionDirectory();
assert.equal(webPickerCalls, 1, 'the browser build must retain the File System Access picker');
assert.equal(webChooser.targets[0].handle, webHandle);

assert.match(indexSource, /id="document-tabs"[^>]+role="tablist"/);
assert.match(indexSource, /id="btn-save-more"[^>]+aria-controls="save-menu"/);
assert.match(indexSource, /data-file-command="save-as"[\s\S]+data-file-command="move"[\s\S]+data-file-command="open-location"/);
assert.match(indexSource, /id="file-action-copy-review" checked/,
  'copying review comments should be the save-as default');
assert.match(indexSource, /id="file-action-add-directory" checked/,
  'adding a new target directory to the document list should be the default');
assert.match(indexSource, /name="file-conflict" value="keep-both" checked[\s\S]+value="replace"[\s\S]+value="cancel"/);
assert.match(indexSource, /id="btn-app-menu"[\s\S]+data-app-command="settings"[\s\S]+data-app-command="about"/);
assert.match(appSource, /case 'document\.close-tab': await requestCloseDocumentTab\(state\.currentDocId\); break;/,
  'desktop Command+W should close the active tab through the guarded close workflow');
assert.match(indexSource, /class="app-topbar"[\s\S]+class="app-document-tabs-bar"[\s\S]+id="document-tabs"/, 'document tabs must live in the topbar so desktop can place them in the titlebar safe area');
assert.match(indexSource, /class="app-topbar__identity"[\s\S]+class="app-topbar__brand"[\s\S]+class="app-topbar__tagline"[\s\S]+class="app-document-tabs-bar"/, 'the brand and slogan must precede the first document tab');
assert.doesNotMatch(indexSource, /<main class="app-main">\s*<div class="app-document-tabs-bar"/, 'document tabs must not consume an extra editor-toolbar row');
assert.match(indexSource, /id="btn-app-menu"[\s\S]{0,300}#gicon-more/,
  'the single app entry should use the More icon rather than a settings glyph');

assert.match(appSource, /context\.sourceRemoved = true;[\s\S]+removeEntryIfExists\(sourceDirectory, sourceFileName\)/,
  'move rollback must be armed before the first destructive source deletion');
assert.match(appSource, /writeToFileHandle\(targetHandle, targetContent\)[\s\S]+readFileAsText\(await targetHandle\.getFile\(\)\)[\s\S]+verified !== targetContent/,
  'the target document should be read back and verified before source removal');
assert.match(appSource, /options\.mode === 'save-as' && sameSourceAndTargetDirectory && sourceFileName === targetFileName[\s\S]+\u53e6存为不能替换原文件/,
  'save-as must never replace the source file that it promises to preserve');
assert.match(appSource, /rollbackFileTransaction\(context\)[\s\S]+原位置没有变化/,
  'failed transactions should roll back and explicitly preserve the original location');
assert.match(appSource, /sourceDirectoryPromise = selectParentDirectory\(doc\)[\s\S]+sourceDirectoryPromise \? await sourceDirectoryPromise[\s\S]+executeWebFileTransaction/,
  'moving a directly opened web file should request its parent directory inside the submit gesture');
assert.match(appSource, /const fileActionState = \{[^}]*pickerBusy:\s*false[^}]*\}/,
  'file actions must keep a dedicated directory-picker lock');
assert.match(appSource, /async function chooseOtherFileActionDirectory[\s\S]+desktopApi\.choose\([\s\S]+window\.showDirectoryPicker/,
  'desktop file actions must prefer the native directory picker while preserving the web fallback');
assert.match(appSource, /async function renderFileActionDestinations[\s\S]+directoryItem\.rootPath[\s\S]+desktopTargetPathKey/,
  'desktop current and added directories must render from native root paths');
assert.match(appSource, /const label = document\.createElement\('span'\);[\s\S]+label\.textContent = target\.name;[\s\S]+button\.append\(icon, label\);/,
  'directory labels must render through DOM text rather than an undefined or unsafe HTML escape helper');
assert.match(appSource, /const executeTransaction = useDesktopTransaction \? executeDesktopFileTransaction : executeWebFileTransaction;/,
  'desktop targets must route to the native file transaction');
assert.equal((appSource.match(/async function sameDirectoryHandle\(/g) || []).length, 1,
  'web directory identity comparison must not be overridden by a duplicate function declaration');
assert.match(appSource, /if \(k === 's' && !e\.altKey && e\.shiftKey\)[\s\S]+openFileActionModal\('save-as'\)/,
  'Shift+Command/Ctrl+S should open save-as');
assert.match(appSource, /captureActiveTabSession\(\)[\s\S]+state\.currentDocId = id[\s\S]+restoreActiveTabSession\(doc\)/,
  'tab switching should capture and restore independent editing sessions');

assert.match(cssSource, /\.app-document-tab \{[\s\S]*?border-radius: 10px 10px 0 0;/,
  'tabs should use a restrained Chrome-like curved surface');
assert.match(cssSource, /\.app-document-tabs-bar \{[\s\S]*?background: var\(--ui-color-fill-light\);/,
  'the tab strip should provide a light contrast surface for the selected tab');
assert.match(cssSource, /\.app-document-tabs \{[\s\S]*?flex-flow: row nowrap;/,
  'document tabs must remain in one horizontal row');
assert.match(cssSource, /\.app-document-tabs \{[\s\S]*?padding-inline: var\(--guanyi-tab-arc-size\);[\s\S]*?scroll-padding-inline: var\(--guanyi-tab-arc-size\);/,
  'the scroll container must reserve equal clearance for both outward tab arcs');
assert.match(cssSource, /\.app-document-tab \{[\s\S]*?scroll-margin-inline: var\(--guanyi-tab-arc-size\);/,
  'scrolling a tab into view must preserve both outward arcs');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar \{[\s\S]*?background: var\(--ui-color-fill-light\);/,
  'desktop titlebar must retain the light tab-strip contrast surface');
assert.match(cssSource, /\.app-topbar__identity \{[\s\S]*?flex: 0 0 var\(--guanyi-sidebar-width\);/,
  'brand and slogan must share a stable boundary with the sidebar');
assert.match(cssSource, /--guanyi-sidebar-width:\s*268px;/,
  'the desktop brand region should share one source of truth with the sidebar width');
assert.match(cssSource, /\.app-topbar__identity \{[\s\S]*?width: var\(--guanyi-sidebar-width\);[\s\S]*?flex: 0 0 var\(--guanyi-sidebar-width\);/,
  'the topbar brand region should have the same fixed boundary as the sidebar');
assert.match(cssSource, /\.app-topbar \{[\s\S]*?gap: 0;[\s\S]*?padding-inline: 0;/,
  'the first document tab should start immediately after the bounded brand region');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__identity \{[\s\S]*?padding: 0 4px 0 76px;/,
  'macOS traffic-light safe area must be included inside the bounded brand region');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__identity \{[\s\S]*?max-width: var\(--guanyi-sidebar-width\);[\s\S]*?flex: 0 0 var\(--guanyi-sidebar-width\);/,
  'desktop brand and slogan must not exceed the sidebar width');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__brand \.guanyi-mark \{ display: none; \}/,
  'desktop titlebar should show the brand name and slogan without the web logo');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__brand \{[\s\S]*?font-size: 15px;[\s\S]*?white-space: nowrap;/,
  'desktop brand copy should stay compact and visible beside the traffic lights');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__tagline \{[\s\S]*?font-size: 10px;[\s\S]*?text-overflow: ellipsis;/,
  'desktop slogan should use a compact bounded treatment instead of colliding with the brand');
assert.match(cssSource, /html\.is-desktop-client \.app-topbar__identity \{[\s\S]*?overflow: hidden;/,
  'desktop brand region should clip overflow without pushing the first document tab');
assert.match(cssSource, /\.app-topbar > \.app-document-tabs-bar \.app-document-tabs \{[\s\S]*?width: max-content;[\s\S]*?max-width: calc\(100% - 38px\);[\s\S]*?flex: 0 1 auto;/,
  'the new-tab button must follow the last tab and stop at the available width');
assert.match(cssSource, /html\.is-desktop-client \.app-menu-wrap \{ display: block;[\s\S]*?-webkit-app-region: no-drag;/,
  'desktop clients must keep a visible app menu for settings and about');
assert.match(cssSource, /\.app-document-tab\[aria-selected="true"\] \{[\s\S]*?background: var\(--ui-color-background-top\);[\s\S]*?box-shadow: none;/,
  'the selected tab should use surface contrast without a grey edge shadow around its curved corners');
assert.match(cssSource, /html\.is-desktop-client \.app-document-tab\[aria-selected="true"\] \{ border-radius: 10px 10px 0 0; \}/,
  'desktop selected tabs should keep only top corner radii on the tab surface');
assert.match(cssSource, /\.app-document-tab\[aria-selected="true"\]::before[\s\S]+left: -10px[\s\S]+border-bottom-right-radius: 10px;[\s\S]+box-shadow: 5px 5px 0 5px var\(--ui-color-background-top\);/,
  'selected tabs should use an outward left arc with a surface shadow');
assert.match(cssSource, /\.app-document-tab\[aria-selected="true"\]::after[\s\S]+right: -10px[\s\S]+border-bottom-left-radius: 10px;[\s\S]+box-shadow: -5px 5px 0 5px var\(--ui-color-background-top\);/,
  'selected tabs should use an outward right arc with a surface shadow');
assert.match(cssSource, /\.app-modal__actions \{[\s\S]*?justify-content: flex-end;[\s\S]*?border-top: 1px solid/,
  'modal primary actions should be right aligned in a dedicated footer');
assert.match(cssSource, /@media \(max-width: 360px\)[\s\S]+\.app-file-action-modal/,
  'file operations and settings should remain bounded at 320px widths');
assert.match(cssSource, /html\[data-theme="dark"\]/, 'the existing dark theme contract should remain present');
assert.match(designSource, /默认复制已有 `\.REVIEW\.md`/);
assert.match(designSource, /默认加入文档列表/);
assert.doesNotMatch(indexSource, /<title>[^<]*绎述我心。<\/title>/,
  'the browser title should use the approved slogan without a trailing full stop');

class MemoryFileHandle {
  constructor(name, value = '') {
    this.kind = 'file';
    this.name = name;
    this.bytes = new TextEncoder().encode(value);
  }
  async getFile() {
    const bytes = this.bytes.slice();
    return {
      size: bytes.byteLength,
      lastModified: 1,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }
  async write(value) {
    this.bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice();
  }
}

class MemoryDirectoryHandle {
  constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  missing() { return Object.assign(new Error('missing'), { name: 'NotFoundError' }); }
  mismatch() { return Object.assign(new Error('mismatch'), { name: 'TypeMismatchError' }); }
  async getFileHandle(name, options = {}) {
    const current = this.children.get(name);
    if (current?.kind === 'directory') throw this.mismatch();
    if (current) return current;
    if (!options.create) throw this.missing();
    const handle = new MemoryFileHandle(name);
    this.children.set(name, handle);
    return handle;
  }
  async getDirectoryHandle(name, options = {}) {
    const current = this.children.get(name);
    if (current?.kind === 'file') throw this.mismatch();
    if (current) return current;
    if (!options.create) throw this.missing();
    const handle = new MemoryDirectoryHandle(name);
    this.children.set(name, handle);
    return handle;
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw this.missing();
  }
  async *entries() { yield* this.children.entries(); }
  async isSameEntry(other) { return this === other; }
}

async function putMemoryFile(directory, name, value) {
  const handle = await directory.getFileHandle(name, { create: true });
  await handle.write(value);
}

async function memoryFileText(directory, path) {
  let current = directory;
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part);
  const file = await (await current.getFileHandle(parts.at(-1))).getFile();
  return new TextDecoder().decode(await file.arrayBuffer());
}

const fileHelpersStart = appSource.indexOf('  async function removeEntryIfExists(');
const fileHelpersEnd = appSource.indexOf('\n\n  function escapeRegularExpression', fileHelpersStart);
const rollbackStart = appSource.indexOf('  async function rollbackFileTransaction(');
const rollbackEnd = appSource.indexOf('\n\n  async function executeWebFileTransaction', rollbackStart);
assert.ok(fileHelpersStart >= 0 && fileHelpersEnd > fileHelpersStart && rollbackStart >= 0 && rollbackEnd > rollbackStart,
  'file snapshot and rollback helpers should be extractable');
const transactionHelpers = vm.runInNewContext(`(() => {
  const writeToFileHandle = (handle, value) => handle.write(value);
  ${appSource.slice(fileHelpersStart, fileHelpersEnd)}
  ${appSource.slice(rollbackStart, rollbackEnd)}
  return { snapshotEntry, managedAssetsSnapshot, rollbackFileTransaction };
})()`, { Uint8Array, console });

const sourceDirectory = new MemoryDirectoryHandle('source');
const targetDirectory = new MemoryDirectoryHandle('target');
await putMemoryFile(sourceDirectory, 'book.md', 'source-document');
await putMemoryFile(sourceDirectory, 'book.REVIEW.md', 'source-review');
await putMemoryFile(await (await sourceDirectory.getDirectoryHandle('assets', { create: true })).getDirectoryHandle('book', { create: true }), 'source.png', 'source-image');
await putMemoryFile(targetDirectory, 'book.md', 'target-document');
await putMemoryFile(targetDirectory, 'book.REVIEW.md', 'target-review');
await putMemoryFile(await (await targetDirectory.getDirectoryHandle('assets', { create: true })).getDirectoryHandle('book', { create: true }), 'target.png', 'target-image');

const rollbackContext = {
  sourceDirectory,
  sourceFileName: 'book.md',
  sourceReviewName: 'book.REVIEW.md',
  sourceBase: 'book',
  targetDirectory,
  targetFileName: 'book.md',
  targetReviewName: 'book.REVIEW.md',
  targetBase: 'book',
  sourceRemoved: true,
  targetFileSnapshot: await transactionHelpers.snapshotEntry(targetDirectory, 'book.md'),
  targetReviewSnapshot: await transactionHelpers.snapshotEntry(targetDirectory, 'book.REVIEW.md'),
  targetAssetsSnapshot: await transactionHelpers.managedAssetsSnapshot(targetDirectory, 'book'),
  sourceFileSnapshot: await transactionHelpers.snapshotEntry(sourceDirectory, 'book.md'),
  sourceReviewSnapshot: await transactionHelpers.snapshotEntry(sourceDirectory, 'book.REVIEW.md'),
  sourceAssetsSnapshot: await transactionHelpers.managedAssetsSnapshot(sourceDirectory, 'book')
};
await putMemoryFile(targetDirectory, 'book.md', 'partial-new-document');
await putMemoryFile(targetDirectory, 'book.REVIEW.md', 'partial-new-review');
await targetDirectory.removeEntry('assets');
await sourceDirectory.removeEntry('book.md');
await sourceDirectory.removeEntry('book.REVIEW.md');
await sourceDirectory.removeEntry('assets');
assert.equal(await transactionHelpers.rollbackFileTransaction(rollbackContext), true);
assert.equal(await memoryFileText(sourceDirectory, 'book.md'), 'source-document');
assert.equal(await memoryFileText(sourceDirectory, 'book.REVIEW.md'), 'source-review');
assert.equal(await memoryFileText(sourceDirectory, 'assets/book/source.png'), 'source-image');
assert.equal(await memoryFileText(targetDirectory, 'book.md'), 'target-document');
assert.equal(await memoryFileText(targetDirectory, 'book.REVIEW.md'), 'target-review');
assert.equal(await memoryFileText(targetDirectory, 'assets/book/target.png'), 'target-image');

console.log('tabs, settings and file transaction contracts: PASS');
