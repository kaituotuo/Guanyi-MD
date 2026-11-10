import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('function contentFingerprint(');
const helperEnd = appSource.indexOf('\n  function serializeDirectory', helperStart);
assert.notEqual(helperStart, -1, 'directory diff helpers should exist');
assert.notEqual(helperEnd, -1, 'directory diff helper block should be complete');
const directoryExts = appSource.match(/const DIRECTORY_EXTS = \[[^\n]+\];/)?.[0];
assert.ok(directoryExts, 'directory extensions should be defined');

const helpers = vm.runInNewContext(`(() => {
  const DIRECTORY_MAX_DEPTH = 5;
  ${directoryExts}
  ${appSource.slice(helperStart, helperEnd)}
  return { normalizeRelativePath, directoryDocId, shouldIgnoreDirectoryEntry, diffDirectoryIndex, partitionMissingDirectoryDocs, directoryScanComplete };
})()`);

const existing = [
  { id: 'keep', relativePath: 'notes/keep.md', externalModifiedAt: 10, externalSize: 100 },
  { id: 'change', relativePath: 'notes/change.txt', externalModifiedAt: 10, externalSize: 100 },
  { id: 'missing', relativePath: 'old/missing.md', externalModifiedAt: 10, externalSize: 100 }
];
const scanned = [
  { relativePath: 'notes/keep.md', lastModified: 10, size: 100 },
  { relativePath: 'notes/change.txt', lastModified: 11, size: 120 },
  { relativePath: 'new/report.markdown', lastModified: 12, size: 80 }
];
const diff = helpers.diffDirectoryIndex(existing, scanned);
assert.deepEqual([...diff.added].map((entry) => entry.relativePath), ['new/report.markdown']);
assert.deepEqual([...diff.changed].map(({ doc }) => doc.id), ['change']);
assert.deepEqual([...diff.unchanged].map(({ doc }) => doc.id), ['keep']);
assert.deepEqual([...diff.missing].map((doc) => doc.id), ['missing']);
const cleanMissing = { id: 'clean', content: 'saved', lastSavedContent: 'saved' };
const dirtyMissing = { id: 'dirty', content: 'draft', lastSavedContent: 'saved' };
const completeMissing = helpers.partitionMissingDirectoryDocs(
  [cleanMissing, dirtyMissing],
  true,
  (doc) => doc.content !== doc.lastSavedContent
);
assert.deepEqual([...completeMissing.removed].map((doc) => doc.id), ['clean']);
assert.deepEqual([...completeMissing.retained].map((doc) => doc.id), ['dirty']);
assert.deepEqual([...completeMissing.deferred].map((doc) => doc.id), []);
const partialMissing = helpers.partitionMissingDirectoryDocs([cleanMissing, dirtyMissing], false, () => false);
assert.deepEqual([...partialMissing.deferred].map((doc) => doc.id), ['clean', 'dirty']);
assert.deepEqual([...partialMissing.removed], []);
assert.equal(helpers.directoryDocId('directory-a', 'notes\\keep.md'), helpers.directoryDocId('directory-a', '/notes/keep.md'));
assert.equal(helpers.shouldIgnoreDirectoryEntry('.hidden.md', 'file', 0), true);
assert.equal(helpers.shouldIgnoreDirectoryEntry('draft.review.md', 'file', 0), true);
assert.equal(helpers.shouldIgnoreDirectoryEntry('book.txt', 'file', 0), false);
assert.equal(helpers.shouldIgnoreDirectoryEntry('书籍.epub', 'file', 0), false);
assert.equal(helpers.shouldIgnoreDirectoryEntry('论文.PDF', 'file', 0), false);
assert.equal(helpers.shouldIgnoreDirectoryEntry('notes.docx', 'file', 0), true);
assert.equal(helpers.shouldIgnoreDirectoryEntry('level-five', 'directory', 5), true);
assert.equal(helpers.directoryScanComplete({ errors: [{ path: 'large.pdf', code: 'FILE_TOO_LARGE' }], truncated: false, depthLimited: false }), true);
assert.equal(helpers.directoryScanComplete({ errors: [{ path: 'private.epub', reason: 'access denied' }], truncated: false, depthLimited: false }), false);
assert.equal(helpers.directoryScanComplete({ errors: [], truncated: true, depthLimited: false }), false);
const failureStart = appSource.indexOf('function directoryReadFailureState(');
const failureEnd = appSource.indexOf('\n  async function prepareDirectoryReader', failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart, 'directory read failure classification should exist');
const readFailureState = vm.runInNewContext(`(() => { ${appSource.slice(failureStart, failureEnd)}; return directoryReadFailureState; })()`);
assert.equal(readFailureState(new Error('文件内容不是有效的 PDF')), 'read-error');
assert.equal(readFailureState(Object.assign(new Error('denied'), { code: 'EACCES' })), 'permission-required');
assert.equal(readFailureState(Object.assign(new Error('gone'), { code: 'ENOENT' })), 'missing');

const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
const sectionTitleStart = indexSource.indexOf('class="app-sidebar__section-title"');
const sectionTitleEnd = indexSource.indexOf('class="app-sidebar__section-actions"', sectionTitleStart);
const toggleButtonPosition = indexSource.indexOf('id="btn-toggle-all-docs"');
const addButtonPosition = indexSource.indexOf('id="btn-add-directory"');
const refreshButtonPosition = indexSource.indexOf('id="btn-refresh-directories"');
assert.ok(
  sectionTitleStart >= 0 && toggleButtonPosition > sectionTitleStart && toggleButtonPosition < sectionTitleEnd,
  'collapse toggle should sit beside the document-list title'
);
assert.match(cssSource, /\.app-sidebar__section-title\s*\{[^}]*white-space:\s*nowrap;/s, 'document-list title should stay on one line');
assert.ok(addButtonPosition >= 0 && refreshButtonPosition > addButtonPosition, 'refresh should follow Add Folder');
assert.match(appSource, /btnRefreshDirectories\.addEventListener\('click', refreshAllDirectories\)/);
assert.match(appSource, /scanDirectory\(directory, \{ interactive: true, announce: false \}\)/);
assert.match(appSource, /function updateDirectoryRefreshButton\(\)[\s\S]+const refreshing = !!directoryRefreshPromise;/,
  'background automatic scans must not animate the global refresh button');
assert.doesNotMatch(appSource, /const refreshing = !!directoryRefreshPromise \|\| !!activeDirectoryScanId;/,
  'the global refresh button must not reflect every background directory scan');
assert.match(appSource, /markSemanticIndexDirty\(doc\.id\)/, 'directory changes should invalidate semantic cache');
assert.match(appSource, /state\.docs = state\.docs\.filter\(\(doc\) => !removedIds\.has\(doc\.id\)\)/,
  'a complete refresh should remove clean mirrors for files deleted from disk');
assert.match(appSource, /doc\.syncState === 'permission-required' \|\| doc\.syncState === 'missing'/,
  'a file that reappears at the same path should recover from missing state');
assert.match(appSource, /function desktopDirectoryApi\(/, 'desktop directories should use an Electron-native path bridge');
assert.match(appSource, /desktopApi && directory\.rootPath[\s\S]+desktopApi\.scan/, 'desktop refresh should reuse the retained native path');
assert.match(appSource, /window\.addEventListener\('focus'[\s\S]+scanAllDirectories\(\{ interactive: false, announce: false \}\)/,
  'returning from Finder should refresh directory mirrors without waiting for the interval');

console.log('directory refresh tests passed: add, change, clean removal, dirty recovery, partial-scan safety, filters, depth and semantic invalidation verified');
