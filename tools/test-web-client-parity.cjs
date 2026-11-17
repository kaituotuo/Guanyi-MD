'use strict';
// Runs the shipping HTTP client against generated books and an isolated CC
// Switch database. Browser profiles, documents and credentials are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const JSZip = require('jszip');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'web-client-parity');
const fixtureHome = path.join(output, `cc-switch-home-${process.pid}`);
const readersOnly = process.argv.includes('--readers-only');
const keyA = 'web-parity-generated-key-a';
const keyB = 'web-parity-generated-key-b';
const keyC = 'web-parity-generated-key-claude';
const epubQuote = '阅读需要保留原文证据，并记录自己的思考。';
const errors = [], externalRequests = [], modelRequests = [], browserCredentials = [], screenshots = [];
let browser, page, appProcess, modelServer, origin, modelOrigin, phase = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stage = label => { phase = label; process.stdout.write(`[Web client parity] ${label}\n`); };

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function publication() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">web-parity-book</dc:identifier><dc:title>Web EPUB 验收</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-15T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章 阅读</a></li><li><a href="chapter2.xhtml">第二章 思考</a></li></ol></nav></body></html>');
  zip.file('OPS/chapter1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 阅读</title><script>parent.__webParityBookScript=true;</script></head><body><h1>第一章 阅读</h1><p id="web-epub-quote">${epubQuote}</p>${'<p>把值得回味的段落留下，继续阅读并保留来源。</p>'.repeat(7)}</body></html>`);
  zip.file('OPS/chapter2.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章 思考</title></head><body><h1 id="web-epub-second">第二章 思考</h1><p>第二章的阅读位置应在重新打开后保留。</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function startFixtures() {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(fixtureHome, '.cc-switch'), { recursive: true });
  const pdf = new jsPDF();
  pdf.text('WEB PDF evidence stays available in the browser.', 20, 30);
  pdf.text('A conclusion requires evidence and stated conditions.', 20, 50);
  pdf.addPage(); pdf.text('Second PDF page and saved position.', 20, 30);
  const files = {
    markdown: path.join(output, 'Web 编辑验收.md'),
    pdf: path.join(output, 'Web PDF 验收.pdf'),
    epub: path.join(output, 'Web EPUB 验收.epub')
  };
  await Promise.all([
    fs.writeFile(files.markdown, '# Web Evidence\n\nEvidence keeps its original source.\n\n- [ ] An editable task.'),
    fs.writeFile(files.pdf, Buffer.from(pdf.output('arraybuffer'))),
    fs.writeFile(files.epub, await publication())
  ]);
  modelServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const second = request.url.startsWith('/other/');
    const claude = request.url.startsWith('/claude/');
    const authenticated = claude ? request.headers['x-api-key'] === keyC && !request.headers.authorization : request.headers.authorization === `Bearer ${second ? keyB : keyA}`;
    const freeChat = JSON.stringify(body.input || body.messages || []).includes('当前是自由对话');
    modelRequests.push({ path: request.url, method: request.method, model: body.model || '', authenticated, freeChat });
    response.setHeader('content-type', 'application/json');
    if (!authenticated) return response.writeHead(401).end(JSON.stringify({ error: { message: 'Fixture authentication failed' } }));
    if (request.method === 'GET' && request.url.endsWith('/models')) {
      return response.end(JSON.stringify({ data: [{ id: second ? 'web-current-b' : 'web-current-a' }] }));
    }
    const content = freeChat ? 'WEB_HOME_MANAGED_REPLY'
      : JSON.stringify({ summary: [{ title: 'Web 阅读概览', text: '此结果来自本机模拟服务。' }], details: [], risks: [] });
    response.end(JSON.stringify(claude ? { content: [{ type: 'text', text: content }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  modelOrigin = `http://127.0.0.1:${modelServer.address().port}`;
  const database = new DatabaseSync(path.join(fixtureHome, '.cc-switch', 'cc-switch.db'));
  database.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER)');
  const insert = database.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?)');
  for (const [id, model, baseUrl, key] of [['a', 'web-current-a', `${modelOrigin}/v1`, keyA], ['b', 'web-current-b', `${modelOrigin}/other/v1`, keyB]]) {
    insert.run(id, 'codex', `Web fixture ${id.toUpperCase()}`, JSON.stringify({ auth: { OPENAI_API_KEY: key },
      config: `model_provider = "webfixture"\nmodel = "${model}"\n[model_providers.webfixture]\nbase_url = "${baseUrl}"\nwire_api = "responses"` }), id === 'a' ? 1 : 0);
  }
  insert.run('c', 'claude', 'Web Claude fixture', JSON.stringify({ env: { ANTHROPIC_API_KEY: keyC, ANTHROPIC_BASE_URL: `${modelOrigin}/claude`, ANTHROPIC_MODEL: 'web-claude-current' } }), 1);
  database.close();
  await selectCurrentProvider('a');
  return files;
}

async function selectCurrentProvider(id) {
  await fs.writeFile(path.join(fixtureHome, '.cc-switch', 'settings.json'), JSON.stringify({ currentProviderCodex: id, currentProviderClaude: 'c' }));
}

async function launchApp() {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  appProcess = spawn(process.execPath, ['tools/dev-server.mjs', '--port', String(port)], {
    cwd: root, env: { ...process.env, NODE_ENV: 'test', GUANYI_TEST_CC_SWITCH_HOME: fixtureHome }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  appProcess.stdout.on('data', chunk => { logs += chunk; });
  appProcess.stderr.on('data', chunk => { logs += chunk; });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (appProcess.exitCode !== null) throw new Error(`Web server exited: ${logs}`);
    if (await fetch(origin).then(response => response.ok).catch(() => false)) return;
    await pause(60);
  }
  throw new Error(`Web server did not start: ${logs}`);
}

async function ready() { await page.waitForFunction(() => window.__MD_EDITOR_TEST__ && !window.__MD_EDITOR_BOOT_ERROR__); }
async function screenshot(name) { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file); }
async function switchTo(id) {
  await page.locator(`.app-document-tab[data-doc-id="${id}"] .app-document-tab__activate`).click();
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().currentDocId === id && __MD_EDITOR_TEST__.getState().workspaceView === 'document', id);
}
async function imported(file) {
  await page.locator('#file-open').setInputFiles(file);
  await page.waitForFunction(name => __MD_EDITOR_TEST__.getState().docs.some(doc => doc.localFileName === name), path.basename(file));
  const id = await page.evaluate(name => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.localFileName === name).id, path.basename(file));
  // A binary document enters the library before async reader flush/navigation
  // finishes. Wait for the visible open operation before importing the next.
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().currentDocId === id
    && __MD_EDITOR_TEST__.getState().openDocIds.includes(id), id);
  await page.locator(`.app-document-tab[data-doc-id="${id}"] .app-document-tab__activate`).waitFor();
  if (/\.pdf$/i.test(file)) await pdfReady();
  if (/\.epub$/i.test(file)) await epubReady();
  return id;
}
async function downloadFrom(locator, filename) {
  const next = page.waitForEvent('download'); await locator.click();
  const download = await next; const file = path.join(output, filename); await download.saveAs(file); return file;
}
async function pdfReady() {
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame')?.contentWindow?.PDFViewerApplication?.pdfDocument
    && document.querySelector('.guanyi-pdf-frame').contentDocument.querySelector('.textLayer span'));
}
async function epubReady(target = 'web-epub-quote') {
  await page.waitForFunction(target => document.querySelector('.epub-reader iframe')?.contentDocument?.getElementById(target), target);
}

