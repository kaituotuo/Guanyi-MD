import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [appSource, cssSource, indexSource] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8')
]);

const helperStart = appSource.indexOf('  function canRenameDocument(');
const helperEnd = appSource.indexOf('\n\n  function createDocumentItem', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'inline rename helpers should be extractable');
const helpers = vm.runInNewContext(`(() => {
  ${appSource.match(/function isReaderDocument[^\n]+/)[0]}
  ${appSource.slice(helperStart, helperEnd)}
  return { canRenameDocument, shouldBeginInlineDocumentRename };
})()`, {
  isDiskFileDoc: (doc) => doc?.sourceKind === 'local-file' || doc?.sourceKind === 'directory'
});

const browserDoc = { id: 'browser', sourceKind: 'browser' };
const desktopDoc = { id: 'desktop', sourceKind: 'local-file', desktopPath: '/docs/test.md', syncState: 'synced' };
const directoryDoc = { id: 'directory', sourceKind: 'directory', fileHandle: {}, syncState: 'synced' };
const missingDoc = { id: 'missing', sourceKind: 'directory', desktopPath: '/docs/missing.md', syncState: 'missing' };
const permissionDoc = { id: 'permission', sourceKind: 'directory', desktopPath: '/docs/locked.md', syncState: 'permission-required' };

assert.equal(helpers.canRenameDocument(browserDoc), true, 'in-app documents should remain renameable');
assert.equal(helpers.canRenameDocument(desktopDoc), true, 'desktop-backed documents should be renameable');
assert.equal(helpers.canRenameDocument(directoryDoc), true, 'authorized directory documents should be renameable');
assert.equal(helpers.canRenameDocument(missingDoc), false, 'missing files must not enter rename mode');
assert.equal(helpers.canRenameDocument(permissionDoc), false, 'files needing permission must not enter rename mode');

assert.equal(helpers.shouldBeginInlineDocumentRename(browserDoc, 'other', true, false), false,
  'the first click on an unselected document should only select it');
assert.equal(helpers.shouldBeginInlineDocumentRename(browserDoc, 'browser', false, false), false,
  'clicking row whitespace or actions should not rename');
assert.equal(helpers.shouldBeginInlineDocumentRename(browserDoc, 'browser', true, true), false,
  'delete confirmation state should not be replaced by rename');
assert.equal(helpers.shouldBeginInlineDocumentRename(browserDoc, 'browser', true, false), true,
  'clicking the selected document name should enter inline rename');
assert.equal(helpers.shouldBeginInlineDocumentRename(missingDoc, 'missing', true, false), false,
  'a selected but unavailable file should remain read-only');

assert.match(appSource, /shouldBeginInlineDocumentRename\([\s\S]+?!!event\.target\.closest\('\.app-doc-item__name'\)[\s\S]+?beginRename\(doc\)/,
  'document list click routing should only pass name-area clicks into the existing rename flow');
assert.match(appSource, /if \(action === 'rename'\)[\s\S]+?beginRename\(doc\)/,
  'the explicit rename icon should remain available');
assert.match(appSource, /if \(e\.key === 'Enter'\)[\s\S]+?submit\('keep'\)[\s\S]+?e\.key === 'Escape'[\s\S]+?renderDocList\(\)/,
  'Enter should submit and Escape should cancel inline rename');
assert.match(appSource, /input\.addEventListener\('blur'[\s\S]+?submit\('cancel'\)/,
  'blur should use the existing safe commit-or-cancel path');
assert.match(cssSource, /\.app-doc-item\.is-active \.app-doc-item__name\.is-renamable\s*\{\s*cursor:\s*text;/,
  'selected renameable names should provide a text-cursor affordance without resizing the row');
assert.match(indexSource, /shouldBeginInlineDocumentRename/,
  'single-file HTML should include the synchronized name-click rename interaction');

console.log('document rename interaction passed: select-first, name-click rename, permission guards and keyboard lifecycle verified');

assert.equal(helpers.canRenameDocument({...desktopDoc,readerFormat:'pdf'}), false, 'binary documents should not enter text rename flow');
