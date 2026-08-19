import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROXY_PATH = '/__md-editor-ai-proxy__/chat/completions';
const PROXY_MODELS_PATH = '/__md-editor-ai-proxy__/models';
const PROXY_HEALTH_PATH = '/__md-editor-ai-proxy__/health';
const PROXY_HEADER = 'x-md-editor-ai-proxy';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_PORT = 9929;
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp'
};

function parsePort() {
  const flagIndex = process.argv.indexOf('--port');
  const value = flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env.PORT;
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${value}`);
  return port;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    [PROXY_HEADER]: '1',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function isLoopbackRequest(request) {
  const hostValue = String(request.headers.host || '');
  const hostName = hostValue.startsWith('[')
    ? hostValue.slice(1, hostValue.indexOf(']'))
    : hostValue.split(':')[0];
  if (!LOOPBACK_NAMES.has(hostName)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return LOOPBACK_NAMES.has(new URL(origin).hostname); }
  catch (error) { return false; }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('请求内容超过 8 MB 限制'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw Object.assign(new Error('请求内容不是有效 JSON'), { statusCode: 400 }); }
}

function validateTargetUrl(value) {
  let target;
  try { target = new URL(String(value || '')); }
  catch (error) { throw Object.assign(new Error('模型服务地址格式不正确'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw Object.assign(new Error('模型服务地址仅支持 HTTP 或 HTTPS'), { statusCode: 400 });
  }
  return target.href;
}

async function proxyModelRequest(request, response) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    sendJson(response, 401, { error: { message: '缺少模型 API Key' } });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const targetUrl = validateTargetUrl(body.targetUrl);
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      throw Object.assign(new Error('模型请求参数格式不正确'), { statusCode: 400 });
    }

    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body.payload),
      signal: controller.signal
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': contentType,
      [PROXY_HEADER]: '1',
      'cache-control': 'no-store'
    });
    response.end(result);
  } catch (error) {
    if (response.headersSent) return;
    const statusCode = error.statusCode || (error.name === 'AbortError' ? 499 : 502);
    const message = error.statusCode ? error.message : '本机转发未能连接模型服务，请检查服务地址、代理、证书或 DNS';
    sendJson(response, statusCode, { error: { message } });
  }
}

async function proxyModelCatalog(request, response) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    sendJson(response, 401, { error: { message: '缺少模型 API Key' } });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const targetUrl = validateTargetUrl(body.targetUrl);
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    const upstream = await fetch(targetUrl, {
      headers: { authorization },
      signal: controller.signal
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': contentType,
      [PROXY_HEADER]: '1',
      'cache-control': 'no-store'
    });
    response.end(result);
  } catch (error) {
    if (response.headersSent) return;
    const statusCode = error.statusCode || (error.name === 'AbortError' ? 499 : 502);
    const message = error.statusCode ? error.message : '本机转发未能连接模型服务，请检查服务地址、代理、证书或 DNS';
    sendJson(response, statusCode, { error: { message } });
  }
}

function safeStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch (error) { return null; }
  const withIndex = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const candidate = resolve(PROJECT_ROOT, `.${withIndex}`);
  return candidate === PROJECT_ROOT || candidate.startsWith(`${PROJECT_ROOT}${sep}`) ? candidate : null;
}

async function serveStatic(request, response, url) {
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    const content = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': content.length,
      'cache-control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}

const port = parsePort();
const server = createServer(async (request, response) => {
  if (!isLoopbackRequest(request)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Loopback access only');
    return;
  }
  const url = new URL(request.url || '/', `http://${LOOPBACK_HOST}:${port}`);
  if (url.pathname === PROXY_HEALTH_PATH) {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', [PROXY_HEADER]: '1' });
      response.end();
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === PROXY_MODELS_PATH) {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', [PROXY_HEADER]: '1' });
      response.end();
      return;
    }
    await proxyModelCatalog(request, response);
    return;
  }
  if (url.pathname === PROXY_PATH) {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', [PROXY_HEADER]: '1' });
      response.end();
      return;
    }
    await proxyModelRequest(request, response);
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  await serveStatic(request, response, url);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，请关闭旧服务或使用 --port 指定其它端口。`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(port, LOOPBACK_HOST, () => {
  console.log(`观绎 MD 本地服务：http://${LOOPBACK_HOST}:${port}/`);
  console.log('页面确认本机服务后使用同源模型转发；API Key 不记录、不写入文件。');
});