async function markdownScenario(id) {
  stage('keeping the full Markdown editor, toolbar, views, themes and browser save');
  await switchTo(id);
  assert.equal(await page.locator('#fmtbar').isVisible(), true);
  assert.equal(await page.locator('#source-editor').evaluate(input => input.readOnly), false);
  for (const selector of ['[data-fmt="bold"]', '[data-fmt="italic"]', '[data-fmt="task"]', '#btn-table', '#btn-image', '#btn-find-replace', '#btn-comments', '#btn-save', '#btn-export']) {
    assert.equal(await page.locator('#fmtbar').locator(selector).isVisible(), true, `old toolbar: ${selector}`);
  }
  const original = await page.locator('#source-editor').inputValue();
  for (const mode of ['source', 'preview', 'split']) {
    await page.locator(`#view-seg [data-view="${mode}"]`).click();
    assert.equal(await page.locator('#editor-container').getAttribute('data-view'), mode);
  }
  await page.locator('#view-seg [data-view="source"]').click();
  await page.locator('#source-editor').evaluate(input => { const start = input.value.indexOf('Evidence'); input.focus(); input.setSelectionRange(start, start + 8); });
  await page.locator('[data-fmt="bold"]').click();
  assert.match(await page.locator('#source-editor').inputValue(), /\*\*Evidence\*\*/);
  await page.locator('#btn-undo').click(); assert.equal(await page.locator('#source-editor').inputValue(), original);
  await page.locator('#source-editor').fill(`${original}\n\nA browser edit survives reload.`);
  const saved = await downloadFrom(page.locator('#btn-save'), 'saved-markdown.md');
  assert.match(await fs.readFile(saved, 'utf8'), /A browser edit survives reload/);
  await page.locator('#view-seg [data-view="split"]').click();
  const previousTheme = await page.locator('html').getAttribute('data-theme');
  await page.locator('#btn-theme').click();
  assert.notEqual(await page.locator('html').getAttribute('data-theme'), previousTheme);
  await screenshot('01-markdown-editor');
  await page.locator('#document-return-reading').click();
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(), true);
  assert.equal(await page.locator('#fmtbar').isVisible(), false);
  await page.locator('#document-edit-toggle').click(); assert.equal(await page.locator('#fmtbar').isVisible(), true);
}

