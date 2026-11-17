import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [main, preload, app, manifest] = await Promise.all([
  readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
]);

assert.equal(manifest.name, 'guanyi-md', 'package identity must stay stable across upgrades');
assert.equal(manifest.build?.appId, 'com.guanyi.md', 'bundle identity must stay stable across upgrades');
assert.match(main, /testUserDataPath \|\| path\.join\(app\.getPath\('appData'\), 'guanyi-md'\)/, 'desktop profile must use a fixed upgrade-safe path');
assert.match(main, /process\.env\.NODE_ENV === 'test'[\s\S]+GUANYI_TEST_USER_DATA/,
  'isolated UI tests may override userData only in an explicit test environment');
assert.match(main, /editor-state-v1\.json/, 'desktop state must have a versioned native backup');
assert.match(main, /stateWriteQueue = stateWriteQueue[\s\S]+saveDesktopState/, 'native state writes must be serialized');
assert.match(main, /guanyi-state:load[\s\S]+guanyi-state:save/, 'main process must expose native state restore and save');
assert.match(preload, /state: Object\.freeze\([\s\S]+load:[\s\S]+save:/, 'renderer must receive the native state bridge');
assert.match(app, /async function loadState\([\s\S]+desktopSaved[\s\S]+savedAt/, 'startup must select the newest local or native state');
assert.match(app, /await loadState\(\)/, 'boot must finish state restoration before rendering documents');
assert.match(app, /window\.guanyiDesktop\?\.state\?\.save/, 'every state save must also update the native backup');
assert.match(main, /guanyi-files:choose[\s\S]+multiSelections/, 'desktop toolbar file opening must use the native picker');
assert.match(preload, /files: Object\.freeze\([\s\S]+choose:/, 'renderer must receive the native file picker bridge');
assert.match(main, /managedDocumentsDirectory[\s\S]+app\.getPath\('userData'\)[\s\S]+'documents'/,
  'managed documents must live inside the fixed upgrade-safe desktop profile');
assert.match(preload, /createManaged:[\s\S]+guanyi-files:create-managed/,
  'renderer must receive the managed document bridge');
assert.match(app, /storageKind: d\.storageKind === 'managed'[\s\S]+storageKind: d\.storageKind === 'managed'/,
  'managed document identity must survive native state serialization and restoration');
assert.match(app, /desktopApi && typeof desktopApi\.choose[\s\S]+importDesktopFiles/, 'native file selections must retain absolute paths');
assert.match(app, /desktopImportMatch[\s\S]+legacyMatches\.length === 1[\s\S]+existing\.desktopPath = desktopPath/, 'one legacy file must migrate in place without creating a duplicate');
assert.match(app, /keepLocalEdit[\s\S]+syncState = 'conflict'[\s\S]+externalContent = content/, 'legacy migration must preserve unsaved local edits');

for (const channel of [
  'guanyi-directories:choose',
  'guanyi-directories:inspect',
  'guanyi-directories:scan',
  'guanyi-directories:read',
  'guanyi-directories:rename',
  'guanyi-directories:store-asset'
]) assert.ok(main.includes(channel), `desktop directory bridge is missing ${channel}`);

for (const method of ['choose', 'inspect', 'scan', 'read', 'rename', 'storeAsset']) {
  assert.match(preload, new RegExp(`${method}:`), `preload directory bridge is missing ${method}`);
}

assert.match(app, /rootPath: directory\.rootPath \|\| null/, 'directory absolute paths must be serialized');
assert.match(app, /desktopApi && directory\.rootPath[\s\S]+desktopApi\.scan\(directory\.rootPath\)/, 'desktop directories must scan by retained native path');
assert.match(app, /desktopPath: entry\.path \|\| null/, 'directory documents must retain their native file path');
assert.match(app, /directory\?\.rootPath && desktopApi[\s\S]+readDesktopDirectoryEntry/, 'retained directories must reopen without a browser handle');
assert.match(app, /desktopDirectoryApi\(\) && directory\.rootPath[\s\S]+permissionState = 'granted'/, 'startup must validate retained native paths before asking for reconnection');
assert.match(app, /if \(desktopApi\)[\s\S]+selected = await desktopApi\.choose[\s\S]+rootPath: selected\.path/, 'new desktop directories must be native from first add');
assert.match(app, /connectDesktopDirectory\(directory\)/, 'legacy handle-only directories must offer a one-time native migration');

console.log('upgrade persistence tests passed: stable profile, native state backup, retained directories and one-time legacy migration verified');
