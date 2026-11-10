import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
  ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : process.platform === 'win32'
    ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
const smokeScripts = ['electron-file-actions-smoke.cjs', 'electron-file-lifecycle-smoke.cjs'];
const outputDirectory = path.join(projectRoot, '.tmp-test', 'electron-file-actions');

await access(electron);
await mkdir(outputDirectory, { recursive: true });

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
environment.NODE_ENV = 'test';
if (environment.GUANYI_TEST_FOREGROUND !== '1') environment.GUANYI_TEST_BACKGROUND = '1';

for (const script of smokeScripts) await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(projectRoot, 'tools', script), outputDirectory], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Electron file-action smoke failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});