async function pdfScenario(id) {
  stage('rendering an imported PDF, adding a native note and saving real PDF bytes');
  await switchTo(id); await pdfReady();
  assert.match(await page.locator('.guanyi-pdf-page-count').textContent(), /2/);
  assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-label'), '智能研读');
  const pdfFrame = page.frameLocator('.guanyi-pdf-frame');
  await page.getByRole('button', { name: '文字笔记', exact: true }).click();
  await pdfFrame.locator('.annotationEditorLayer').first().click({ position: { x: 120, y: 180 } });
  await pdfFrame.locator('.freeTextEditor [contenteditable="true"]').fill('WEB_NATIVE_NOTE');
  const exported = await downloadFrom(page.locator('.app-reader-save'), 'annotated-browser.pdf');
  const bytes = await fs.readFile(exported); assert.match(bytes.subarray(0, 8).toString(), /^%PDF/);
  await page.locator('.guanyi-study-toggle').click();
  await page.getByRole('tab', { name: '批注', exact: true }).click();
  await page.locator('[data-note-kind="native"]').filter({ hasText: 'WEB_NATIVE_NOTE' }).waitFor();
  const study = page.locator('.guanyi-study-panel');
  await study.getByRole('button', { name: '新建笔记', exact: true }).click();
  await study.getByRole('textbox', { name: '研读笔记', exact: true }).fill('WEB_STUDY_NOTE');
  await study.getByRole('button', { name: '保存研读笔记', exact: true }).click();
  await study.locator('[data-note-kind="study"]').filter({ hasText: 'WEB_STUDY_NOTE' }).waitFor();
  await screenshot('02-pdf-native-and-study-notes');
  await page.locator('.guanyi-study-close').click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-page-number').value === '2');
}

