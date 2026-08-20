import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('function contentFingerprint(');
const helperEnd = appSource.indexOf('\n  function serializeDirectory', helperStart);
assert.notEqual(helperStart, -1, 'directory diff helpers should exist');
assert.notEqual(helperEnd, -1, 'directory diff helper block should be complete');

const helpers = vm.runInNewContext(`(() => {
  const DIRECTORY_MAX_DEPTH = 5;
  const DIRECTORY_EXTS = ['.md', '.markdown', '.txt'];
  ${appSource.slice(helperStart, helperEnd)}
  return { normalizeRelativePath, directoryDocId, shouldIgnoreDirectoryEntry, diffDirectoryIndex };
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
assert.equal(helpers.directoryDocId('directory-a', 'notes\\keep.md'), helpers.directoryDocId('directory-a', '/notes/keep.md'));
assert.equal(helpers.shouldIgnoreDirectoryEntry('.hidden.md', 'file', 0), true);
assert.equal(helpers.shouldIgnoreDirectoryEntry('draft.review.md', 'file', 0), true);
assert.equal(helpers.shouldIgnoreDirectoryEntry('book.txt', 'file', 0), false);
assert.equal(helpers.shouldIgnoreDirectoryEntry('level-five', 'directory', 5), true);

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
assert.match(appSource, /markSemanticIndexDirty\(doc\.id\)/, 'directory changes should invalidate semantic cache');

console.log('directory refresh tests passed: add, change, missing, filters, depth, button order and semantic invalidation verified');
