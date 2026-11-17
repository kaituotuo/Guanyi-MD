import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  APPLICATION_MENU_COMMANDS,
  buildApplicationMenuTemplate,
  normalizedMenuState,
  updateApplicationMenuState
} = require('../desktop/application-menu.cjs');

const calls = [];
const template = buildApplicationMenuTemplate({
  platform: 'darwin',
  productName: '观译阅读器',
  actions: {
    command: (command) => calls.push(command),
    help: (section) => calls.push(`help.${section}`),
    diagnostics: () => calls.push('help.diagnostics')
  }
});

assert.deepEqual(template.map((item) => item.label), ['观译阅读器', '文件', '编辑', '查看', '帮助'], 'macOS must expose exactly five first-level menus');
assert.equal(template.some((item) => item.label === '格式' || item.label === '窗口'), false, 'format and window commands must be nested instead of top-level menus');

function allItems(items) {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? allItems(item.submenu) : [])]);
}

const items = allItems(template);
const byId = new Map(items.filter((item) => item.id).map((item) => [item.id, item]));
assert.equal(items.find((item) => item.id === 'menu-edit-undo')?.role, undefined, 'undo must use the editor 50-step history instead of Electron native undo');
assert.equal(items.find((item) => item.id === 'menu-edit-redo')?.role, undefined, 'redo must use the editor 50-step history instead of Electron native redo');
assert.equal(items.find((item) => item.id === 'menu-document-close-tab')?.accelerator, 'CommandOrControl+W', 'Command+W must close the active document tab');
assert.equal(items.find((item) => item.role === 'close'), undefined, 'the native close-window role must not claim Command+W');
assert.equal(items.find((item) => item.id === 'menu-edit-replace')?.accelerator, 'Alt+Command+F', 'replace must not claim the macOS Cmd+H hide shortcut');
assert.ok(items.some((item) => item.id === 'menu-format' && item.label === 'Markdown 格式'), 'Markdown formatting must live under Edit');
assert.ok(items.some((item) => item.role === 'zoom' && item.label === '缩放窗口'), 'window zoom must live under View');
assert.ok(items.some((item) => item.role === 'about' && item.label === '关于观译阅读器'), 'About must stay in the app-name menu');
for (const command of ['document.new', 'document.save', 'document.close-tab', 'edit.undo', 'search.library', 'format.task', 'view.preview']) {
  assert.ok(APPLICATION_MENU_COMMANDS.has(command), `${command} must be in the restricted command whitelist`);
}

const fakeMenu = { getMenuItemById: (id) => byId.get(id) || null };
updateApplicationMenuState(fakeMenu, {
  hasDocument: true,
  hasDiskPath: false,
  hasDirectories: true,
  canUndo: true,
  canRedo: false,
  plainText: true,
  viewMode: 'preview',
  theme: 'dark'
});
assert.equal(byId.get('menu-document-save').enabled, true);
assert.equal(byId.get('menu-document-close-tab').enabled, true);
assert.equal(byId.get('menu-document-open-location').enabled, false);
assert.equal(byId.get('menu-document-refresh-directories').enabled, true);
assert.equal(byId.get('menu-edit-undo').enabled, true);
assert.equal(byId.get('menu-edit-redo').enabled, false);
assert.equal(byId.get('menu-format').enabled, false, 'Markdown formatting must be disabled for TXT');
assert.equal(byId.get('menu-view-preview').checked, true);
assert.equal(byId.get('menu-theme-dark').checked, true);

updateApplicationMenuState(fakeMenu, { hasDocument: false, hasDiskPath: false, hasDirectories: false });
assert.equal(byId.get('menu-document-close-tab').enabled, false, 'close-tab must be disabled when no document is open');

const safeState = normalizedMenuState({ viewMode: 'invalid', theme: 'invalid', hasDocument: 'yes' });
assert.equal(safeState.viewMode, 'split');
assert.equal(safeState.theme, 'light');
assert.equal(safeState.hasDocument, true);

const [mainSource, preloadSource, appSource, helpSource] = await Promise.all([
  readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../desktop/help.html', import.meta.url), 'utf8')
]);
assert.match(mainSource, /buildApplicationMenuTemplate[\s\S]*?Menu\.buildFromTemplate/, 'main process must install the shared five-menu template');
assert.match(mainSource, /titleBarStyle:\s*'hiddenInset'/, 'macOS main window must expose a renderer-owned titlebar safe area');
assert.match(mainSource, /configureAboutPanel\(\);[\s\S]*?installApplicationMenu\(\);/, 'macOS About panel must be configured before installing the native menu');
assert.match(mainSource, /ipcMain\.on\('guanyi-menu:state'[,\s\S]*?trustedRenderer\(event\)/, 'menu state updates must accept only the trusted renderer');
assert.match(preloadSource, /APPLICATION_MENU_COMMANDS[\s\S]*?ipcRenderer\.on\('guanyi:command'[,\s\S]*?APPLICATION_MENU_COMMANDS\.has\(command\)/, 'preload must reject unknown native menu commands');
assert.match(preloadSource, /guanyi-menu:state/, 'preload must expose only the sanitized menu state channel');
assert.match(preloadSource, /guanyi-app:version/, 'preload must expose the native application version through IPC');
assert.match(mainSource, /ipcMain\.handle\('guanyi-app:version'[\s\S]*?app\.getVersion\(\)/, 'main process must return the packaged application version');
assert.match(appSource, /function executeApplicationMenuCommand[\s\S]*?formatFromActiveEditor/, 'native menu commands must reuse existing editor command functions');
assert.match(appSource, /case 'document\.close-tab': await requestCloseDocumentTab\(state\.currentDocId\); break;/, 'Command+W must route through the existing tab-close transaction');
assert.match(appSource, /const replace = macLike[\s\S]*?event\.metaKey && event\.altKey/, 'renderer shortcut handling must preserve macOS Cmd+H');
for (const section of ['guide', 'markdown', 'shortcuts', 'search', 'privacy']) {
  assert.match(helpSource, new RegExp(`id="${section}"`), `offline help must include ${section}`);
}

console.log('desktop menu tests passed: five-level architecture, custom history, shortcut conflict, state sync, whitelist and offline help verified');