async function epubScenario(id) {
  stage('rendering an imported EPUB, highlighting text and persisting a CFI note');
  await switchTo(id); await epubReady();
  assert.equal(await page.locator('.epub-reader iframe').evaluate(frame => frame.sandbox.contains('allow-scripts')), false);
  assert.equal(await page.evaluate(() => Boolean(window.__webParityBookScript)), false);
  await page.evaluate(() => {
    const doc = document.querySelector('.epub-reader iframe').contentDocument;
    const text = doc.getElementById('web-epub-quote').firstChild;
    const range = doc.createRange(); range.setStart(text, 0); range.setEnd(text, text.length);
    const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => !document.querySelector('[data-epub-action="highlight"]').disabled);
  await page.locator('[data-epub-action="note"]').click();
  await page.locator('#epub-review-comments .epub-reader__note textarea').fill('WEB_EPUB_NOTE');
  await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').selectOption('green');
  await page.waitForFunction(id => JSON.parse(__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).content).annotations?.[0]?.note === 'WEB_EPUB_NOTE', id);
  const exported = await downloadFrom(page.locator('.app-reader-save'), 'epub-browser-notes.md');
  const text = await fs.readFile(exported, 'utf8'); assert.ok(text.includes(epubQuote)); assert.match(text, /WEB_EPUB_NOTE/); assert.match(text, /epubcfi\(/);
  await screenshot('03-epub-highlight-note');
  await page.locator('#btn-close-drawer').click();
  // Navigate immediately: resize during drawer close must preserve this target.
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('web-epub-second');
  await page.waitForFunction(id => /^epubcfi\(\/6\/4/.test(JSON.parse(localStorage.getItem('md-editor-demo-state-v2')).docs.find(doc => doc.id === id)?.readerPosition?.cfi || ''), id);
}

async function persistenceScenario(ids) {
  stage('restoring browser originals, annotations, notes, reading positions and Home');
  await page.reload(); await ready();
  await switchTo(ids.epub); await epubReady('web-epub-second');
  await page.locator('[data-epub-action="review"]').click();
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note textarea').inputValue(), 'WEB_EPUB_NOTE');
  assert.equal(await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').inputValue(), 'green');
  await switchTo(ids.pdf); await pdfReady();
  assert.equal(await page.locator('.guanyi-pdf-page-number').inputValue(), '2');
  await page.locator('.guanyi-study-toggle').click(); await page.getByRole('tab', { name: '批注', exact: true }).click();
  await page.locator('[data-note-kind="native"]').filter({ hasText: 'WEB_NATIVE_NOTE' }).waitFor();
  await page.locator('[data-note-kind="study"]').filter({ hasText: 'WEB_STUDY_NOTE' }).waitFor();
  await switchTo(ids.markdown);
  assert.match(await page.locator('#source-editor').inputValue(), /A browser edit survives reload/);
  await page.locator('.app-workspace-home-tab').click();
  assert.equal(await page.locator('.app-home-view[data-home-view="home"]').isVisible(), true);
  for (const id of Object.values(ids)) assert.equal(await page.locator(`.app-home-document-open[data-home-open="${id}"]`).count(), 1);
  assert.equal(await page.locator('[data-home-action="study"]').isVisible(), true);
  await screenshot('04-web-home-and-recent-documents');
}

async function ccSwitchScenario(id) {
  stage('following real isolated Web CC Switch configuration without exposing its key');
  await switchTo(id);
  await page.locator('#btn-app-menu').click(); await page.locator('[data-app-command="model-settings"]').click();
  await page.locator('#btn-model-import-cc-switch').click();
  await page.waitForFunction(() => document.getElementById('model-follow-cc-switch')?.checked);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('md-editor-model-config-v1'))), { source: 'cc-switch', sourceApp: 'codex' });
  assert.equal(await page.locator('#model-api-key').inputValue(), '', 'managed key must stay out of the browser form');
  await screenshot('05-web-cc-switch-follow');
  await page.locator('#btn-model-close').click();
  await page.locator('#btn-comments').click(); await page.locator('[data-collab-panel="reading"]').click();
  for (const [provider, expectedModel, expectedPath] of [['a', 'web-current-a', '/v1/responses'], ['b', 'web-current-b', '/other/v1/responses']]) {
    await selectCurrentProvider(provider);
    const before = modelRequests.length;
    await page.locator('#btn-generate-summary').click();
    await page.waitForFunction(model => {
      const hooks = __MD_EDITOR_TEST__; return hooks.getReviewState().documents[hooks.getState().currentDocId]?.ai?.model === model;
    }, expectedModel);
    assert.ok(modelRequests.length > before);
    assert.equal(modelRequests.at(-1).path, expectedPath); assert.equal(modelRequests.at(-1).model, expectedModel);
    assert.equal(modelRequests.at(-1).authenticated, true);
  }
  stage('switching both active CC sources from the radio submenu, preserving each transport');
  const openModelMenu = async () => {
    if (!await page.locator('#app-menu').isVisible()) await page.locator('#btn-app-menu').click();
    await page.locator('#btn-switch-model').click();
    await page.waitForFunction(() => document.querySelectorAll('#model-switch-options [role="menuitemradio"]').length === 2 && document.getElementById('model-switch-status').hidden);
  };
  assert.equal(await page.locator('#active-model').count(), 0, 'topbar must not retain the old model dropdown');
  await openModelMenu();
  assert.equal(await page.locator('[data-model-source="codex"]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('[data-model-source="claude"]').getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#model-switch-menu').isVisible(), false);
  assert.equal(await page.locator('#btn-switch-model').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('ArrowRight');
  await page.locator('[data-model-source="claude"]').click();
  await page.waitForFunction(() => document.getElementById('btn-switch-model').title.includes('web-claude-current'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('md-editor-model-config-v1'))), { source: 'cc-switch', sourceApp: 'claude' });
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(() => { const hooks = __MD_EDITOR_TEST__; return hooks.getReviewState().documents[hooks.getState().currentDocId]?.ai?.model === 'web-claude-current'; });
  assert.equal(modelRequests.at(-1).path, '/claude/v1/messages');
  assert.equal(modelRequests.at(-1).authenticated, true, 'Claude must use its own key and Messages endpoint');
  await page.reload(); await ready();
  await page.waitForFunction(() => document.getElementById('btn-switch-model').title.includes('web-claude-current'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await openModelMenu();
  assert.equal(await page.locator('[data-model-source="claude"]').getAttribute('aria-checked'), 'true', 'source selection must survive reload');
  const menuBounds = await page.locator('#model-switch-menu').boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 391 && menuBounds.y + menuBounds.height <= 845, 'secondary menu must fit a narrow viewport');
  await screenshot('05b-web-dual-models-dark-narrow');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await switchTo(id);
  await page.locator('#btn-comments').click(); await page.locator('[data-collab-panel="reading"]').click();
  await fs.writeFile(path.join(fixtureHome, '.cc-switch', 'settings.json'), JSON.stringify({ currentProviderCodex: 'b', currentProviderClaude: 'deleted' }));
  const beforeInvalidSource = modelRequests.length;
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(() => document.querySelector('#summary-results .app-reading-error'));
  assert.equal(modelRequests.length, beforeInvalidSource, 'a missing selected Claude must not send its previous key or silently switch to Codex');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('md-editor-model-config-v1'))), { source: 'cc-switch', sourceApp: 'claude' });
  await selectCurrentProvider('b');
  await page.locator('#btn-app-menu').click(); await page.locator('#btn-switch-model').click();
  await page.waitForFunction(() => !document.querySelector('[data-model-source="codex"]')?.disabled);
  await page.locator('[data-model-source="codex"]').click();
  await page.waitForFunction(() => document.getElementById('btn-switch-model').title.includes('web-current-b'));
  stage('sending a real Home conversation through the managed CC Switch proxy');
  await page.locator('#btn-close-drawer').click();
  await page.locator('.app-workspace-home-tab').click();
  await page.locator('[data-home-prompt]').fill('Web managed Home fixture');
  const beforeHome = modelRequests.length;
  await page.locator('[data-home-action="send"]').click();
  await page.waitForFunction(() => __MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1)?.turns.at(-1)?.status === 'complete');
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1).turns.at(-1).answer), 'WEB_HOME_MANAGED_REPLY');
  assert.equal(modelRequests.length, beforeHome + 1);
  assert.equal(modelRequests.at(-1).path, '/other/v1/responses');
  assert.equal(modelRequests.at(-1).model, 'web-current-b');
  assert.equal(modelRequests.at(-1).authenticated, true);
  assert.equal(modelRequests.at(-1).freeChat, true);
  await screenshot('06-web-home-managed-conversation');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('md-editor-demo-state-v2')).homeWorkspace.conversations.at(-1)?.turns.at(-1)?.answer === 'WEB_HOME_MANAGED_REPLY');
  await page.reload(); await ready();
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1)?.turns.at(-1)?.answer), 'WEB_HOME_MANAGED_REPLY');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('md-editor-model-config-v1'))), { source: 'cc-switch', sourceApp: 'codex' });
  const leaked = await page.evaluate(keys => [localStorage, sessionStorage].some(storage => Object.keys(storage).some(key => {
    const value = storage.getItem(key) || ''; return keys.some(secret => value.includes(secret));
  })), [keyA, keyB, keyC]);
  assert.equal(leaked, false, 'managed key must not enter browser storage');
  assert.deepEqual(browserCredentials, [], 'managed keys must not appear in browser request bodies or headers');
}

