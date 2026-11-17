const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { installDesktopAiHandlers, disposeDesktopAiRequests } = require('../desktop/ai-transport.cjs');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('missing model settings output directory');
const userDataDirectory = path.join(outputDirectory, `user-data-${process.pid}`);
app.setPath('userData', userDataDirectory);

const CONFIG_KEY = 'md-editor-model-config-v1';
const SESSION_KEY = 'md-editor-model-session-key-v1';
const PERSISTENT_KEY = 'md-editor-model-persistent-key-v1';
const TEST_KEY = 'mock-model-settings-only';
const NEXT_KEY = 'mock-next-current-connection';
const CLAUDE_KEY = 'mock-claude-current-connection';
const CLAUDE_BEARER = 'mock-claude-current-bearer';
const LONG_MODEL = `mock-provider/${'long-model-name-'.repeat(13)}2026`;
const MODEL_IDS = ['mock-embedding', 'mock-alpha', 'mock-beta', LONG_MODEL];
const requests = [];
const screenshots = [];
let server;
let window;
let nextChatDelay = 0;
let mockOrigin;
let catalogFailure = 'missing';
let importCalls = 0;
let currentConnection;
let peerConnection;
let expectedFollowSource = 'codex';
let importFailure = false;
let nextDelayedImport = null;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const evaluate = (code) => window.webContents.executeJavaScript(code);

async function eventually(code, label, timeout = 10000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await evaluate(code);
    if (lastValue) return lastValue;
    await wait(40);
  }
  throw new Error(`${label} timed out (last value ${JSON.stringify(lastValue)})`);
}

async function eventuallyInMain(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`${label} timed out`);
}

async function readingResultModel() {
  return evaluate(`(() => {
    const hooks = window.__MD_EDITOR_TEST__;
    return hooks.getReviewState().documents[hooks.getState().currentDocId]?.ai?.model;
  })()`);
}

async function generateReading() {
  const previousCount = requests.filter((request) => request.method === 'POST').length;
  await evaluate(`document.getElementById('btn-generate-summary').click()`);
  await eventuallyInMain(() => requests.filter((request) => request.method === 'POST').length > previousCount, 'generation request');
  await eventually(`!document.getElementById('btn-generate-summary').disabled`, 'generation completion');
  assert.equal(await evaluate(`Boolean(document.querySelector('#summary-results .app-reading-error'))`), false,
    'a successful generation must render reading results');
  return requests.filter((request) => request.method === 'POST').at(-1);
}

async function assertNoStoredCredentials() {
  const keyStorage = await evaluate(`({ session: sessionStorage.getItem(${JSON.stringify(SESSION_KEY)}), persistent: localStorage.getItem(${JSON.stringify(PERSISTENT_KEY)}) })`);
  assert.deepEqual(keyStorage, { session: null, persistent: null }, 'following must not copy managed credentials into key storage');
  const containsManagedKey = await evaluate(`(() => {
    const managedKeys = ${JSON.stringify([TEST_KEY, NEXT_KEY, CLAUDE_KEY, CLAUDE_BEARER])};
    return [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => {
      const value = storage.getItem(key) || '';
      return managedKeys.some((secret) => value.includes(secret));
    }));
  })()`);
  assert.equal(containsManagedKey, false, 'following must not copy managed keys into other browser storage');
}

async function assertFollowingStorage() {
  assert.deepEqual(await storedConfig(), { source: 'cc-switch', sourceApp: expectedFollowSource }, 'following must persist only its source marker and explicit source application');
  await assertNoStoredCredentials();
}

function deferNextImport(connection, fail = false) {
  const delayed = { connection: { ...connection }, fail, started: false, release: null };
  nextDelayedImport = delayed;
  return delayed;
}

