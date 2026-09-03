import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
  ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : process.platform === 'win32'
    ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
const smokeScript = path.join(projectRoot, 'tools', 'electron-semantic-smoke.cjs');
const packagedResources = process.argv[2] ? path.resolve(projectRoot, process.argv[2]) : '';
const dataDir = path.join(projectRoot, '.tmp-test', packagedResources ? 'electron-semantic-search-packaged' : 'electron-semantic-search');

await new Promise((resolve, reject) => {
  const child = spawn(electron, [smokeScript, dataDir, ...(packagedResources ? [packagedResources] : [])], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Electron semantic smoke failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});
