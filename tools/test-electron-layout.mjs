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
const smokeScript = path.join(projectRoot, 'tools', 'electron-layout-smoke.cjs');
const outputDirectory = path.join(projectRoot, '.tmp-test', 'electron-layout');

await access(electron);
await mkdir(outputDirectory, { recursive: true });

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

await new Promise((resolve, reject) => {
  const child = spawn(electron, [smokeScript, outputDirectory], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Electron layout smoke failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});