async function refreshFollowingDisplay(model) {
  const before = requests.length;
  await evaluate(`window.dispatchEvent(new Event('focus'))`);
  await eventually(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId === ${JSON.stringify(model)}`, 'refresh current CC Switch model');
  assert.equal(requests.length, before, 'refreshing active connection metadata must not send model requests');
}

async function rendererReady() {
  await eventually(`(() => {
    if (window.__MD_EDITOR_BOOT_ERROR__) throw new Error(window.__MD_EDITOR_BOOT_ERROR__);
    return Boolean(window.__MD_EDITOR_TEST__ && document.querySelectorAll('#document-tabs .app-document-tab').length);
  })()`, 'renderer boot');
}

async function reload() {
  await new Promise((resolve) => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.reload();
  });
  await rendererReady();
}

async function openSettings() {
  await evaluate(`(() => {
    const menu = document.getElementById('btn-app-menu');
    if (document.getElementById('app-menu').hidden) menu.click();
    document.querySelector('[data-app-command="model-settings"]').click();
  })()`);
  await eventually(`!document.getElementById('model-modal').hidden`, 'open model settings');
}

async function configureConnection(baseUrl) {
  await evaluate(`(() => {
    const provider = document.getElementById('model-provider');
    if (provider.value !== 'custom') {
      provider.value = 'custom';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const protocol = document.getElementById('model-wire-api');
    if (protocol.value !== 'chat') {
      protocol.value = 'chat';
      protocol.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const url = document.getElementById('model-base-url');
    url.value = ${JSON.stringify(baseUrl)};
    url.dispatchEvent(new Event('input', { bubbles: true }));
    const key = document.getElementById('model-api-key');
    key.value = ${JSON.stringify(TEST_KEY)};
    key.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function clickAndWait(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await eventually(`!document.getElementById(${JSON.stringify(id)}).disabled`, `${id} completion`);
}

async function saveSettings(connectionOnly = false) {
  await evaluate(`document.getElementById('model-form').requestSubmit()`);
  if (connectionOnly) {
    await eventually(`(() => {
      const saved = JSON.parse(localStorage.getItem(${JSON.stringify(CONFIG_KEY)}));
      return saved && saved.models.length === 0 && !document.querySelector('#model-form [type="submit"]').disabled;
    })()`, 'save connection without models');
    assert.equal(await evaluate(`document.getElementById('model-modal').hidden`), false,
      'a saved connection without models should keep manual add available');
    await evaluate(`document.getElementById('btn-model-close').click()`);
  } else {
    await eventually(`document.getElementById('model-modal').hidden`, 'save model settings');
  }
}

async function storedConfig() {
  return evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(CONFIG_KEY)}))`);
}

async function catalog() {
  return evaluate(`Array.from(document.querySelectorAll('#model-catalog-list input[type="checkbox"][data-model-id]'), (input) => ({
    id: input.dataset.modelId, checked: input.checked
  }))`);
}

async function selectModels(ids) {
  await evaluate(`(() => {
    const ids = ${JSON.stringify(ids)};
    for (const input of document.querySelectorAll('#model-catalog-list input[type="checkbox"][data-model-id]')) {
      if (input.checked !== ids.includes(input.dataset.modelId)) input.click();
    }
  })()`);
}

async function openModelSwitcher() {
  await evaluate(`(() => {
    if (document.getElementById('app-menu').hidden) document.getElementById('btn-app-menu').click();
    if (document.getElementById('model-switch-menu').hidden) document.getElementById('btn-switch-model').click();
  })()`);
  await eventually(`!document.getElementById('model-switch-menu').hidden`, 'open model submenu');
}

async function chooseModelSource(sourceApp, id) {
  await openModelSwitcher();
  await eventually(`Array.from(document.querySelectorAll('#model-switch-options [role="menuitemradio"]')).some(item => item.dataset.modelSource === ${JSON.stringify(sourceApp)} && item.dataset.modelId === ${JSON.stringify(id)} && !item.disabled)`, 'available selected model source');
  await evaluate(`Array.from(document.querySelectorAll('#model-switch-options [role="menuitemradio"]')).find(item => item.dataset.modelSource === ${JSON.stringify(sourceApp)} && item.dataset.modelId === ${JSON.stringify(id)}).click()`);
  await eventually(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId === ${JSON.stringify(id)}`, 'selected model display');
  if (sourceApp !== 'manual') expectedFollowSource = sourceApp;
}

async function selectActive(id) {
  await chooseModelSource('manual', id);
  assert.equal((await storedConfig()).model, id, 'switching model must persist the selected model');
}

async function screenshot(name) {
  await wait(100);
  const image = await window.webContents.capturePage();
  assert.equal(image.isEmpty(), false, `${name}: screenshot must contain pixels`);
  const filename = path.join(outputDirectory, `${name}.png`);
  await fs.writeFile(filename, image.toPNG());
  screenshots.push(filename);
}

async function inspectLayout(theme, width, height) {
  window.setContentSize(width, height);
  await evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    if (!document.getElementById('collab-drawer').classList.contains('is-open')) document.getElementById('btn-comments').click();
    document.querySelector('[data-collab-panel="reading"]').click();
  })()`);
  await wait(120);
  await openModelSwitcher();
  const shared = await evaluate(`(() => {
    const menu = document.getElementById('model-switch-menu');
    const active = menu.querySelector('[role="menuitemradio"][aria-checked="true"]');
    const rect = menu.getBoundingClientRect();
    const selected = active.getBoundingClientRect();
    const hit = document.elementFromPoint(selected.x + selected.width / 2, selected.y + selected.height / 2);
    return {
      count: document.querySelectorAll('#model-switch-menu').length,
      oldControlCount: document.querySelectorAll('#active-model').length,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      value: active.dataset.modelId, checked: active.getAttribute('aria-checked'),
      hit: hit === active || active.contains(hit), viewportWidth: innerWidth, viewportHeight: innerHeight,
      clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth
    };
  })()`);
  assert.equal(shared.count, 1, 'all workspaces share one model submenu');
  assert.equal(shared.oldControlCount, 0, 'model switching must not remain as a topbar select');
  assert.equal(shared.value, LONG_MODEL); assert.equal(shared.checked, 'true');
  assert.equal(shared.hit, true, `${theme}: selected model remains clickable above the review drawer`);
  assert.ok(shared.left >= -1 && shared.right <= shared.viewportWidth + 1 && shared.top >= -1 && shared.bottom <= shared.viewportHeight + 1,
    `${theme}: long model name and submenu must stay inside the viewport`);
  assert.ok(shared.scrollWidth <= shared.clientWidth + 1, `${theme}: long model name must not overflow the viewport`);
  await screenshot(`model-switcher-${theme}-${width}x${height}`);

  await openSettings();
  const modal = await evaluate(`(() => {
    const modal = document.querySelector('#model-modal .app-modal');
    const list = document.getElementById('model-catalog-list');
    const rect = modal.getBoundingClientRect();
    const footer = document.querySelector('#model-modal .app-modal__footer').getBoundingClientRect();
    const save = document.querySelector('#model-form [type="submit"]').getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      clientWidth: modal.clientWidth, scrollWidth: modal.scrollWidth,
      listClientWidth: list.clientWidth, listScrollWidth: list.scrollWidth,
      footerTop: footer.top, footerBottom: footer.bottom, saveTop: save.top, saveBottom: save.bottom
    };
  })()`);
  assert.ok(modal.left >= -1 && modal.right <= modal.viewportWidth + 1, `${theme}: settings must fit the window width`);
  assert.ok(modal.top >= -1 && modal.bottom <= modal.viewportHeight + 1, `${theme}: settings must fit the window height`);
  assert.ok(modal.scrollWidth <= modal.clientWidth + 1, `${theme}: settings must not scroll horizontally`);
  assert.ok(modal.listScrollWidth <= modal.listClientWidth + 1, `${theme}: long model ID must wrap inside the catalog`);
  assert.ok(modal.footerTop >= modal.top - 1 && modal.footerBottom <= modal.viewportHeight + 1,
    `${theme}: modal footer must remain visible in a narrow window`);
  assert.ok(modal.saveTop >= modal.footerTop - 1 && modal.saveBottom <= modal.footerBottom + 1,
    `${theme}: save button must remain inside the visible footer`);
  await screenshot(`model-settings-${theme}-${width}x${height}`);
  await evaluate(`document.getElementById('btn-model-close').click()`);
}

async function startMockServer() {
  server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const receivedKey = request.headers['x-api-key'] || String(request.headers.authorization || '').replace(/^Bearer /, '');
    const credentialId = new Map([[TEST_KEY, 'manual-or-codex-a'], [NEXT_KEY, 'codex-b'], [CLAUDE_KEY, 'claude-api-key'], [CLAUDE_BEARER, 'claude-bearer']]).get(receivedKey) || 'unknown';
    const expectedCredentials = request.url.startsWith('/claude/') ? ['claude-api-key', 'claude-bearer']
      : request.url.startsWith('/codex-b/') ? ['codex-b'] : ['manual-or-codex-a'];
    const record = { path: request.url, method: request.method, model: body?.model || null,
      hasChatMessages: Array.isArray(body?.messages), hasResponsesInput: Array.isArray(body?.input),
      hasSystem: Boolean(body?.system), maxTokens: body?.max_tokens || null,
      authType: request.headers['x-api-key'] ? 'api-key' : request.headers.authorization ? 'bearer' : 'missing',
      anthropicVersion: request.headers['anthropic-version'] || '', credentialId,
      authorized: expectedCredentials.includes(credentialId) };
    requests.push(record);
    response.setHeader('Content-Type', 'application/json');
    if (!record.authorized) {
      response.writeHead(401).end(JSON.stringify({ error: { message: 'Mock authentication failed' } }));
    } else if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [...MODEL_IDS, MODEL_IDS[0]].map((id) => ({ id })) }));
    } else if (request.method === 'GET' && request.url === '/single/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'only-model' }] }));
    } else if (request.method === 'GET' && request.url === '/missing/v1/models' && catalogFailure === 'invalid') {
      response.end(JSON.stringify({ unexpected: [] }));
    } else if (request.method === 'GET' && request.url === '/missing/v1/models' && catalogFailure === 'denied') {
      response.writeHead(401).end(JSON.stringify({ error: { message: 'Mock key has no catalog access' } }));
    } else if (request.method === 'GET' && request.url === '/missing/v1/models' && catalogFailure === 'method') {
      response.writeHead(405).end(JSON.stringify({ error: { message: 'Mock catalog method is unsupported' } }));
    } else if (request.method === 'GET' && request.url === '/invalid/v1/models') {
      response.end(JSON.stringify({ unexpected: [] }));
    } else if (request.method === 'GET' && request.url === '/denied/v1/models') {
      response.writeHead(401).end(JSON.stringify({ error: { message: 'Mock key has no catalog access' } }));
    } else if (request.method === 'POST' && ['/v1/chat/completions', '/missing/v1/chat/completions', '/v1/responses', '/codex-b/v1/responses', '/claude/v1/messages'].includes(request.url)) {
      const delay = nextChatDelay;
      nextChatDelay = 0;
      if (delay) await wait(delay);
      const content = JSON.stringify({
        summary: [{ title: '测试概览', text: '用于验证模型切换。' }], details: [], risks: []
      });
      response.end(JSON.stringify(request.url.endsWith('/messages')
        ? { content: [{ type: 'text', text: content }] }
        : request.url.endsWith('/responses')
          ? { output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }
          : { choices: [{ message: { content } }] }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { message: 'Mock catalog is unsupported' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mockOrigin = `http://127.0.0.1:${server.address().port}`;
  currentConnection = { baseUrl: `${mockOrigin}/v1`, apiKey: TEST_KEY, sourceLabel: '当前 Codex A',
    sourceApp: 'codex', wireApi: 'responses', authType: 'bearer', model: 'cc-alpha' };
  peerConnection = { baseUrl: `${mockOrigin}/claude/v1`, apiKey: CLAUDE_KEY, sourceLabel: '当前 Claude',
    sourceApp: 'claude', wireApi: 'anthropic', authType: 'api-key', model: 'claude-current' };
}

