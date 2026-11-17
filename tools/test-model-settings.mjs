import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
  ? path.join(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(projectRoot, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const outputDirectory = path.join(projectRoot, '.tmp-test', 'model-settings');
await access(electron);
await mkdir(outputDirectory, { recursive: true });

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(projectRoot, 'tools/electron-model-settings-smoke.cjs'), outputDirectory], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Electron model settings failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});
