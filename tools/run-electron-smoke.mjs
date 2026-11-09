import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2];
if (!script) throw new Error('Provide the Electron smoke test script.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.resolve(root, script), ...process.argv.slice(3)], { cwd: root, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} failed (${signal || code})`)));
});