async function main() {
  await app.whenReady();
  await startMockServer();
  ipcMain.handle('guanyi-state:load', () => null);
  ipcMain.handle('guanyi-state:save', (_event, payload) => ({ savedAt: payload?.savedAt || Date.now() }));
  ipcMain.handle('guanyi-app:version', () => 'model-settings-test');
  ipcMain.handle('guanyi-semantic:status', () => ({ available: false, state: 'disabled' }));
  ipcMain.handle('guanyi-semantic:index', () => ({ available: false, indexed: 0 }));
  ipcMain.handle('guanyi-semantic:search', () => []);
  ipcMain.handle('guanyi-ai:import-cc-switch', (_event, options = {}) => {
    importCalls += 1;
    const connections = [currentConnection, peerConnection].filter((item, index, all) => item && all.findIndex(value => value?.sourceApp === item.sourceApp) === index);
    if (options.action === 'list') return { connections: connections.filter(item => !(importFailure && item.sourceApp === 'codex')).map(({ apiKey, ...metadata }) => metadata), unavailable: importFailure ? [{ sourceApp: 'codex', message: 'CC Switch Codex 当前配置不可用' }] : [] };
    const sourceApp = options.sourceApp || 'codex';
    if (nextDelayedImport) {
      const delayed = nextDelayedImport;
      nextDelayedImport = null;
      delayed.started = true;
      return new Promise((resolve, reject) => {
        delayed.release = () => delayed.fail
          ? reject(new Error('Mock delayed CC Switch lookup failure'))
          : resolve({ ...delayed.connection });
      });
    }
    if (importFailure && sourceApp === 'codex') throw new Error('Mock CC Switch active connection unavailable');
    const selected = connections.find(item => item.sourceApp === sourceApp);
    if (!selected) throw new Error('Mock requested CC Switch source unavailable');
    return { ...selected };
  });
  installDesktopAiHandlers(ipcMain, (event) => {
    assert.equal(event.sender, window.webContents, 'AI requests must originate from this test renderer');
  });
  const errors = [];
  window = new BrowserWindow({
    width: 1280, height: 820, useContentSize: true, show: false,
    webPreferences: { preload: path.join(projectRoot, 'desktop/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  // The isolated profile starts with no user keys or documents. Refuse outbound traffic.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const target = new URL(details.url);
    callback({ cancel: ['http:', 'https:'].includes(target.protocol) && target.origin !== mockOrigin });
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || Number(event.level) >= 3) errors.push(String(event.message));
  });
  await window.loadFile(path.join(projectRoot, 'index.html'), { query: { client: 'desktop' } });
  await rendererReady();
  await openSettings();
  await configureConnection(`${mockOrigin}/v1`);

  await clickAndWait('btn-model-test');
  assert.ok(requests.length > 0, 'testing URL and key must issue a request without a model');
  assert.ok(requests.every((request) => request.method === 'GET' && request.path.endsWith('/models')),
    'testing a connection must use the catalog and never send a generation request');
  await evaluate(`document.getElementById('btn-model-clear').click()`);
  await configureConnection(`${mockOrigin}/v1`);
  const beforeSave = requests.length;
  await saveSettings(true);
  let saved = await storedConfig();
  assert.ok(requests.length > beforeSave, 'saving a connection without models must try discovery');
  assert.deepEqual(saved.models, [], 'multiple discovered models must wait for an explicit selection');
  assert.equal(saved.model, '', 'an arbitrary first model could be an embedding model and must not be selected');
  assert.ok((await catalog()).every((entry) => !entry.checked), 'multiple models must be initially unchecked');
  assert.equal(Object.hasOwn(saved, 'apiKey'), false, 'metadata must not contain the API key');

  await openSettings();
  await clickAndWait('btn-model-fetch');
  assert.deepEqual((await catalog()).map((entry) => entry.id), MODEL_IDS, 'catalog must deduplicate model IDs');
  await selectModels(['mock-alpha']);
  await saveSettings();
  assert.equal((await storedConfig()).model, 'mock-alpha', 'the first explicitly selected model must become active');
  await openSettings();
  await clickAndWait('btn-model-fetch');
  await selectModels(['mock-beta', LONG_MODEL]);
  await saveSettings();
  saved = await storedConfig();
  assert.deepEqual(saved.models, ['mock-beta', LONG_MODEL]);
  assert.equal(saved.model, 'mock-beta', 'deselecting current model must select an enabled model');
  await selectActive(LONG_MODEL);
  await reload();
  assert.equal(await evaluate(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId`), LONG_MODEL, 'active model must survive reload');
  assert.deepEqual((await storedConfig()).models, ['mock-beta', LONG_MODEL]);

  for (const [theme, width, height] of [['light', 1280, 820], ['dark', 920, 640], ['light', 390, 844]]) await inspectLayout(theme, width, height);

  // Exercise the actual generate button through the desktop bridge and mock HTTP service.
  await evaluate(`window.__MD_EDITOR_TEST__.setCurrentMarkdown('# 模型配置验收\\n\\n此文档只用于本地自动化。')`);
  nextChatDelay = 400;
  await evaluate(`document.getElementById('btn-generate-summary').click()`);
  await eventually(`document.getElementById('btn-generate-summary').disabled`, 'generation start');
  while (!requests.some((request) => request.method === 'POST')) await wait(20);
  await selectActive('mock-beta');
  await eventually(`!document.getElementById('btn-generate-summary').disabled`, 'generation completion');
  assert.equal(requests.filter((request) => request.method === 'POST').at(-1).model, LONG_MODEL,
    'changing active model must not mutate the in-flight request');
  const resultModel = await evaluate(`(() => {
    const hooks = window.__MD_EDITOR_TEST__;
    return hooks.getReviewState().documents?.[hooks.getState().currentDocId]?.ai?.model
      || hooks.getReviewState().docs?.[hooks.getState().currentDocId]?.ai?.model
      || Object.values(hooks.getReviewState()).find((entry) => entry?.ai)?.ai?.model;
  })()`);
  assert.equal(resultModel, LONG_MODEL, 'completed reading must retain the model used for that request');
  await evaluate(`document.getElementById('btn-generate-summary').click()`);
  await eventually(`!document.getElementById('btn-generate-summary').disabled`, 'second generation completion');
  assert.equal(requests.filter((request) => request.method === 'POST').at(-1).model, 'mock-beta',
    'the next request must use the newly selected model');

  await openSettings();
  const beforeFollowRequests = requests.length;
  await clickAndWait('btn-model-import-cc-switch');
  assert.ok(importCalls >= 1, 'CC Switch following must use the dedicated desktop API');
  await assertFollowingStorage();
  assert.equal(requests.length, beforeFollowRequests, 'enabling following must not send a catalog or generation request');
  assert.equal(await evaluate(`document.getElementById('model-follow-cc-switch').checked`), true,
    'enabling following must take effect immediately without saving');
  assert.equal(await evaluate(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelSource`), 'codex',
    'the model submenu must identify the followed Codex source');
  assert.equal(await evaluate(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId`), 'cc-alpha');
  assert.equal(await evaluate(`document.getElementById('model-catalog-list').getClientRects().length`), 0,
    'following must hide the independent manual model catalog');
  assert.equal(await evaluate(`document.getElementById('btn-model-test').getClientRects().length`), 0,
    'following must hide the manual connection test instead of showing an inactive action');
  await screenshot('cc-switch-follow-light-390x844');
  await evaluate(`document.getElementById('btn-model-close').click()`);
  const beforeFirstFollowCall = importCalls;
  const responseRequest = await generateReading();
  assert.ok(importCalls > beforeFirstFollowCall, 'each user generation must re-read the active connection');
  assert.equal(responseRequest.path, '/v1/responses', 'Responses connections must use the Responses endpoint');
  assert.equal(responseRequest.model, 'cc-alpha');
  assert.equal(responseRequest.hasResponsesInput, true, 'Responses connections must send the input message array');
  assert.equal(responseRequest.hasChatMessages, false, 'Responses requests must not send Chat Completions messages');
  assert.equal(responseRequest.credentialId, 'manual-or-codex-a');

  currentConnection = { ...currentConnection, baseUrl: `${mockOrigin}/codex-b/v1`, apiKey: NEXT_KEY,
    sourceLabel: '当前 Codex B', model: 'cc-beta' };
  const changedRequest = await generateReading();
  assert.equal(changedRequest.path, '/codex-b/v1/responses', 'the next action must use the new active URL');
  assert.equal(changedRequest.credentialId, 'codex-b', 'the next action must use the new active key');
  assert.equal(changedRequest.model, 'cc-beta', 'the next action must use the new active model');
  await assertFollowingStorage();

  // Refreshing the active connection while a request is running must not change its snapshot.
  nextChatDelay = 400;
  const beforePending = requests.filter((request) => request.method === 'POST').length;
  await evaluate(`document.getElementById('btn-generate-summary').click()`);
  await eventuallyInMain(() => requests.filter((request) => request.method === 'POST').length > beforePending, 'pending follow request');
  currentConnection = { ...currentConnection, baseUrl: `${mockOrigin}/v1`, apiKey: TEST_KEY,
    sourceLabel: '当前 Codex C', model: 'cc-gamma' };
  await refreshFollowingDisplay('cc-gamma');
  await eventually(`!document.getElementById('btn-generate-summary').disabled`, 'pending follow request completion');
  const pendingRequest = requests.filter((request) => request.method === 'POST').at(-1);
  assert.equal(pendingRequest.path, '/codex-b/v1/responses');
  assert.equal(pendingRequest.credentialId, 'codex-b');
  assert.equal(await readingResultModel(), 'cc-beta', 'a completed request must retain the model captured before the switch');
  assert.equal((await generateReading()).model, 'cc-gamma');

  const beforeFollowReload = requests.length;
  const beforeReloadImport = importCalls;
  await reload();
  await eventually(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId === 'cc-gamma'`, 'reload followed connection');
  assert.ok(importCalls > beforeReloadImport, 'reload must resolve the followed connection');
  assert.equal(requests.length, beforeFollowReload, 'reload must only read active metadata');
  await assertFollowingStorage();

  // Older focus reads must not overwrite a newer user action, including older failures.
  for (const fail of [false, true]) {
    const suffix = fail ? 'old-failure' : 'old-success';
    currentConnection = { ...currentConnection, baseUrl: `${mockOrigin}/v1`, apiKey: TEST_KEY,
      sourceLabel: '旧焦点读取 A', model: `focus-a-${suffix}` };
    await refreshFollowingDisplay(currentConnection.model);
    const delayed = deferNextImport(currentConnection, fail);
    await evaluate(`window.dispatchEvent(new Event('focus'))`);
    await eventuallyInMain(() => delayed.started, 'deferred focus read');
    currentConnection = { ...currentConnection, baseUrl: `${mockOrigin}/codex-b/v1`, apiKey: NEXT_KEY,
      sourceLabel: '新用户动作 B', model: `action-b-${suffix}` };
    const latestRequest = await generateReading();
    assert.equal(latestRequest.model, currentConnection.model, 'a new action must resolve its own current connection');
    assert.equal(latestRequest.credentialId, 'codex-b');
    delayed.release();
    await wait(120);
    assert.equal(await evaluate(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId`), currentConnection.model,
      `${suffix}: the older focus read must not overwrite the newer action's displayed model`);
    assert.equal(await evaluate(`document.getElementById('btn-generate-summary').disabled`), false,
      `${suffix}: an older failed lookup must not clear a newly resolved usable connection`);
    await assertFollowingStorage();
    assert.equal((await generateReading()).model, currentConnection.model,
      `${suffix}: later requests must continue to use the current active connection`);
  }

  // A failed current lookup must not send a request using the previously cached key.
  importFailure = true;
  const beforeFailedRefresh = requests.length;
  const beforeFailedImport = importCalls;
  await evaluate(`document.getElementById('btn-generate-summary').click()`);
  await eventuallyInMain(() => importCalls > beforeFailedImport, 'failed current connection lookup');
  await eventually(`Boolean(document.querySelector('#summary-results .app-reading-error'))`, 'failed followed reading');
  assert.equal(requests.length, beforeFailedRefresh, 'failed lookup must never use a stale connection');
  const followFailureMessage = await evaluate(`document.querySelector('#summary-results .app-reading-error').textContent`);
  assert.match(followFailureMessage, /CC Switch|模型服务|连接|配置/, 'a failed managed lookup must explain the next recovery step');
  assert.doesNotMatch(followFailureMessage, /Mock|guanyi-ai:|Error occurred|Bearer|sk-/, 'native lookup errors must remain sanitized');
  await assertFollowingStorage();

  await evaluate(`(() => {
    window.__MD_EDITOR_TEST__.setCurrentMarkdown('# 本地自动化\\n\\n此文档只用于本地自动化验收。');
    document.querySelector('[data-collab-panel="works"]').click();
    document.getElementById('reading-scope').value = 'current';
    document.getElementById('reading-question').value = '本地自动化';
    document.getElementById('btn-ask-work').click();
  })()`);
  await eventually(`['complete', 'failed'].includes(window.__MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status)`, 'local fallback after lookup failure');
  const localFallback = await evaluate(`window.__MD_EDITOR_TEST__.getState().workHistory.at(-1)`);
  assert.equal(localFallback.status, 'complete', `work question lookup failure must preserve a completed local fallback: ${JSON.stringify(localFallback)}`);
  assert.equal(localFallback.generatedByModel, false, 'work questions must retain local evidence if current lookup fails');
  assert.ok(localFallback.evidence.length > 0, 'work fallback must include local evidence');
  assert.equal(requests.length, beforeFailedRefresh, 'work fallback must not invoke a cached model connection');

  await openModelSwitcher();
  await eventually(`Boolean(document.querySelector('#model-switch-options [data-model-source="claude"]:not(:disabled)'))`, 'unselected Claude remains available');
  assert.equal((await storedConfig()).sourceApp, 'codex', 'unavailable selected Codex must not silently fall back to available Claude');
  await evaluate(`document.getElementById('btn-app-menu').click()`);
  importFailure = false;
  peerConnection = { ...currentConnection };
  currentConnection = { baseUrl: `${mockOrigin}/claude/v1`, apiKey: CLAUDE_KEY, sourceLabel: '当前 Claude',
    sourceApp: 'claude', wireApi: 'anthropic', authType: 'api-key', model: 'claude-current' };
  await chooseModelSource('claude', 'claude-current');
  await assertFollowingStorage();
  await refreshFollowingDisplay('claude-current');
  await evaluate(`document.querySelector('[data-collab-panel="reading"]').click()`);
  const claudeRequest = await generateReading();
  assert.equal(claudeRequest.path, '/claude/v1/messages', 'Claude connections must use the Anthropic Messages endpoint');
  assert.equal(claudeRequest.model, 'claude-current');
  assert.equal(claudeRequest.hasChatMessages, true);
  assert.equal(claudeRequest.hasSystem, true, 'Anthropic system instructions must be outside the messages array');
  assert.ok(claudeRequest.maxTokens > 0, 'Anthropic requests must set max_tokens');
  assert.equal(claudeRequest.authType, 'api-key');
  assert.equal(claudeRequest.credentialId, 'claude-api-key');
  assert.ok(claudeRequest.anthropicVersion, 'Anthropic requests must send the required API version');
  await assertFollowingStorage();

  currentConnection = { ...currentConnection, apiKey: CLAUDE_BEARER, authType: 'bearer', model: 'claude-current-bearer' };
  const bearerRequest = await generateReading();
  assert.equal(bearerRequest.model, 'claude-current-bearer');
  assert.equal(bearerRequest.authType, 'bearer');
  assert.equal(bearerRequest.credentialId, 'claude-bearer');
  await assertFollowingStorage();

  // Turning following off restores independent manual configuration and multiple models.
  await openSettings();
  await evaluate(`document.getElementById('model-follow-cc-switch').click()`);
  const emptyManual = await storedConfig();
  assert.notEqual(emptyManual.source, 'cc-switch', 'turning off following must immediately restore manual mode');
  assert.equal(emptyManual.baseUrl, '', 'turning off following must not copy the managed URL into manual configuration');
  assert.equal(emptyManual.model, '');
  assert.deepEqual(emptyManual.models, []);
  await assertNoStoredCredentials();
  assert.equal(await evaluate(`document.getElementById('model-base-url').value`), '');
  assert.equal(await evaluate(`document.getElementById('model-api-key').value`), '',
    'turning off following must leave a clean manual configuration');
  await configureConnection(`${mockOrigin}/v1`);
  await clickAndWait('btn-model-fetch');
  await selectModels(['mock-beta', LONG_MODEL]);
  await saveSettings();
  assert.deepEqual((await storedConfig()).models, ['mock-beta', LONG_MODEL]);
  assert.equal(await evaluate(`document.querySelectorAll('#model-switch-options [data-model-source="manual"]:not(:disabled)').length`), 2);
  await selectActive(LONG_MODEL);

  // A legacy single model becomes the enabled list without losing the key.
  await evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(CONFIG_KEY)}, JSON.stringify({ provider: 'custom', baseUrl: ${JSON.stringify(`${mockOrigin}/v1`)}, model: 'legacy-model' }));
    sessionStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(TEST_KEY)});
  })()`);
  await reload();
  assert.equal(await evaluate(`document.querySelector('#model-switch-options [aria-checked="true"]')?.dataset.modelId`), 'legacy-model');
  await openSettings();
  assert.ok((await catalog()).some((entry) => entry.id === 'legacy-model' && entry.checked), 'legacy model must appear as an enabled model');
  await saveSettings();
  assert.deepEqual((await storedConfig()).models, ['legacy-model']);

  // Manual IDs remain usable when catalog discovery is unsupported or invalid.
  await openSettings();
  await configureConnection(`${mockOrigin}/missing/v1`);
  await evaluate(`(() => {
    document.getElementById('model-name-custom').value = 'manual-model';
    document.getElementById('btn-model-add').click();
  })()`);
  assert.ok((await catalog()).some((entry) => entry.id === 'manual-model' && entry.checked), 'manual add must enable the model');
  await selectModels(['manual-model']);
  for (const endpoint of ['missing', 'invalid', 'denied', 'method']) {
    catalogFailure = endpoint;
    await clickAndWait('btn-model-fetch');
    assert.ok((await catalog()).some((entry) => entry.id === 'manual-model' && entry.checked),
      `${endpoint}: discovery failure must preserve manually enabled models`);
    const status = await evaluate(`document.getElementById('model-catalog-status').textContent`);
    assert.ok(status.trim(), `${endpoint}: discovery failure must explain the result`);
  }
  const beforeSelectedConnectionTest = requests.length;
  await clickAndWait('btn-model-test');
  const selectedTestRequests = requests.slice(beforeSelectedConnectionTest);
  assert.equal(selectedTestRequests.length, 1, 'an explicitly selected model should be tested directly');
  assert.equal(selectedTestRequests[0].method, 'POST');
  assert.equal(selectedTestRequests[0].model, 'manual-model');
  assert.equal(selectedTestRequests[0].path, '/missing/v1/chat/completions', 'a service without a catalog can still serve its selected model');
  await selectModels([]);
  for (const endpoint of ['missing', 'method']) {
    catalogFailure = endpoint;
    const beforeUnsupportedTest = requests.length;
    await clickAndWait('btn-model-test');
    assert.ok(requests.length > beforeUnsupportedTest);
    assert.ok(requests.slice(beforeUnsupportedTest).every((request) => request.method === 'GET'), 'unsupported catalogs must not fall back to chat');
    const message = await evaluate(`document.getElementById('tip').textContent`);
    assert.ok(message.includes('手动添加'), 'unsupported catalogs must explain manual model setup');
    assert.ok(!message.includes('连接失败'), 'a missing models API must not report that the whole connection failed');
  }
  catalogFailure = 'missing';
  await selectModels(['manual-model']);
  await saveSettings();
  assert.deepEqual((await storedConfig()).models, ['manual-model']);

  // Explicitly unchecking every model retains the connection and disables generation.
  await openSettings();
  await selectModels([]);
  const beforeEmptySave = requests.length;
  await saveSettings(true);
  saved = await storedConfig();
  assert.deepEqual(saved.models, []);
  assert.equal(saved.model, '');
  assert.equal(saved.baseUrl, `${mockOrigin}/missing/v1`);
  assert.equal(requests.length, beforeEmptySave, 'explicitly disabling all models must not auto-enable them again');
  assert.equal(await evaluate(`document.getElementById('btn-generate-summary').disabled`), true);

  // A fresh connection can also be saved if its service cannot enumerate models.
  await openSettings();
  await evaluate(`document.getElementById('btn-model-clear').click()`);
  await configureConnection(`${mockOrigin}/missing/v1`);
  await saveSettings(true);
  saved = await storedConfig();
  assert.deepEqual(saved.models, []);
  assert.equal(saved.baseUrl, `${mockOrigin}/missing/v1`);
  assert.equal(await evaluate(`Boolean(sessionStorage.getItem(${JSON.stringify(SESSION_KEY)}))`), true);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(PERSISTENT_KEY)})`), null, 'key persistence must remain opt-in');
  await reload();
  assert.deepEqual((await storedConfig()).models, [], 'a connection with no enabled models must survive reload');
  assert.equal(await evaluate(`document.getElementById('btn-generate-summary').disabled`), true);

  // A service exposing exactly one model can finish setup without an extra choice.
  await openSettings();
  await evaluate(`document.getElementById('btn-model-clear').click()`);
  await configureConnection(`${mockOrigin}/single/v1`);
  await saveSettings();
  saved = await storedConfig();
  assert.deepEqual(saved.models, ['only-model'], 'a catalog with exactly one model should enable it automatically');
  assert.equal(saved.model, 'only-model');
  assert.equal(await evaluate(`document.getElementById('btn-generate-summary').disabled`), false);
  assert.ok(requests.every((request) => request.authorized), 'mock requests must include the configured key');
  assert.deepEqual(errors, [], 'renderer must not log errors during the settings flow');

  await fs.writeFile(path.join(outputDirectory, 'model-settings-results.json'), JSON.stringify({
    passed: true, catalogRequests: requests.filter((request) => request.method === 'GET').length,
    followedConnectionReads: importCalls,
    generationModels: requests.filter((request) => request.method === 'POST').map((request) => request.model), screenshots
  }, null, 2));
  window.destroy();
  disposeDesktopAiRequests();
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(`Model settings passed: URL/key discovery, multiple models, active CC Switch following, Anthropic/Responses, migration, failure recovery and ${screenshots.length} layout captures\n`);
  app.quit();
}

const deadline = setTimeout(() => { console.error('model settings smoke exceeded 90 seconds'); app.exit(1); }, 90000);
main().then(() => clearTimeout(deadline)).catch((error) => {
  console.error(error);
  disposeDesktopAiRequests();
  if (window && !window.isDestroyed()) window.destroy();
  if (server) server.close();
  clearTimeout(deadline);
  app.exit(1);
});
