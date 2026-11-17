'use strict';
// Exercise the shipping page in an isolated browser profile. Only generated
// documents, a dummy token and a localhost model service are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'model-connection-browser');
fs.mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const fixtureKey = 'fixture-only-connection-secret-never-real';
const historicalError = `Unexpected token '<', "<!doctype html>" is not valid JSON`;
let mode = 'success', browser, page, phase = 'startup';
const requests = [], errors = [], externalRequests = [], results = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch (_) { payload = {}; }
      // Evidence deliberately excludes token/header/body contents.
      requests.push({ path: pathname, mode, model: payload.model, maxTokens: payload.max_tokens, messages: payload.messages?.length, authenticatedWithFixture: req.headers.authorization === `Bearer ${fixtureKey}` });
      if (pathname !== '/v1/chat/completions' || mode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>Gateway login ${fixtureKey}</body></html>`);
      } else if (mode === 'missing') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `endpoint missing ${fixtureKey}` } }));
      } else if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_api_key', message: `invalid key ${fixtureKey}` } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      }
    });
    return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) res.writeHead(404).end();
    else { res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream'); res.end(bytes); }
  });
});
function stage(name) { phase = name; console.log(`[Model connection UI] ${name}`); }
function safeText(text) {
  assert.match(text, /[\u4e00-\u9fff]/, 'result gives a Chinese explanation');
  assert.doesNotMatch(text, /Unexpected token|doctype|not valid JSON|\b(?:401|404)\b|invalid_api_key|endpoint missing|fixture-only/i, 'raw diagnostic/token must not be displayed');
  assert.ok(!text.includes(fixtureKey));
}
async function openModel() {
  await page.locator('#btn-app-menu').click();
  await page.locator('#app-menu [data-app-command="model-settings"]').click();
  assert.equal(await page.locator('#model-modal').isVisible(), true);
}
async function assertSafeModal() {
  assert.equal(await page.locator('#model-api-key').getAttribute('type'), 'password');
  assert.equal(await page.locator('#model-name-help').isVisible(), true);
  assert.match(await page.locator('#model-name-help').textContent(), /准确模型标识/);
  assert.equal(await page.locator('#model-name-custom').getAttribute('aria-describedby'), 'model-name-help');
  assert.ok(!(await page.locator('#model-modal').innerText()).includes(fixtureKey), 'visible dialog does not expose the fixture key');
}
async function testState(nextMode, expected, screenshot) {
  mode = nextMode;
  const before = requests.length;
  await page.locator('#btn-model-test').click();
  await page.waitForFunction(() => !document.getElementById('btn-model-test').disabled);
  assert.equal(requests.length, before + 1, 'connection test makes one request');
  const request = requests.at(-1);
  assert.equal(request.path, '/v1/chat/completions', 'saved bare origin resolves to v1');
  assert.equal(request.model, 'Opus 5.5', 'model identifier is never guessed or rewritten');
  assert.equal(request.authenticatedWithFixture, true);
  assert.equal(request.maxTokens, 8, 'connection probe stays minimal');
  const status = page.locator('#model-connection-status');
  assert.equal(await status.isVisible(), true);
  assert.equal(await status.getAttribute('role'), 'status');
  assert.equal(await status.getAttribute('aria-live'), 'polite');
  const text = await status.textContent();
  assert.match(text, expected); safeText(text); await assertSafeModal();
  // Wait for the transient toast to expire; the in-dialog result must remain.
  await page.waitForFunction(() => document.getElementById('tip').hidden);
  assert.equal(await status.isVisible(), true);
  assert.equal(await status.textContent(), text);
  await page.screenshot({ path: path.join(output, screenshot) });
  results.push({ mode: nextMode, result: text, persistentAfterToast: true });
}
const watchdog = setTimeout(() => { console.error(`Model connection UI timed out during ${phase}`); browser?.close(); }, 150000);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    externalRequests.push(url); return route.abort();
  });
  await page.goto(origin); await page.waitForFunction(() => window.__MD_EDITOR_TEST__);
  stage('saving a bare relay origin through the actual dialog');
  assert.equal(await page.evaluate(() => localStorage.getItem('md-editor-model-config-v1')), null, 'isolated profile has no existing user configuration');
  await openModel();
  await page.locator('#model-provider').selectOption('custom');
  await page.locator('#model-base-url').fill(origin);
  await page.locator('#model-api-key').fill(fixtureKey);
  await page.locator('#remember-api-key').uncheck();
  await page.locator('#model-name-custom').fill('Opus 5.5');
  await page.locator('#btn-model-add').click();
  await assertSafeModal();
  await page.locator('#model-form button[type="submit"]').click();
  assert.equal(await page.locator('#model-modal').isVisible(), false);
  const saved = await page.evaluate(() => ({ config: JSON.parse(localStorage.getItem('md-editor-model-config-v1')), persistentKey: localStorage.getItem('md-editor-model-persistent-key-v1'), hasSessionKey: Boolean(sessionStorage.getItem('md-editor-model-session-key-v1')) }));
  assert.deepEqual(saved.config, { provider: 'custom', baseUrl: origin, model: 'Opus 5.5', models: ['Opus 5.5'], wireApi: 'chat', authType: 'api-key' });
  assert.equal(saved.persistentKey, null);
  assert.equal(saved.hasSessionKey, true);
  assert.ok(!JSON.stringify(saved.config).includes(fixtureKey));
  await openModel();
  assert.equal(await page.locator('#model-base-url').inputValue(), origin);
  assert.equal(await page.locator('#model-catalog-list input[data-model-id="Opus 5.5"]').isChecked(), true);
  assert.equal(await page.locator('#model-api-key').inputValue(), fixtureKey);
  console.log('PASS actual dialog saves and restores a bare origin, exact model ID and a masked session-only fixture key');

  stage('checking persistent Chinese results for HTML, missing endpoint, invalid key and success');
  await testState('html', /连接失败：.*返回了网页.*兼容服务地址/, '01-html-response.png');
  await testState('missing', /连接失败：.*没有找到模型接口/, '02-endpoint-missing.png');
  await testState('unauthorized', /连接失败：.*密钥未通过验证/, '03-key-invalid.png');
  await testState('success', /模型连接成功/, '04-success.png');
  console.log('PASS HTML200 / 404 / 401 / success remain in the accessible dialog after the toast disappears, without leaking provider diagnostics or a key');
  await page.locator('#btn-model-close').click();

  stage('rendering historical Home parser errors in Chinese');
  await page.evaluate(error => {
    const state = __MD_EDITOR_TEST__.getState().homeWorkspace;
    state.activeConversationId = 'historical-home';
    state.conversations.push({ id: 'historical-home', title: '历史连接错误验收', sourceIds: [], draft: '', turns: [{ id: 'historic-turn', question: '这是隔离的历史问题。', sourceIds: [], evidence: [], citations: [], status: 'error', error }] });
    return __MD_EDITOR_TEST__.showHome('chat');
  }, historicalError);
  const homeError = page.locator('.app-home-chat-messages .app-home-answer-notice');
  await homeError.first().waitFor();
  const homeText = await homeError.first().textContent(); safeText(homeText); assert.match(homeText, /返回了网页.*兼容服务地址/);
  assert.equal(await page.locator('.app-home-chat-messages').getByRole('button', { name: '重试', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat => chat.id === 'historical-home').turns[0].error), historicalError, 'rendering does not rewrite the historical record');
  await page.screenshot({ path: path.join(output, '05-home-historical-error.png') });
  console.log('PASS historical Home parser errors use Chinese semantics while preserving the stored record and retry action');

  stage('rendering historical PDF preparation and question errors in Chinese');
  const pdf = new jsPDF(); pdf.text('Generated fixture evidence for a local-only model error check.', 20, 30);
  await page.evaluate(async files => __MD_EDITOR_TEST__.importLocalFiles(files.map(file => new File([new Uint8Array(file.bytes)], file.name, { lastModified: 1700000000000 }))), [
    { name: '隔离错误验收.pdf', bytes: [...Buffer.from(pdf.output('arraybuffer'))] },
    { name: '隔离切换页.md', bytes: [...Buffer.from('# 隔离切换页\n\n本测试仅使用生成的资料。')] }
  ]);
  const pdfId = await page.evaluate(error => {
    const doc = __MD_EDITOR_TEST__.getState().docs.find(doc => doc.localFileName === '隔离错误验收.pdf');
    doc.readerStudy = { currentHash: doc.readerSourceHash, tab: 'guide', preparations: [{ key: 'historical-preparation', sourceHash: doc.readerSourceHash, start: 1, end: 1, status: 'error', error }], messages: [{ id: 'historical-question', sourceHash: doc.readerSourceHash, question: '保留这次历史问题。', status: 'error', error, sources: [], context: { mode: 'page', start: 1, end: 1, sourceHash: doc.readerSourceHash } }], cards: [], notes: [] };
    return doc.id;
  }, historicalError);
  await page.evaluate(id => __MD_EDITOR_TEST__.switchDoc(id), pdfId);
  await page.locator('.guanyi-study-toggle').waitFor(); await page.locator('.guanyi-study-toggle').click();
  const guideNotice = page.locator('.guanyi-study-notice').filter({ hasText: '本次研读失败' });
  await guideNotice.waitFor(); const guideText = await guideNotice.textContent(); safeText(guideText); assert.match(guideText, /返回了网页/);
  assert.equal(await guideNotice.getByRole('button', { name: '重试全文研读', exact: true }).count(), 1);
  await page.screenshot({ path: path.join(output, '06-pdf-historical-preparation.png') });
  await page.locator('.guanyi-study-tabs').getByRole('tab', { name: '文档对话', exact: true }).click();
  const question = page.locator('.guanyi-study-chat').filter({ hasText: '保留这次历史问题' });
  const questionText = await question.textContent(); safeText(questionText); assert.match(questionText, /返回了网页/);
  assert.equal(await question.getByRole('button', { name: '重试这次问题' }).count(), 1);
  await page.screenshot({ path: path.join(output, '07-pdf-historical-question.png') });
  assert.equal(await page.evaluate(id => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).readerStudy.messages[0].error, pdfId), historicalError);
  console.log('PASS historical PDF preparation/question parser errors use Chinese semantics and retain the original records and retry controls');

  assert.deepEqual(errors, [], 'page must have no runtime exceptions');
  assert.deepEqual(externalRequests, [], 'no external network requests or real credentials are used');
  const report = { passed: true, transport: 'actual browser fetch to localhost', isolatedProfile: true, externalRequests, runtimeErrors: errors, requests, states: results, historical: { home: homeText, pdfPreparation: guideText, pdfQuestion: questionText }, screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')) };
  const reportText = JSON.stringify(report, null, 2);
  assert.ok(!reportText.includes(fixtureKey));
  fs.writeFileSync(path.join(output, 'acceptance.json'), reportText + '\n');
  console.log(`PASS model connection browser acceptance; evidence: ${path.relative(root, output)}`);
})().catch(async error => {
  console.error(`FAIL during ${phase}: ${error.stack || error}`);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await browser?.close(); await new Promise(resolve => server.close(resolve)); });
