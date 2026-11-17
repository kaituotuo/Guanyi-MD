import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CC_SWITCH_PATH, PROXY_HEALTH_PATH, PROXY_MODELS_PATH, PROXY_PATH, createLocalServer, workspaceIdentity } from './dev-server.mjs';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'guanyi-web-bridge-'));
const projectRoot = path.join(fixtureRoot, 'app');
await mkdir(projectRoot);
await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ version: 'fixture-version' }));
await writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><title>fixture</title>');
await writeFile(path.join(projectRoot, 'module.mjs'), 'export const fixture = true;');
await writeFile(path.join(projectRoot, 'font.wasm'), 'fixture');
await writeFile(path.join(fixtureRoot, 'outside-secret.txt'), 'must-not-serve');
await symlink(path.join(fixtureRoot, 'outside-secret.txt'), path.join(projectRoot, 'outside.txt'));
const received = [];
let closedSlow;
const slowClosed = () => new Promise(resolve => { closedSlow = resolve; });
const upstream = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    received.push({ url: request.url, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'],
      anthropicVersion: request.headers['anthropic-version'], body });
    if (request.url.includes('/slow/')) {
      const timer = setTimeout(() => { response.writeHead(200); response.end('{}'); }, 3000);
      response.on('close', () => { clearTimeout(timer); closedSlow?.(); });
      return;
    }
    if (request.url.includes('/large/')) {
      response.writeHead(200, { 'content-length': 2 * 1024 * 1024 + 1 }); response.end('{}'); return;
    }
    if (request.url.includes('/denied/')) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `invalid_api_key ${request.headers.authorization}` } })); return;
    }
    if (request.url.includes('/redirect/')) {
      response.writeHead(302, { location: 'https://must-not-follow.example/' }); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    const credential = request.headers['x-api-key'] || String(request.headers.authorization || '').replace(/^Bearer /, '');
    response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'fixture-model' }] }
      : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture answer' }] }],
        choices: [{ message: { content: 'fixture answer' } }], content: [{ type: 'text', text: 'fixture answer' }],
        accidentalCredentialEcho: credential }));
  });
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
await listen(upstream);
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
let current = { sourceApp: 'codex', sourceLabel: 'fixture A', model: 'fixture-model-A',
  baseUrl: `${upstreamUrl}/a/v1`, apiKey: 'fixture-key-A', wireApi: 'responses' };
let claudeCurrent = { sourceApp: 'claude', sourceLabel: 'fixture Claude', model: 'fixture-claude-model',
  baseUrl: `${upstreamUrl}/claude-relay`, apiKey: 'fixture-claude-key', wireApi: 'anthropic', authType: 'api-key' };
