import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readCcSwitchConnection, listCcSwitchConnections } = require('../desktop/cc-switch.cjs');
const { executeDesktopAiRequest, cancelDesktopAiRequest, hasImagePayload } = require('../desktop/ai-transport.cjs');
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PROXY_PATH = '/__md-editor-ai-proxy__/chat/completions';
export const PROXY_MODELS_PATH = '/__md-editor-ai-proxy__/models';
export const PROXY_HEALTH_PATH = '/__md-editor-ai-proxy__/health';
export const CC_SWITCH_PATH = '/__md-editor-ai-proxy__/cc-switch';
const PROXY_HEADER = 'x-md-editor-ai-proxy';
const LOCAL_REQUEST_HEADER = 'x-guanyi-local-request';
const MAX_REQUEST_BYTES = 12 * 1024 * 1024 + 65536;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const MAX_SNAPSHOTS = 256;
const DEFAULT_PORT = 9929;
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const PRIVATE_DIRECTORIES = new Set(['node_modules', 'release']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip'
};

export function workspaceIdentity(projectRoot = PROJECT_ROOT) {
  return createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 24);
}

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(response, statusCode, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8', [PROXY_HEADER]: '1',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function localOrigin(request, port) {
  try {
    const host = new URL(`http://${String(request.headers.host || '')}`);
    if (host.username || host.password || host.pathname !== '/' || !LOOPBACK_NAMES.has(host.hostname.replace(/^\[|\]$/g, ''))
      || Number(host.port || 80) !== port) return null;
    const remote = String(request.socket.remoteAddress || '');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return null;
    return host.origin;
  } catch (_error) { return null; }
}

