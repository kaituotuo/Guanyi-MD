import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createLocalServer, PROXY_PATH } from './dev-server.mjs';

const require = createRequire(import.meta.url);
const { executeDesktopAiRequest, normalizedDesktopAiRequest } = require('../desktop/ai-transport.cjs');
const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function chatCompletionUrl(');
const end = source.indexOf('  function parseAiReadingResponse(', start);
const captured = [];
const fixtureFetch = async (url, init) => {
  captured.push({ url, headers: init.headers, payload: JSON.parse(init.body) });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'visual answer' } }],
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'visual answer' }] }],
    content: [{ type: 'text', text: 'visual answer' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const context = { window: { location: { protocol: 'file:', hostname: '' }, guanyiDesktop: { ai: {
  chat: request => executeDesktopAiRequest(request, 'POST', fixtureFetch), models: async () => ({}), cancel: async () => true
} } }, URL, AbortController, crypto: webcrypto, setTimeout, clearTimeout, TypeError,
  AI_GENERATION_TIMEOUT: 2000, AI_CONNECTION_TIMEOUT: 1000, WORK_MODEL_MAX_ATTEMPTS: 2,
  localModelProxyAvailable: false };
const helpers = vm.runInNewContext(`(() => {${source.slice(start, end)}; return {requestModel, modelWireMessages, modelServiceError};})()`, context);
const image = `data:image/jpeg;base64,${Buffer.from([255,216,255,224,1,2,3,4,5,6,255,217]).toString('base64')}`;
const original = [{ role: 'system', content: 'Read the supplied page.' }, { role: 'user', content: [
  { type: 'text', text: 'V1 page 2' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }
] }];
for (const wireApi of ['chat', 'responses', 'anthropic']) {
  assert.equal(await helpers.requestModel(original, { model: 'vision-fixture', wireApi, baseUrl: 'https://vision.invalid/v1', apiKey: 'fixture-key' }, 2000), 'visual answer');
  const call = captured.at(-1);
  const content = (call.payload.input || call.payload.messages).find(message => message.role === 'user').content;
  assert.equal(content[0].type, wireApi === 'responses' ? 'input_text' : 'text');
  assert.equal(content[0].text, 'V1 page 2');
  if (wireApi === 'anthropic') {
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].source.media_type, 'image/jpeg');
    assert.equal(content[1].source.data, image.split(',')[1]);
    assert.equal(call.payload.system, original[0].content);
    assert.equal(call.headers['x-api-key'], 'fixture-key');
  } else {
    assert.equal(content[1].type, wireApi === 'responses' ? 'input_image' : 'image_url');
    assert.equal(wireApi === 'responses' ? content[1].image_url : content[1].image_url.url, image);
  }
}
assert.equal(original[1].content[1].type, 'image_url', 'Protocol conversion never mutates shared canonical input');
for (const badUrl of ['https://private.invalid/image.png', 'data:text/html;base64,AAAA', 'data:image/jpeg;base64,not-base64']) {
  assert.throws(() => helpers.modelWireMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: badUrl } }] }], 'anthropic'), /页面图像/);
}
for (const detail of ['This model does not support image inputs sk-secret', 'unsupported image content type', '当前模型不支持图片输入']) {
  const error = helpers.modelServiceError(400, { error: { message: detail } });
  assert.match(error.message, /不支持图片输入/);
  assert.doesNotMatch(error.message, /sk-secret|base64/);
  assert.equal(error.retryable, false);
}
const largeData = Buffer.alloc(900000, 42).toString('base64');
const largeImage = `data:image/jpeg;base64,${largeData}`;
const visualPayload = { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: largeImage } }] }] };
const request = { requestId: 'large-vision', targetUrl: 'https://vision.invalid/v1/chat/completions', apiKey: 'fixture-key', payload: visualPayload };
assert.ok(Buffer.byteLength(normalizedDesktopAiRequest(request).body) > 1024 * 1024, 'A bounded visual batch can exceed the old text-only transport limit');
assert.throws(() => normalizedDesktopAiRequest({ ...request, payload: { ...visualPayload, excess: 'x'.repeat(12*1024*1024) } }), /12 MB/);
const server = createLocalServer({ fetchImpl: fixtureFetch });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const response = await fetch(origin + PROXY_PATH, { method: 'POST', headers: { origin, 'content-type': 'application/json',
    'x-guanyi-local-request': '1', authorization: 'Bearer fixture-key' }, body: JSON.stringify({ targetUrl: request.targetUrl, payload: visualPayload }) });
  assert.equal(response.status, 200);
  assert.equal(captured.at(-1).payload.messages[0].content[0].image_url.url, largeImage, 'Web bridge retains every image byte');
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('PASS Chat/Responses/Anthropic image protocols, unchanged source, bounded desktop/Web image bytes and unsupported-vision diagnostics');
