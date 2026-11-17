import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROXY_HEALTH_PATH, workspaceIdentity } from './dev-server.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeDirectory = path.join(projectRoot, '.tmp-test');
const runtimeFile = path.join(runtimeDirectory, 'web-runtime.json');
const expectedWorkspaceId = workspaceIdentity(projectRoot);
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));

export async function matchingService(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PROXY_HEALTH_PATH}`, { signal: AbortSignal.timeout(700) });
    const health = await response.json();
    return response.ok && health.app === 'guanyi-reader-local' && health.apiVersion === 2
      && health.workspaceId === expectedWorkspaceId && health.capabilities?.ccSwitch === true
      && health.capabilities?.managedModels === true && health.capabilities?.readers === true
      && health.capabilities?.multimodal === true;
  } catch (_error) { return false; }
}

async function portIsFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('浏览器暂时无法自动打开')));
  });
}

export async function startWeb(options = {}) {
  let rememberedPort;
  try {
    const previous = JSON.parse(await readFile(runtimeFile, 'utf8'));
    if (previous.workspaceId === expectedWorkspaceId && Number.isInteger(previous.port)) rememberedPort = previous.port;
  } catch (_error) { /* The first launch has no runtime record. */ }
  for (const port of new Set([rememberedPort, 9929].filter(Boolean))) {
    if (await matchingService(port)) {
      const url = `http://127.0.0.1:${port}/`;
      if (!options.noOpen) await openBrowser(url);
      return { url, port, reused: true };
    }
  }
  await mkdir(runtimeDirectory, { recursive: true });
  for (let port = 9929; port <= 9949; port += 1) {
    if (!await portIsFree(port)) continue;
    const log = openSync(path.join(runtimeDirectory, 'web-server.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [path.join(projectRoot, 'tools/dev-server.mjs'), '--port', String(port)], {
        cwd: projectRoot, env: process.env, detached: true, stdio: ['ignore', log, log]
      });
    } finally { closeSync(log); }
    let exited = false;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('exit', () => { exited = true; });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await matchingService(port)) {
        const url = `http://127.0.0.1:${port}/`;
        await writeFile(runtimeFile, JSON.stringify({ workspaceId: expectedWorkspaceId, port, pid: child.pid, url }, null, 2), { mode: 0o600 });
        if (!options.noOpen) await openBrowser(url);
        return { url, port, reused: false };
      }
      if (failed || exited) break;
      await pause(150);
    }
    // A failed spawn belongs to this launcher only; never stop a different
    // service merely because it occupies the preferred port.
    if (!failed && !exited) child.kill('SIGTERM');
  }
  throw new Error('无法启动本机网页版，请确认 Node.js 可用，或关闭占用 9929–9949 的旧服务后重试');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await startWeb({ noOpen: process.argv.includes('--no-open') });
    console.log(`观译阅读器 Web：${result.url}${result.reused ? '（复用当前项目服务）' : ''}`);
    console.log('支持 Markdown、TXT、PDF、EPUB；模型设置可直接跟随 CC Switch 当前启用配置。');
  } catch (error) {
    console.error(error?.message || '本机网页版启动失败');
    process.exitCode = 1;
  }
}