function requireLocalPost(request, origin) {
  if (request.method !== 'POST') throw httpError('此操作需要 POST 请求', 405);
  if (request.headers.origin !== origin || request.headers[LOCAL_REQUEST_HEADER] !== '1') {
    throw httpError('请从本机服务页面使用此功能，不支持外部页面或直接打开的文件页面', 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
    throw httpError('请使用 JSON 请求', 415);
  }
}

async function readJsonBody(request) {
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) throw httpError('图文请求内容超过 12 MB 限制', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw httpError('图文请求内容超过 12 MB 限制', 413);
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_error) { throw httpError('请求内容不是有效 JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError('请求参数格式不正确');
  if (size > 1024 * 1024 && !hasImagePayload(payload.payload)) throw httpError('文字请求内容超过 1 MB 限制', 413);
  return payload;
}

function validateTargetUrl(value) {
  let target;
  try { target = new URL(String(value || '')); }
  catch (_error) { throw httpError('模型服务地址格式不正确'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw httpError('模型服务地址仅支持不含账号信息的 HTTP 或 HTTPS');
  }
  return target.href;
}

function managedTarget(connection, catalog = false) {
  const url = new URL(validateTargetUrl(connection.baseUrl));
  const pathname = url.pathname.replace(/\/+$/, '');
  const endpoint = pathname.match(/\/(chat\/completions|responses|messages)$/i);
  const expected = connection.wireApi === 'responses' ? 'responses'
    : connection.wireApi === 'anthropic' ? 'messages' : 'chat/completions';
  if (endpoint && endpoint[1].toLowerCase() !== expected) {
    throw httpError('CC Switch 当前服务地址与接口类型不匹配，请核对启用配置中的地址和接口类型', 422);
  }
  let prefix = endpoint ? pathname.slice(0, -endpoint[0].length) : pathname;
  // Codex appends /responses to its configured base URL verbatim, including a bare origin.
  if (!prefix && connection.wireApi !== 'responses') prefix = '/v1';
  if (connection.wireApi === 'anthropic' && !/\/v1$/i.test(prefix)) prefix += '/v1';
  const suffix = catalog ? '/models' : connection.wireApi === 'responses' ? '/responses'
    : connection.wireApi === 'anthropic' ? '/messages' : '/chat/completions';
  url.pathname = prefix + suffix;
  if (catalog) url.search = '';
  url.hash = '';
  return url.href;
}

function safeProviderError(status, bodyText) {
  let payload;
  try { payload = JSON.parse(bodyText); } catch (_error) { /* Never forward an upstream error page. */ }
  const detail = [payload?.error?.message, payload?.error?.code, payload?.error?.type, payload?.message]
    .filter(value => typeof value === 'string').join(' ').toLowerCase();
  if (status === 401 || /invalid.?key|unauthori[sz]ed|authentication/.test(detail)) return '密钥未通过验证，请在连接配置或 CC Switch 中检查 API Key';
  if (/quota|balance|credit|余额|额度不足/.test(detail)) return '账户额度不足，请在服务商检查余额、套餐或用量上限';
  if (status === 403) return '当前账户没有访问权限，请检查模型授权、IP 限制和访问规则';
  if (/image|vision|multimodal|图像|图片|视觉/.test(detail)
    && /not.?support|unsupported|not.?allow|only.*text|text.?only|invalid.*(?:image|content)|不支持|不接受|仅支持文字|仅支持文本/.test(detail)) return '当前模型或接口不支持图片输入，请在顶部 … > 模型配置切换支持视觉的模型后重新研读';
  if (/model.*(?:not.?found|not.?exist|not.?available|invalid|unsupported|unknown)|模型.*(?:不存在|无效|不可用)/.test(detail)) return '此模型不可用，请核对当前启用配置的模型标识及授权';
  if (status === 404) return '没有找到模型接口，请检查服务地址与当前配置的接口类型';
  if (status === 429) return '请求过于频繁或已达到用量上限，请稍后重试';
  if (status === 408 || status === 504) return '模型服务响应超时，请稍后重试或切换可用模型';
  if (status >= 500) return '模型服务暂时异常，请稍后重试';
  if (/context|maximum.*tokens|too.*(?:long|large)|上下文|长度/.test(detail)) return '本次内容超过模型可处理的长度，请缩小文档或选区范围';
  return '模型服务未接受本次请求，请核对地址、接口类型与模型配置';
}

function redactCredential(value, apiKey) {
  let result = String(value || '');
  for (const token of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])) {
    if (token) result = result.split(token).join('[已隐藏密钥]');
  }
  return result;
}

export function createLocalServer(options = {}) {
  const projectRoot = realpathSync(options.projectRoot || PROJECT_ROOT);
  const now = options.now || Date.now;
  const ttl = options.snapshotTtlMs || SNAPSHOT_TTL_MS;
  const readCurrentConnection = options.readCurrentConnection || readCcSwitchConnection;
  const listCurrentConnections = options.listCurrentConnections || listCcSwitchConnections;
  const snapshots = new Map();
  const versionPromise = readFile(resolve(projectRoot, 'package.json'), 'utf8').then(text => JSON.parse(text).version).catch(() => 'unknown');
  const workspaceId = workspaceIdentity(projectRoot);

  async function createSnapshot(origin, sourceApp) {
    const current = await readCurrentConnection({ sourceApp });
    const connection = Object.freeze({ ...current });
    // The reader only returns fully validated active configurations. Validate
    // the model again here because test adapters and future readers share this boundary.
    if (!connection.apiKey || !connection.model) throw httpError('CC Switch 当前启用配置缺少 Key 或模型，请先在 CC Switch 中完成设置', 422);
    if (sourceApp && connection.sourceApp !== sourceApp) throw httpError('CC Switch 返回的来源与选择不一致，请重新选择', 422);
    managedTarget(connection);
    const timestamp = now();
    for (const [key, snapshot] of snapshots) if (snapshot.expiresAt <= timestamp) snapshots.delete(key);
    while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    const managedToken = randomBytes(32).toString('hex');
    const expiresAt = timestamp + ttl;
    snapshots.set(managedToken, { connection, origin, expiresAt });
    return {
      source: 'cc-switch', sourceLabel: connection.sourceLabel, sourceApp: connection.sourceApp,
      baseUrl: connection.baseUrl, wireApi: connection.wireApi, authType: connection.authType,
      model: connection.model, managed: true, managedToken, expiresAt
    };
  }

  async function proxy(request, response, origin, catalog) {
    const body = await readJsonBody(request);
    let connection;
    let targetUrl;
    if (body.managedToken !== undefined) {
      const snapshot = typeof body.managedToken === 'string' ? snapshots.get(body.managedToken) : null;
      if (!snapshot || snapshot.origin !== origin || snapshot.expiresAt <= now()) {
        if (snapshot?.expiresAt <= now()) snapshots.delete(body.managedToken);
        throw httpError('CC Switch 本次连接已过期或已失效，请重新发送以读取当前启用配置', 409);
      }
      connection = snapshot.connection;
      targetUrl = managedTarget(connection, catalog);
      if (!catalog && body.payload?.model !== connection.model) throw httpError('模型与本次 CC Switch 配置不一致，请重新发送', 409);
    } else {
      const authorization = String(request.headers.authorization || '');
      if (!authorization.startsWith('Bearer ') || !authorization.slice(7)) throw httpError('缺少模型 API Key', 401);
      connection = { apiKey: authorization.slice(7), wireApi: body.wireApi, authType: body.authType };
      targetUrl = validateTargetUrl(body.targetUrl);
    }
    if (!catalog && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) {
      throw httpError('模型请求参数格式不正确');
    }
    const requestId = `web-${randomUUID()}`;
    let disconnected = false;
    const cancel = () => { disconnected = true; cancelDesktopAiRequest(requestId); };
    const onClose = () => { if (!response.writableEnded) cancel(); };
    request.once('aborted', cancel);
    response.once('close', onClose);
    try {
      const result = await executeDesktopAiRequest({
        requestId, targetUrl, apiKey: connection.apiKey, wireApi: connection.wireApi, authType: connection.authType,
        payload: body.payload, timeoutMs: body.timeoutMs || (catalog ? 15000 : 90000)
      }, catalog ? 'GET' : 'POST', options.fetchImpl || fetch);
      if (disconnected || response.destroyed) return;
      if (!result.ok) {
        sendJson(response, result.status, { error: { message: safeProviderError(result.status, result.bodyText) } });
        return;
      }
      const bodyText = redactCredential(result.bodyText, connection.apiKey);
      response.writeHead(result.status, {
        'content-type': result.contentType || 'application/json; charset=utf-8', [PROXY_HEADER]: '1',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
      });
      response.end(bodyText);
    } catch (error) {
      if (disconnected || response.destroyed) return;
      if (error?.code === 'MODEL_ABORTED') throw httpError('模型服务响应超时，请稍后重试', 504);
      if (/超过 2 MB/.test(String(error?.message))) throw httpError('模型响应超过 2 MB，请缩小生成范围后重试', 502);
      if (/超过 1 MB/.test(String(error?.message))) throw httpError('模型请求超过 1 MB，请缩小生成范围', 413);
      throw httpError('本机服务未能连接模型，请检查服务地址、代理、证书或网络', 502);
    } finally {
      request.removeListener('aborted', cancel);
      response.removeListener('close', onClose);
    }
  }

  async function serveStatic(request, response, url) {
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch (_error) { throw httpError('地址格式不正确'); }
    const parts = decoded.split('/').filter(Boolean);
    if (parts.some(part => part.startsWith('.') || PRIVATE_DIRECTORIES.has(part))) throw httpError('Not found', 404);
    const withIndex = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
    const candidate = resolve(projectRoot, `.${withIndex}`);
    if (candidate !== projectRoot && !candidate.startsWith(`${projectRoot}${sep}`)) throw httpError('Not found', 404);
    let filePath;
    try {
      filePath = await realpath(candidate);
      if (!filePath.startsWith(`${projectRoot}${sep}`) || !(await stat(filePath)).isFile()) throw httpError('Not found', 404);
      const content = await readFile(filePath);
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'content-length': content.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error?.statusCode) throw error;
      throw httpError(error?.code === 'ENOENT' ? 'Not found' : '本地文件暂时无法读取', error?.code === 'ENOENT' ? 404 : 500);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const origin = localOrigin(request, server.address()?.port);
      if (!origin || (request.headers.origin && request.headers.origin !== origin)) throw httpError('仅允许本机同源页面访问', 403);
      const url = new URL(request.url || '/', origin);
      if (url.pathname === PROXY_HEALTH_PATH) {
        if (request.method !== 'GET') throw httpError('此操作需要 GET 请求', 405);
        sendJson(response, 200, { ok: true, app: 'guanyi-reader-local', apiVersion: 2,
          version: await versionPromise, workspaceId, capabilities: { ccSwitch: true, managedModels: true, readers: true, multimodal: true } });
        return;
      }
      if ([CC_SWITCH_PATH, PROXY_MODELS_PATH, PROXY_PATH].includes(url.pathname)) {
        requireLocalPost(request, origin);
        if (url.pathname === CC_SWITCH_PATH) {
          const body = await readJsonBody(request);
          if (body.sourceApp !== undefined && !['codex', 'claude'].includes(body.sourceApp)) throw httpError('CC Switch 来源无效，请选择 Codex 或 Claude');
          if (body.action !== undefined && body.action !== 'list') throw httpError('CC Switch 连接请求无效');
          try {
            if (body.action === 'list') {
              const result = await listCurrentConnections();
              const connections = (result.connections || []).map(connection => ({
                sourceApp: connection.sourceApp, sourceLabel: connection.sourceLabel,
                baseUrl: connection.baseUrl, wireApi: connection.wireApi,
                authType: connection.authType || 'bearer', model: connection.model
              }));
              const unavailable = (result.unavailable || []).map(item => ({ sourceApp: item.sourceApp, message: item.message }));
              sendJson(response, 200, { connections, unavailable });
            } else sendJson(response, 200, await createSnapshot(origin, body.sourceApp));
          }
          catch (error) {
            if (error?.statusCode) throw error;
            throw httpError(error?.code === 'CC_SWITCH_CONFIG_ERROR' ? error.message : '无法读取 CC Switch 当前启用配置，请在 CC Switch 中检查连接后重试', 422);
          }
        } else await proxy(request, response, origin, url.pathname === PROXY_MODELS_PATH);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method || '')) throw httpError('此操作需要 GET 或 HEAD 请求', 405);
      await serveStatic(request, response, url);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      sendJson(response, error?.statusCode || 500, { error: { message: error?.statusCode ? error.message : '本机服务暂时无法完成请求' } });
    }
  });
  server.on('close', () => snapshots.clear());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag >= 0 ? process.argv[flag + 1] : process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需要是 1 到 65535 的整数');
  const testHome = process.env.NODE_ENV === 'test' && isAbsolute(process.env.GUANYI_TEST_CC_SWITCH_HOME || '')
    ? process.env.GUANYI_TEST_CC_SWITCH_HOME : null;
  const server = createLocalServer({
    readCurrentConnection: testHome ? options => readCcSwitchConnection({ ...options, homeDirectory: testHome }) : undefined,
    listCurrentConnections: testHome ? () => listCcSwitchConnections({ homeDirectory: testHome }) : undefined
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请使用启动观译Web.command 自动选择可用服务。` : '本机服务未能启动，请检查端口和本地运行环境。');
    process.exitCode = 1;
  });
  server.listen(port, LOOPBACK_HOST, () => console.log(`观译阅读器本机服务：http://${LOOPBACK_HOST}:${port}/（支持 PDF、EPUB 和 CC Switch）`));
  const stop = () => { server.close(); server.closeIdleConnections?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