async function cleanup() {
  await browser?.close().catch(() => {});
  if (appProcess && appProcess.exitCode === null) {
    const exited = new Promise(resolve => appProcess.once('exit', resolve)); appProcess.kill('SIGTERM'); await exited;
  }
  if (modelServer) await new Promise(resolve => modelServer.close(resolve));
}

const watchdog = setTimeout(() => { console.error(`Web parity timed out during ${phase}`); cleanup().finally(() => { process.exitCode = 1; }); }, 180000);
(async () => {
  const files = await startFixtures(); await launchApp();
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.addInitScript(() => { window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const text = JSON.stringify({ body: request.postData(), headers: request.headers() });
    if ([keyA, keyB, keyC].some(secret => text.includes(secret))) browserCredentials.push({ url: new URL(request.url()).pathname });
  });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    externalRequests.push(url); return route.abort();
  });
  await page.goto(origin); await ready();
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().workspaceView), 'home');
  const ids = {};
  for (const kind of ['markdown', 'pdf', 'epub']) ids[kind] = await imported(files[kind]);
  await markdownScenario(ids.markdown); await pdfScenario(ids.pdf); await epubScenario(ids.epub); await persistenceScenario(ids);
  if (!readersOnly) await ccSwitchScenario(ids.markdown);
  assert.deepEqual(errors, [], 'actual Web client must not emit uncaught browser errors');
  assert.deepEqual(externalRequests, [], 'reader fixtures must remain local');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, readersOnly, filesImportedThroughBrowserInput: 3,
    markdownEditorAndSave: true, pdfNativeAnnotationAndStudy: true, epubAnnotationAndCfi: true, epubImmediateCloseNavigation: true, reload: true, home: true,
    ccSwitchFollowing: !readersOnly, ccSwitchHomeConversation: !readersOnly, modelRequests, browserKeysExposed: browserCredentials.length,
    uncaughtBrowserErrors: errors, externalRequests, screenshots }, null, 2));
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  process.stdout.write(`Web client parity passed: real PDF/EPUB import, annotations, persistence, Markdown editing, Home${readersOnly ? '' : ' and managed CC Switch following'}\n`);
})().catch(async error => {
  console.error(`Web client parity failed during ${phase}:`, error);
  if (page && !page.isClosed()) console.error('Web client diagnostics:', JSON.stringify(await page.evaluate(() => ({
    currentDocId: __MD_EDITOR_TEST__?.getState().currentDocId,
    workspaceView: __MD_EDITOR_TEST__?.getState().workspaceView,
    chapter: document.querySelector('select[aria-label="EPUB 章节目录"]')?.value,
    frames: [...document.querySelectorAll('.epub-reader iframe')].map(frame => ({ src: frame.src, text: frame.contentDocument?.body?.innerText?.slice(0, 180) })),
    toasts: document.getElementById('toast')?.textContent
  })).catch(() => null)), 'Page errors:', JSON.stringify(errors));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await cleanup(); });
