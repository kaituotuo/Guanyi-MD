import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const main = read('desktop/main.cjs');
const transportSource = read('desktop/ai-transport.cjs');
const preload = read('desktop/preload.cjs');
const app = read('js/app.js');
const require = createRequire(import.meta.url);
const {
  cancelDesktopAiRequest,
  executeDesktopAiRequest,
  normalizedDesktopAiRequest: normalizeDesktopAiRequest
} = require('../desktop/ai-transport.cjs');

for (const marker of [
  "require('./ai-transport.cjs')",
  'installDesktopAiHandlers(ipcMain, trustedRenderer)',
  'disposeDesktopAiRequests()'
]) assert.ok(main.includes(marker), `desktop main process is missing ${marker}`);

for (const marker of [
  "ipcMain.handle('guanyi-ai:chat'",
  "ipcMain.handle('guanyi-ai:models'",
  "ipcMain.handle('guanyi-ai:cancel'",
  'MAX_BODY_SIZE',
  'MAX_RESPONSE_SIZE',
  "redirect: 'error'"
]) assert.ok(transportSource.includes(marker), `desktop model transport is missing ${marker}`);

for (const marker of [
  "chat: (request) => ipcRenderer.invoke('guanyi-ai:chat'",
  "models: (request) => ipcRenderer.invoke('guanyi-ai:models'",
  "cancel: (requestId) => ipcRenderer.invoke('guanyi-ai:cancel'"
]) assert.ok(preload.includes(marker), `preload model bridge is missing ${marker}`);

const valid = normalizeDesktopAiRequest({
  requestId: 'qa-request_1',
  targetUrl: 'https://model.example/v1/chat/completions',
  apiKey: 'qa-key',
  timeoutMs: 999999,
  payload: { model: 'qa', messages: [{ role: 'user', content: '只回复 OK' }] }
});
assert.equal(valid.targetUrl, 'https://model.example/v1/chat/completions');
assert.equal(valid.timeoutMs, 300000, 'desktop model timeout should be capped at five minutes');
assert.equal(JSON.parse(valid.body).model, 'qa');
const requestWithBudget = (timeoutMs) => ({
  requestId: 'qa-budget', targetUrl: 'https://model.example/v1/chat/completions',
  apiKey: 'qa-key', payload: { model: 'qa', messages: [] }, timeoutMs
});
assert.equal(normalizeDesktopAiRequest(requestWithBudget(undefined)).timeoutMs, 30000,
  'ordinary desktop requests must retain their existing default');
assert.equal(normalizeDesktopAiRequest(requestWithBudget(90000)).timeoutMs, 90000,
  'ordinary Web requests must retain their existing budget');
assert.equal(normalizeDesktopAiRequest(requestWithBudget(300000)).timeoutMs, 300000,
  'paper reading must retain its full five-minute budget');
assert.equal(normalizeDesktopAiRequest(requestWithBudget(1)).timeoutMs, 1000,
  'short requests must retain the existing lower bound');

// Advance only this isolated transport's timers; no real model or five-minute wait.
let elapsedMs = 0;
let nextTimer = 0;
const scheduled = new Map();
const isolatedModule = { exports: {} };
vm.runInNewContext(transportSource, {
  module: isolatedModule, URL, Buffer, AbortController,
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    scheduled.set(id, { at: elapsedMs + delay, callback });
    return id;
  },
  clearTimeout(id) { scheduled.delete(id); }
});
const isolatedTransport = isolatedModule.exports;
const advance = (milliseconds) => {
  elapsedMs += milliseconds;
  for (const [id, timer] of scheduled) {
    if (timer.at <= elapsedMs) { scheduled.delete(id); timer.callback(); }
  }
};
let budgetSignal;
const budgetRequest = isolatedTransport.executeDesktopAiRequest(requestWithBudget(300000), 'POST', (_url, options) => {
  budgetSignal = options.signal;
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
});
const budgetRejection = assert.rejects(budgetRequest, error => error.code === 'MODEL_ABORTED');
advance(120001);
assert.equal(budgetSignal.aborted, false, 'paper reading must survive the previous two-minute cutoff');
advance(179998);
assert.equal(budgetSignal.aborted, false, 'the full five-minute budget remains available');
advance(1);
await budgetRejection;
assert.equal(budgetSignal.aborted, true, 'the extended request still expires at five minutes');
assert.equal(scheduled.size, 0, 'timeout cleanup must release the transport timer');
assert.equal(isolatedTransport.cancelDesktopAiRequest('qa-budget'), false,
  'finished requests must be removed from the cancellation registry');
