const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_URL_SIZE = 2048;
const MAX_KEY_SIZE = 16 * 1024;
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 120000;

const activeRequests = new Map();

function normalizedDesktopAiRequest(rawRequest, method = 'POST') {
  const request = rawRequest && typeof rawRequest === 'object' ? rawRequest : {};
  const requestId = String(request.requestId || '');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) throw new Error('模型请求编号无效');
  const targetValue = String(request.targetUrl || '');
  if (!targetValue || targetValue.length > MAX_URL_SIZE) throw new Error('模型服务地址无效');
  let targetUrl;
  try { targetUrl = new URL(targetValue); }
  catch (_error) { throw new Error('模型服务地址格式不正确'); }
  if (!EXTERNAL_URL_PROTOCOLS.has(targetUrl.protocol) || targetUrl.username || targetUrl.password) {
    throw new Error('模型服务地址仅支持不含账号信息的 http:// 或 https://');
  }
  const apiKey = String(request.apiKey || '');
  if (!apiKey || apiKey.length > MAX_KEY_SIZE || /[\r\n]/.test(apiKey)) throw new Error('API Key 无效');
  const timeoutMs = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Number(request.timeoutMs) || 30000));
  let body = null;
  if (method === 'POST') {
    try { body = JSON.stringify(request.payload); }
    catch (_error) { throw new Error('模型请求内容无法序列化'); }
    if (!body || Buffer.byteLength(body, 'utf8') > MAX_BODY_SIZE) throw new Error('模型请求内容超过 1 MB');
  }
  return { requestId, targetUrl: targetUrl.href, apiKey, timeoutMs, body, method };
}

async function readDesktopAiResponse(response) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_SIZE) throw new Error('模型响应超过 2 MB');
  if (!response.body?.getReader) {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_SIZE) throw new Error('模型响应超过 2 MB');
    return bodyText;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_SIZE) {
      await reader.cancel().catch(() => {});
      throw new Error('模型响应超过 2 MB');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function executeDesktopAiRequest(rawRequest, method = 'POST', fetchImpl = fetch) {
  const request = normalizedDesktopAiRequest(rawRequest, method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  activeRequests.set(request.requestId, controller);
  try {
    const response = await fetchImpl(request.targetUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: request.body } : {}),
      redirect: 'error',
      signal: controller.signal
    });
    const bodyText = await readDesktopAiResponse(response);
    return {
      ok: response.ok,
      status: response.status,
      bodyText,
      contentType: String(response.headers.get('content-type') || '').slice(0, 160)
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const aborted = new Error('模型请求已取消或超时');
      aborted.code = 'MODEL_ABORTED';
      throw aborted;
    }
    const failure = new Error(error?.message || '桌面端无法连接模型服务');
    failure.code = 'MODEL_NETWORK_ERROR';
    throw failure;
  } finally {
    clearTimeout(timer);
    if (activeRequests.get(request.requestId) === controller) activeRequests.delete(request.requestId);
  }
}

function cancelDesktopAiRequest(requestId) {
  const controller = activeRequests.get(String(requestId || ''));
  if (controller) controller.abort();
  return !!controller;
}

function disposeDesktopAiRequests() {
  activeRequests.forEach((controller) => controller.abort());
  activeRequests.clear();
}

function installDesktopAiHandlers(ipcMain, trustedRenderer) {
  ipcMain.handle('guanyi-ai:chat', async (event, request) => {
    trustedRenderer(event);
    return executeDesktopAiRequest(request, 'POST');
  });
  ipcMain.handle('guanyi-ai:models', async (event, request) => {
    trustedRenderer(event);
    return executeDesktopAiRequest(request, 'GET');
  });
  ipcMain.handle('guanyi-ai:cancel', async (event, requestId) => {
    trustedRenderer(event);
    return cancelDesktopAiRequest(requestId);
  });
}

module.exports = {
  cancelDesktopAiRequest,
  disposeDesktopAiRequests,
  executeDesktopAiRequest,
  installDesktopAiHandlers,
  normalizedDesktopAiRequest,
  readDesktopAiResponse
};