let explicitCodexUnavailable = false;
let readFailure = false;
let reads = 0;
let timestamp = 100000;
const server = createLocalServer({ projectRoot, now: () => timestamp, snapshotTtlMs: 30 * 60 * 1000,
  readCurrentConnection: (options = {}) => {
    reads += 1;
    if (readFailure) throw Object.assign(new Error('CC Switch 当前未启用可用配置'), { code: 'CC_SWITCH_CONFIG_ERROR' });
    if (options.sourceApp === 'claude') return { ...claudeCurrent };
    if (options.sourceApp === 'codex' && explicitCodexUnavailable) throw Object.assign(new Error('CC Switch 当前 Codex 未配置可用模型'), { code: 'CC_SWITCH_CONFIG_ERROR' });
    return { ...current };
  },
  listCurrentConnections: () => ({ connections: [current, claudeCurrent], unavailable: [] })
});
assert.equal(server.timeout, 0, 'the local HTTP server must not cut off an active model response before its request budget');
await listen(server);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = { origin: baseUrl, 'content-type': 'application/json', 'x-guanyi-local-request': '1' };
const post = (endpoint, body = {}, extra = {}) => fetch(baseUrl + endpoint, {
  method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body)
});
const importCurrent = async () => {
  const response = await post(CC_SWITCH_PATH);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(current.apiKey), 'CC metadata must never contain its actual key');
  return JSON.parse(text);
};
try {
  const health = await fetch(baseUrl + PROXY_HEALTH_PATH).then(response => response.json());
  assert.equal(health.app, 'guanyi-reader-local');
  assert.equal(health.apiVersion, 2);
  assert.equal(health.workspaceId, workspaceIdentity(projectRoot));
  assert.equal(health.version, 'fixture-version');
  assert.equal(health.capabilities.managedModels, true);
  assert.equal((await fetch(baseUrl + '/module.mjs')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(baseUrl + '/font.wasm')).headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(baseUrl + '/outside.txt')).status, 404, 'symlinks must not expose files outside this workspace');
  assert.equal((await fetch(baseUrl + '/.tmp-test/state.json')).status, 404, 'private local state must not be served');
  assert.equal((await fetch(baseUrl + CC_SWITCH_PATH)).status, 405);
  for (const origin of ['null', 'https://hostile.example', 'http://127.0.0.1:1']) {
    const response = await post(CC_SWITCH_PATH, {}, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'CC data must not be exposed through CORS');
  }
  assert.equal((await post(CC_SWITCH_PATH, {}, { origin: '' })).status, 403);
  assert.equal((await post(CC_SWITCH_PATH, {}, { 'x-guanyi-local-request': '' })).status, 403);
  assert.equal((await post(CC_SWITCH_PATH, {}, { 'content-type': 'text/plain' })).status, 415);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(baseUrl + PROXY_HEALTH_PATH, { headers: { host: 'hostile.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403, 'DNS rebinding hostnames must be rejected');
  assert.equal(reads, 0, 'rejected requests must not read the credential store');
  const catalogResponse = await post(CC_SWITCH_PATH, { action: 'list' });
  assert.equal(catalogResponse.status, 200);
  const catalogText = await catalogResponse.text();
  assert.doesNotMatch(catalogText, /apiKey|managedToken|fixture-key-A|fixture-claude-key/,
    'the server independently allowlists list metadata without creating a request token');
  const catalog = JSON.parse(catalogText);
  assert.deepEqual(catalog.connections.map(item => item.sourceApp), ['codex', 'claude']);
  assert.deepEqual(catalog.connections.map(item => item.baseUrl), [`${upstreamUrl}/a/v1`, `${upstreamUrl}/claude-relay`]);
  const selectedCodex = await (await post(CC_SWITCH_PATH, { sourceApp: 'codex' })).json();
  const selectedClaude = await (await post(CC_SWITCH_PATH, { sourceApp: 'claude' })).json();
  assert.equal(selectedCodex.sourceApp, 'codex');
  assert.equal(selectedClaude.sourceApp, 'claude');
  assert.notEqual(selectedCodex.managedToken, selectedClaude.managedToken);
  claudeCurrent = { ...claudeCurrent, apiKey: 'fixture-claude-updated', baseUrl: `${upstreamUrl}/claude-updated`, model: 'fixture-claude-updated-model' };
  assert.equal((await post(PROXY_PATH, { managedToken: selectedCodex.managedToken, payload: { model: selectedCodex.model, input: [] } })).status, 200);
  assert.equal(received.at(-1).authorization, 'Bearer fixture-key-A');
  assert.equal(received.at(-1).url, '/a/v1/responses');
  assert.equal((await post(PROXY_PATH, { managedToken: selectedClaude.managedToken, payload: { model: selectedClaude.model, messages: [] } })).status, 200);
  assert.equal(received.at(-1).apiKey, 'fixture-claude-key');
  assert.equal(received.at(-1).url, '/claude-relay/v1/messages');
  const refreshedClaude = await (await post(CC_SWITCH_PATH, { sourceApp: 'claude' })).json();
  assert.equal(refreshedClaude.model, 'fixture-claude-updated-model');
  assert.equal((await post(PROXY_PATH, { managedToken: refreshedClaude.managedToken, payload: { model: refreshedClaude.model, messages: [] } })).status, 200);
  assert.equal(received.at(-1).apiKey, 'fixture-claude-updated');
  assert.equal(received.at(-1).url, '/claude-updated/v1/messages');
  explicitCodexUnavailable = true;
  assert.equal((await post(CC_SWITCH_PATH, { sourceApp: 'codex' })).status, 422, 'unavailable explicit source must fail despite another valid source');
  explicitCodexUnavailable = false;
  const readsBeforeInvalid = reads;
  assert.equal((await post(CC_SWITCH_PATH, { sourceApp: 'other' })).status, 400);
  assert.equal((await post(CC_SWITCH_PATH, { action: 'other' })).status, 400);
  assert.equal(reads, readsBeforeInvalid, 'invalid requests never read credentials');

  const originalConnection = current;
  for (const [wireApi, suffix] of [['chat', 'responses'], ['responses', 'messages'], ['anthropic', 'chat/completions']]) {
    current = { ...originalConnection, wireApi, baseUrl: `${upstreamUrl}/v1/${suffix}` };
    const mismatch = await post(CC_SWITCH_PATH);
    assert.equal(mismatch.status, 422, 'a mismatched explicit protocol endpoint must not be silently rewritten');
    assert.match((await mismatch.json()).error.message, /接口类型不匹配/);
  }
  for (const [wireApi, configuredPath, expectedPath] of [
    ['responses', '', '/responses'],
    ['responses', '/responses?route=root', '/responses?route=root'],
    ['responses', '/prefix', '/prefix/responses'],
    ['chat', '', '/v1/chat/completions'],
    ['anthropic', '', '/v1/messages']
  ]) {
    current = { ...originalConnection, wireApi, baseUrl: upstreamUrl + configuredPath };
    const imported = await importCurrent();
    assert.equal((await post(PROXY_PATH, { managedToken: imported.managedToken,
      payload: { model: imported.model, input: [], messages: [] } })).status, 200);
    assert.equal(received.at(-1).url, expectedPath, 'managed endpoints must follow the configured protocol base path');
  }
  current = { ...originalConnection, baseUrl: `${upstreamUrl}/a/v1/responses?route=fixture` };
  const explicit = await importCurrent();
  assert.equal((await post(PROXY_PATH, { managedToken: explicit.managedToken, payload: { model: explicit.model, input: [] } })).status, 200);
  assert.equal(received.at(-1).url, '/a/v1/responses?route=fixture', 'explicit matching endpoints and request query parameters are retained');
  current = originalConnection;

  const first = await importCurrent();
  assert.equal(first.model, 'fixture-model-A');
  assert.ok(first.managedToken && !Object.hasOwn(first, 'apiKey'));
  current = { sourceApp: 'claude', sourceLabel: 'fixture B', model: 'fixture-model-B',
    baseUrl: `${upstreamUrl}/b`, apiKey: 'fixture-key-B', wireApi: 'anthropic', authType: 'api-key' };
  let response = await post(PROXY_PATH, { managedToken: first.managedToken,
    targetUrl: 'https://must-not-receive-key.example', payload: { model: first.model, input: [] } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /fixture-key-A/, 'even accidental upstream success echoes must not disclose the key');
  assert.equal(received.at(-1).url, '/a/v1/responses', 'an in-flight action retains the exact connection it started with');
  assert.equal(received.at(-1).authorization, 'Bearer fixture-key-A');
  const second = await importCurrent();
  assert.equal(second.model, 'fixture-model-B');
  response = await post(PROXY_PATH, { managedToken: second.managedToken, payload: { model: second.model, messages: [] } });
  assert.equal(response.status, 200);
  assert.equal(received.at(-1).url, '/b/v1/messages');
  assert.equal(received.at(-1).apiKey, 'fixture-key-B');
  assert.equal(received.at(-1).anthropicVersion, '2023-06-01');
  const before = received.length;
  assert.equal((await post(PROXY_PATH, { managedToken: second.managedToken, payload: { model: 'other-model' } })).status, 409);
  assert.equal(received.length, before, 'a managed token cannot select another model');
  response = await post(PROXY_MODELS_PATH, { managedToken: second.managedToken });
  assert.equal(response.status, 200); assert.equal(received.at(-1).url, '/b/v1/models');
  readFailure = true;
  assert.equal((await post(CC_SWITCH_PATH)).status, 422, 'a new action must fail if no current CC configuration is available');
  readFailure = false;
  timestamp += 30 * 60 * 1000 + 1;
  assert.equal((await post(PROXY_PATH, { managedToken: first.managedToken, payload: { model: first.model } })).status, 409);

  response = await post(PROXY_PATH, { targetUrl: `${upstreamUrl}/manual/v1/chat/completions`,
    payload: { model: 'fixture-manual', messages: [] }, wireApi: 'chat' }, { authorization: 'Bearer fixture-manual-key' });
  assert.equal(response.status, 200); assert.equal(received.at(-1).authorization, 'Bearer fixture-manual-key');
  assert.doesNotMatch(await response.text(), /fixture-manual-key/);
  for (const [route, expected] of [['denied', 401], ['large', 502], ['redirect', 502]]) {
    response = await post(PROXY_PATH, { targetUrl: `${upstreamUrl}/${route}/v1/chat/completions`,
      payload: { model: 'fixture', messages: [] } }, { authorization: 'Bearer fixture-manual-key' });
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /fixture-manual-key|must-not-follow/, 'diagnostics must not expose upstream request details');
  }
  response = await post(PROXY_PATH, { targetUrl: `${upstreamUrl}/slow/v1/chat/completions`, timeoutMs: 1000,
    payload: { model: 'fixture', messages: [] } }, { authorization: 'Bearer fixture-manual-key' });
  assert.equal(response.status, 504, 'a model timeout must be bounded');
  const closed = slowClosed();
  const controller = new AbortController();
  const cancelled = fetch(baseUrl + PROXY_PATH, { method: 'POST', headers: { ...headers, authorization: 'Bearer fixture-manual-key' },
    signal: controller.signal, body: JSON.stringify({ targetUrl: `${upstreamUrl}/slow/v1/chat/completions`,
      timeoutMs: 300000, payload: { model: 'fixture', messages: [] } }) });
  await new Promise(resolve => setTimeout(resolve, 70)); controller.abort();
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream cancellation timed out')), 2000))]);
  response = await post(PROXY_PATH, { payload: { text: 'x'.repeat(1024 * 1024 + 1) } });
  assert.equal(response.status, 413);
  assert.equal((await readFile(path.join(fixtureRoot, 'outside-secret.txt'), 'utf8')), 'must-not-serve');
  console.log('Web local bridge: same-origin isolation, server-held CC keys, live selection, action snapshots, protocols, limits and cancellation passed');
} finally {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await rm(fixtureRoot, { recursive: true, force: true });
}
