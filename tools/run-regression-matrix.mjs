import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

const checks = {
  catalog: [node, ['tools/test-regression-catalog.mjs']],
  'list-editing': [node, ['tools/test-list-editing.mjs']],
  'image-editing': [node, ['tools/test-image-editing.mjs']],
  'markdown-clipboard': [node, ['tools/test-markdown-clipboard.mjs']],
  'editor-matrix': [node, ['tools/test-editor-matrix.mjs']],
  'table-editing': [node, ['tools/test-table-editing.mjs']],
  'review-sidecar': [node, ['tools/test-review-sidecar.mjs']],
  'txt-preview': [node, ['tools/test-txt-preview.mjs']],
  'desktop-menu': [node, ['tools/test-desktop-menu.mjs']],
  'directory-refresh': [node, ['tools/test-directory-refresh.mjs']],
  'search-navigation': [node, ['tools/test-search-navigation.mjs']],
  'desktop-file-open': [node, ['tools/test-desktop-file-open.mjs']],
  'document-rename': [node, ['tools/test-document-rename.mjs']],
  'tabs-file-actions': [node, ['tools/test-tabs-and-file-actions.mjs']],
  'single-file-sync': [node, ['tools/test-single-file-sync.mjs']],
  'upgrade-persistence': [node, ['tools/test-upgrade-persistence.mjs']],
  'original-answer': [node, ['tools/test-original-answer.mjs']],
  'work-question': [node, ['tools/test-work-question.mjs']],
  'desktop-ai-bridge': [node, ['tools/test-desktop-ai-bridge.mjs']],
  'semantic-search': [node, ['tools/test-semantic-search.mjs']],
  'semantic-worker': [node, ['tools/test-semantic-search-worker.mjs']],
  'semantic-electron': [node, ['tools/test-electron-semantic-search.mjs']],
  'semantic-real-books': [node, ['tools/test-semantic-search-real-books.mjs']],
  'syntax-app': [node, ['--check', 'js/app.js']],
  'syntax-main': [node, ['--check', 'desktop/main.cjs']],
  'syntax-preload': [node, ['--check', 'desktop/preload.cjs']],
  'syntax-semantic': [node, ['--check', 'desktop/semantic-search.cjs']],
  'diff-check': ['git', ['diff', '--check']]
};

const groups = {
  editor: [
    'catalog', 'list-editing', 'image-editing', 'markdown-clipboard', 'editor-matrix', 'table-editing',
    'txt-preview', 'desktop-menu', 'document-rename', 'tabs-file-actions', 'search-navigation', 'single-file-sync', 'syntax-app'
  ],
  collaboration: [
    'catalog', 'review-sidecar', 'table-editing', 'editor-matrix',
    'original-answer', 'work-question', 'desktop-ai-bridge', 'search-navigation', 'single-file-sync', 'syntax-app'
  ],
  directory: [
    'catalog', 'directory-refresh', 'desktop-file-open', 'document-rename', 'upgrade-persistence',
    'tabs-file-actions', 'search-navigation', 'semantic-search', 'desktop-menu', 'single-file-sync', 'syntax-app', 'syntax-main', 'syntax-preload'
  ],
  search: [
    'catalog', 'search-navigation', 'original-answer', 'work-question', 'desktop-ai-bridge', 'semantic-search',
    'semantic-worker', 'semantic-electron', 'semantic-real-books', 'syntax-semantic'
  ]
};

function unique(values) {
  return [...new Set(values)];
}

groups.recent = unique([
  ...groups.editor,
  ...groups.collaboration,
  ...groups.directory,
  ...groups.search
]);
groups.all = unique([...groups.recent, 'diff-check']);

const requestedGroup = process.argv[2] || 'recent';
if (requestedGroup === '--list') {
  Object.entries(groups).forEach(([name, names]) => process.stdout.write(`${name}: ${names.join(', ')}\n`));
  process.exit(0);
}
if (!groups[requestedGroup]) {
  process.stderr.write(`未知回归分组“${requestedGroup}”。可用分组：${Object.keys(groups).join(', ')}\n`);
  process.exit(2);
}

function runCheck(name) {
  const [command, args] = checks[name];
  process.stdout.write(`\n=== [${requestedGroup}] ${name} ===\n`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, env: process.env, stdio: 'inherit' });
    child.once('error', (error) => resolve({ name, ok: false, detail: error.message }));
    child.once('exit', (code, signal) => resolve({
      name,
      ok: code === 0,
      detail: signal ? `signal ${signal}` : `exit ${code}`
    }));
  });
}

const results = [];
for (const name of groups[requestedGroup]) results.push(await runCheck(name));
const failures = results.filter((result) => !result.ok);
if (failures.length) {
  process.stderr.write(`\n回归分组 ${requestedGroup} 失败：${failures.map((item) => `${item.name} (${item.detail})`).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\n回归分组 ${requestedGroup} 通过：${results.length} 个检查。\n`);
