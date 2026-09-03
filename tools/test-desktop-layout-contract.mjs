import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, buildSource, packageSource, governance] = await Promise.all([
  readFile(new URL('../css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('./build-desktop.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../docs/工程治理与桌面发布闸门.md', import.meta.url), 'utf8')
]);
const packageJson = JSON.parse(packageSource);

for (const declaration of [
  '--guanyi-sidebar-width: 268px',
  '--guanyi-topbar-height: 56px',
  '--guanyi-formatbar-height: 49px',
  '--guanyi-statusbar-height: 26px',
  '--guanyi-workspace-top: calc(var(--guanyi-topbar-height) + var(--guanyi-formatbar-height))'
]) assert.ok(css.includes(declaration), `missing layout token: ${declaration}`);

assert.match(css, /html\.is-desktop-client\s*\{\s*--guanyi-topbar-height:\s*42px;\s*\}/,
  'desktop titlebar height must be expressed through the shared token');
assert.match(css, /\.app-collab-drawer\s*\{[^}]*top:\s*var\(--guanyi-workspace-top\);[^}]*bottom:\s*var\(--guanyi-statusbar-height\);/,
  'drawer must use the shared workspace and statusbar boundaries');
assert.match(css, /\.app-drawer-mask\s*\{[^}]*inset:\s*var\(--guanyi-workspace-top\)\s+0\s+var\(--guanyi-statusbar-height\);/,
  'drawer mask must use the same shared boundaries');

const leafRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
for (const rule of leafRules.filter(({ selector }) => /\.app-(?:collab-drawer|drawer-mask)(?:\b|[\s,.])/.test(selector))) {
  assert.doesNotMatch(rule.body, /\btop:\s*\d+px/, `fixed drawer top offset is forbidden in: ${rule.selector}`);
}
assert.equal((css.match(/html\.is-desktop-client \.app-topbar\s*\{/g) || []).length, 2,
  'desktop topbar may have one authoritative rule and one narrow-window padding override only');
assert.equal((css.match(/html\.is-desktop-client \.app-topbar__identity\s*\{/g) || []).length, 2,
  'desktop identity may have one authoritative rule and one narrow-window override only');

for (const script of ['test:desktop-layout', 'test:desktop-layout-electron']) {
  assert.equal(typeof packageJson.scripts?.[script], 'string', `package.json is missing ${script}`);
}
const preflightOrder = [
  "await runNode('tools/sync-single-file.mjs')",
  "await runNode('tools/test-single-file-sync.mjs')",
  "await runNode('tools/test-desktop-layout-contract.mjs')",
  "await runNode('tools/test-electron-layout.mjs')",
  'await promoteLegacyElectronCache()',
  "await runNode('tools/fetch-meilisearch.mjs'"
].map((needle) => buildSource.indexOf(needle));
assert.ok(preflightOrder.every((index) => index >= 0), 'desktop build must include every source and layout preflight');
assert.deepEqual([...preflightOrder].sort((a, b) => a - b), preflightOrder,
  'desktop build preflights must finish before runtime fetching and packaging');

assert.match(governance, /`css\/app\.css` 和 `js\/app\.js` 是可维护源码/);
assert.match(governance, /禁止在文件末尾追加覆盖规则/);
assert.match(governance, /`v1\.0\.33`/);

process.stdout.write('desktop layout contract passed: shared tokens, single authority and build gates verified\n');
