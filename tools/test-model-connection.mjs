import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function chatCompletionUrl(');
const end = source.indexOf('  function parseAiReadingResponse(', start);
assert.ok(start > 0 && end > start);
const require = createRequire(import.meta.url);
const { executeDesktopAiRequest, cancelDesktopAiRequest } = require('../desktop/ai-transport.cjs');
function helpers(transport = 'direct', fetchImpl = fetch) {
  const window = { location: { protocol: 'https:', hostname: 'guanyi.test' } };
  if (transport === 'desktop') window.guanyiDesktop = { ai: {
    chat: request => executeDesktopAiRequest(request),
    models: request => executeDesktopAiRequest(request, 'GET'),
    cancel: async id => cancelDesktopAiRequest(id)
  } };
  const context = { window, URL, AbortController, crypto: webcrypto, fetch: fetchImpl,
    setTimeout, clearTimeout, TypeError, console, localModelProxyAvailable: false,
    normalizeModelIds: ids => [...new Set(ids.filter(Boolean))],
    validateModelConnection: config => { assert.ok(config.baseUrl && (config.apiKey || config.managedToken)); },
    AI_GENERATION_TIMEOUT: 2000, AI_CONNECTION_TIMEOUT: 1000, WORK_MODEL_MAX_ATTEMPTS: 2 };
  return vm.runInNewContext(`(() => {${source.slice(start, end)}; return { chatCompletionUrl, modelRequestUrl, modelCatalogUrl,
    readModelResponse, modelErrorMessage, requestModel, requestModelWithRetry, testModelConnection, isRetryableModelError }; })()`, context);
}
const h = helpers();
const endpoints = [
  ['https://gateway.example', 'https://gateway.example/v1/chat/completions'],
  ['https://gateway.example/', 'https://gateway.example/v1/chat/completions'],
  ['https://gateway.example/v1/', 'https://gateway.example/v1/chat/completions'],
  ['https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/chat/completions'],
  ['https://gateway.example/chat/completions', 'https://gateway.example/chat/completions'],
  ['https://gateway.example/compatible-mode/v1', 'https://gateway.example/compatible-mode/v1/chat/completions'],
  ['https://gateway.example/api/v2?region=cn#guide', 'https://gateway.example/api/v2/chat/completions?region=cn'],
];
for (const [input, expected] of endpoints) assert.equal(h.chatCompletionUrl(input), expected);
assert.equal(h.modelCatalogUrl('https://gateway.example'), 'https://gateway.example/v1/models');
assert.equal(h.modelRequestUrl({ baseUrl: 'https://gateway.example', source: 'cc-switch', wireApi: 'responses' }), 'https://gateway.example/responses');
assert.equal(h.modelRequestUrl({ baseUrl: 'https://gateway.example/v1', source: 'cc-switch', wireApi: 'responses' }), 'https://gateway.example/v1/responses');
for (const address of ['not a url', 'file:///tmp/model', 'https://user:pass@gateway.example/v1', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/responses']) {
  assert.throws(() => h.chatCompletionUrl(address));
}
console.log('PASS compatible endpoint normalization, explicit prefixes, unsupported protocols and model protocols');

const response = (status, body, contentType = 'application/json') => new Response(body, { status, headers: { 'content-type': contentType } });
for (const [status, body, type, expected] of [
  [200, '<!doctype html><title>Gateway</title>', 'text/html', /返回了网页/],
  [200, '<html>login</html>', 'application/json', /返回了网页/],
  [200, 'not-json sk-secret-token', 'text/plain', /内容格式/],
  [200, '{"choices":', 'application/json', /内容格式/],
  [200, '', 'application/json', /空内容/],
  [200, 'data: {"token":"value"}', 'text/event-stream', /流式/],
  [401, '{"error":{"message":"bad sk-secret-token"}}', 'application/json', /密钥未通过/],
  [403, '<html>Access denied</html>', 'text/html', /没有访问权限/],
  [404, 'missing', 'text/plain', /没有找到模型接口/],
  [404, '{"error":{"code":"model_not_found","message":"Opus 5.5"}}', 'application/json', /模型不可用/],
  [429, '{"error":{"message":"rate limit"}}', 'application/json', /请求过于频繁/],
  [429, '{"error":{"code":"insufficient_quota"}}', 'application/json', /账户额度不足/],
  [500, '<html>Oops</html>', 'text/html', /服务暂时异常/],
  [504, '', 'application/json', /响应超时/],
  [400, '{"error":{"code":"context_length_exceeded"}}', 'application/json', /超过模型可处理/],
  [200, '{"error":{"code":"invalid_api_key"}}', 'application/json', /密钥未通过/],
]) {
  await assert.rejects(h.readModelResponse(response(status, body, type)), error => {
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /sk-secret-token|Unexpected token|HTTP \d|<!doctype|SyntaxError/);
    return true;
  });
}
await assert.rejects(h.readModelResponse(response(200, '{}'), 'models'), /没有返回模型列表/);
assert.equal((await h.readModelResponse(response(200, '{"data":[{"id":"real-model-id"}]}'), 'models')).data[0].id, 'real-model-id');
for (const [legacy, expected] of [
  ['Unexpected token \'<\', "<!doctype" is not valid JSON', /返回了网页/],
  ['请求失败（HTTP 401）', /密钥未通过/],
  ['请求失败（HTTP 429）', /请求过于频繁/],
  ['TypeError: fetch failed', /无法连接模型服务/],
  ['certificate has expired', /安全证书/],
  ['getaddrinfo ENOTFOUND', /无法找到模型服务地址/],
  ['已停止。本次输入和已有结果已保留，可以重试。', /已停止/],
]) assert.match(h.modelErrorMessage(legacy), expected);
console.log('PASS Chinese response errors, provider status semantics, hidden raw diagnostics and historical parser errors');

let behavior = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    received.push({ method: req.method, path: req.url, payload: body ? JSON.parse(body) : null });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"test-model"}]}');
      return;
    }
    const result = { ...behavior };
    const send = () => { res.writeHead(result.status, { 'content-type': result.type || 'application/json' }); res.end(result.body); };
    if (result.delay) { const timer = setTimeout(send, result.delay); res.on('close', () => clearTimeout(timer)); }
    else send();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  for (const transport of ['direct', 'desktop']) {
    const live = helpers(transport);
    const config = { provider: 'custom', baseUrl, model: 'Opus 5.5', apiKey: 'fixture-key' };
    behavior = { status: 200, body: '{"choices":[{"message":{"content":"OK"}}]}' };
    assert.equal(await live.testModelConnection(config), transport === 'desktop' ? 'desktop-ipc' : 'direct');
    assert.equal(received.at(-1).path, '/v1/chat/completions');
    assert.equal(received.at(-1).payload.model, 'Opus 5.5', 'Never invent or substitute a model ID');
    assert.equal(received.at(-1).payload.max_tokens, 8);
    assert.equal(received.at(-1).payload.messages.length, 1, 'Connection probe contains only the probe, no document content');
    assert.equal(await live.testModelConnection({ ...config, provider: 'bailian' }), transport === 'desktop' ? 'desktop-ipc' : 'direct');
    assert.equal(received.at(-1).path, '/v1/models');
    behavior = { status: 200, body: '<!doctype html><title>Home</title>', type: 'text/html' };
    await assert.rejects(live.testModelConnection(config), /返回了网页/);
    behavior = { status: 401, body: '{"error":{"message":"invalid api key: fixture-key"}}' };
    await assert.rejects(live.testModelConnection(config), /密钥未通过/);
    behavior = { status: 200, body: '{"choices":[{"message":{"content":""}}]}' };
    await assert.rejects(live.testModelConnection(config), /没有返回可读取/);
    behavior = { status: 200, body: '{"choices":[{"message":{"content":[{"type":"text","text":"OK"}]}}]}' };
    assert.equal(await live.requestModel([], config, 1000), 'OK');
    behavior = { status: 200, body: '{"choices":[{"message":{"content":"late"}}]}', delay: 1500 };
    await assert.rejects(live.requestModel([], config, 30), /未返回|超时/);
    const controller = new AbortController();
    const pending = live.requestModel([], config, 1000, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
  }
  const failure = helpers('direct', async () => { throw new TypeError('fetch failed with fixture-key'); });
  await assert.rejects(failure.testModelConnection({ provider: 'custom', baseUrl, model: 'fixture', apiKey: 'fixture-key' }), /未能建立模型请求/);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('PASS localhost direct and shipping desktop transport, minimal probe, catalog special case, timeout/cancel and content validation');

assert.match(source, /showModelConnectionResult\(message\)/);
assert.match(source, /复制中转站提供的模型标识/);
const pdf = await readFile(new URL('../js/pdf-study.js', import.meta.url), 'utf8');
assert.match(pdf, /errorText\(ui\.error\)/);
assert.match(pdf, /errorText\(interrupted\.error\)/);
assert.match(pdf, /errorText\(item\.error\)/);
console.log('PASS persistent connection feedback, precise model guidance and historical PDF error presentation');
