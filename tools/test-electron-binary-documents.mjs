import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-test', 'electron-binary-documents');
await fs.mkdir(output, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.join(root, 'tools', 'electron-binary-documents-smoke.cjs'), output], { cwd: root, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`binary Electron smoke failed (${signal || code})`)));
});