assert.throws(() => normalizeDesktopAiRequest({
  requestId: 'qa', targetUrl: 'file:///tmp/model', apiKey: 'key', payload: {}
}), /http:\/\/ 或 https:\/\//);
assert.throws(() => normalizeDesktopAiRequest({
  requestId: 'qa', targetUrl: 'https://user:pass@model.example/v1', apiKey: 'key', payload: {}
}), /不含账号信息/);
assert.throws(() => normalizeDesktopAiRequest({
  requestId: 'qa', targetUrl: 'https://model.example/v1', apiKey: 'bad\nkey', payload: {}
}), /API Key/);
assert.throws(() => normalizeDesktopAiRequest({
  requestId: 'qa', targetUrl: 'https://model.example/v1', apiKey: 'key', payload: { text: 'x'.repeat(1024 * 1024) }
}), /1 MB/);

let receivedBody = null;
let receivedAuthorization = '';
const server = createServer((request, response) => {
  receivedAuthorization = String(request.headers.authorization || '');
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'qa-model' }] }));
    return;
  }
  if (request.url === '/large') {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) });
    response.end('{}');
    return;
  }
  if (request.url === '/slow') {
    const timer = setTimeout(() => { response.writeHead(200); response.end('{}'); }, 3000);
    response.on('close', () => clearTimeout(timer));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const status = request.url === '/limited' ? 429 : 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200
      ? { choices: [{ message: { content: 'OK' } }] }
      : { error: { message: 'limited' } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const chat = await executeDesktopAiRequest({
    requestId: 'live-chat', targetUrl: `${baseUrl}/v1/chat/completions`, apiKey: 'live-key',
    payload: { model: 'qa-model', messages: [{ role: 'user', content: '只回复 OK' }] }, timeoutMs: 5000
  });
  assert.equal(chat.ok, true);
  assert.equal(JSON.parse(chat.bodyText).choices[0].message.content, 'OK');
  assert.equal(receivedBody.model, 'qa-model');
  assert.equal(receivedAuthorization, 'Bearer live-key');

  const models = await executeDesktopAiRequest({
    requestId: 'live-models', targetUrl: `${baseUrl}/v1/models`, apiKey: 'live-key', timeoutMs: 5000
  }, 'GET');
  assert.equal(JSON.parse(models.bodyText).data[0].id, 'qa-model');

  const limited = await executeDesktopAiRequest({
    requestId: 'live-limited', targetUrl: `${baseUrl}/limited`, apiKey: 'live-key', payload: {}, timeoutMs: 5000
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429, 'HTTP status should remain available to renderer retry classification');

  await assert.rejects(executeDesktopAiRequest({
    requestId: 'live-large', targetUrl: `${baseUrl}/large`, apiKey: 'live-key', payload: {}, timeoutMs: 5000
  }), /2 MB/);

  const slow = executeDesktopAiRequest({
    requestId: 'live-cancel', targetUrl: `${baseUrl}/slow`, apiKey: 'live-key', payload: {}, timeoutMs: 300000
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const cancelledAt = performance.now();
  assert.equal(cancelDesktopAiRequest('live-cancel'), true);
  await assert.rejects(slow, /取消或超时/);
  assert.ok(performance.now() - cancelledAt < 1000, 'manual cancellation must stay prompt with a five-minute budget');
  assert.equal(cancelDesktopAiRequest('live-cancel'), false, 'cancelled requests must be removed');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

assert.match(app, /if \(desktopModelApi\(\)\)[\s\S]+desktopModelFetch\('chat'/,
  'desktop renderer should route chat requests through the IPC bridge before web transports');
assert.match(app, /desktopModelFetch\('models'[\s\S]+detectLocalModelProxy/,
  'desktop model catalog should use IPC while web builds keep their local proxy fallback');
assert.match(app, /const abort = \(\) => \{ api\.cancel\(requestId\)\.catch\(\(\) => \{\}\); \};/,
  'desktop cancellation should address the matching main-process request');
assert.match(app, /signal\?\.addEventListener\?\.\('abort', abort, \{ once: true \}\)/,
  'stale work requests should listen for cancellation');
assert.match(app, /requestModelWithRetry[\s\S]+attempts[\s\S]+isRetryableModelError/,
  'model availability should retain one bounded retry for transient failures');

console.log('desktop AI bridge tests passed: five-minute paper budget, unchanged ordinary defaults, trusted IPC, bounded input/output, prompt cancellation and web fallback contracts verified');
