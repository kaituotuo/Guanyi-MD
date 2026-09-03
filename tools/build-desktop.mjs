import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const targets = target === '--all' ? ['mac', 'win']
  : target === '--mac' ? ['mac']
    : target === '--win' ? ['win']
      : [];

if (!targets.length) {
  console.error('用法：node tools/build-desktop.mjs --mac | --win | --all');
  process.exit(1);
}

const buildEnvironment = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(projectRoot, '.cache', 'electron-builder')
};

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, script), ...args], {
      cwd: projectRoot,
      env: buildEnvironment,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} 失败（${signal ? `signal ${signal}` : `exit ${code}`}）`));
    });
  });
}

async function promoteLegacyElectronCache() {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const electronVersion = manifest.devDependencies?.electron;
  if (!electronVersion) throw new Error('package.json 缺少 Electron 版本');
  const releaseUrl = new URL(`https://github.com/electron/electron/releases/download/v${electronVersion}/placeholder`);
  releaseUrl.pathname = path.posix.dirname(releaseUrl.pathname);
  const cacheKey = crypto.createHash('sha256').update(releaseUrl.toString()).digest('hex');
  const legacyCacheRoot = path.join(projectRoot, '.cache', 'electron');
  const cacheRoot = path.join(projectRoot, '.cache', 'electron-builder');

  for (const platform of targets) {
    const platformName = platform === 'mac' ? 'darwin-arm64' : 'win32-x64';
    const fileName = `electron-v${electronVersion}-${platformName}.zip`;
    const legacyFile = path.join(legacyCacheRoot, fileName);
    const cachedFile = path.join(cacheRoot, cacheKey, fileName);
    const [legacyStats, cachedStats] = await Promise.all([
      stat(legacyFile).catch(() => null),
      stat(cachedFile).catch(() => null)
    ]);
    if (!legacyStats?.isFile() || cachedStats?.isFile()) continue;
    await mkdir(path.dirname(cachedFile), { recursive: true });
    await copyFile(legacyFile, cachedFile);
  }
}

await runNode('tools/sync-single-file.mjs');
await runNode('tools/test-single-file-sync.mjs');
await runNode('tools/test-desktop-layout-contract.mjs');
await runNode('tools/test-electron-layout.mjs');
await promoteLegacyElectronCache();
const fetchArguments = targets.length === 2 ? [] : [`--${targets[0]}`];
await runNode('tools/fetch-meilisearch.mjs', fetchArguments);
await runNode('tools/generate-app-icons.mjs');

for (const platform of targets) {
  const builderArguments = platform === 'mac'
    ? ['--mac', 'dmg', '--arm64']
    : ['--win', 'nsis', '--x64'];
  await runNode('node_modules/electron-builder/cli.js', builderArguments);
}
