'use strict';
// Real shipping reader/PDF.js/engine, generated vector and scanned pages.
// Model responses exercise evidence plumbing; they do not assert AI semantics.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'paper-vision-browser');
const reply = 'VISION_FIXTURE_REPLY: the chart, vector table and scanned page are available as original page-image evidence.';
const requests = [], pixels = [], errors = [], external = [], delayed = [];
let browser, page, server, phase = 'startup', mode = 'normal', docId;
const stage = label => { phase = label; console.log(`[Paper vision browser] ${label}`); };
const panel = () => page.locator('.guanyi-study-panel');
const button = name => panel().getByRole('button', { name, exact: true });
const tab = name => panel().getByRole('tab', { name, exact: true }).click();
const record = () => page.evaluate(id => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).readerStudy, docId);
const messageText = content => Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).find(text => text.trim().startsWith('{')) : content;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

function allowedIds(payload) {
  if (payload.evidence || payload.visuals) return [...(payload.evidence || []), ...(payload.visuals || [])].map(item => item.id);
  return (payload.sourceIdRanges || []).flatMap(range => Array.from({ length: Number(range.last.slice(1)) - Number(range.first.slice(1)) + 1 }, (_, index) => range.first[0] + (Number(range.first.slice(1)) + index)));
}
function modelResponse(payload) {
  const ids = allowedIds(payload), visuals = ids.filter(id => id.startsWith('V'));
  const selected = ['V2', 'V3', 'V4'].filter(id => visuals.includes(id));
  const evidenceIds = selected.length ? selected : visuals.length ? [visuals[0]] : [ids[0]];
  if (/answer/.test(payload.stage)) return { answer: reply, evidenceIds, insufficient: false };
  return { reading: { title: 'Original visual evidence', documentType: 'Visual research fixture', summary: { body: reply, evidenceIds },
    sections: [{ kind: 'results', title: 'Read the actual chart and table', body: reply, basis: 'source', evidenceIds }],
    wrapUp: { body: 'The chart, vector table and scan support the reported measurements on their original pages.', basis: 'source', evidenceIds },
    terms: [], quotes: [], related: [] },
    questions: [{ question: 'What do the original chart and table show?', evidenceIds }], cards: [] };
}

async function documentFixture() {
  const scans = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 1250;
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111'; context.font = 'bold 42px Arial'; context.fillText('SCANNED VISUAL ONLY', 80, 110);
    context.font = '34px Arial'; context.fillText('No native text layer', 80, 180); context.fillText('Result B = 73', 80, 250);
    context.fillStyle = '#cc3220'; context.fillRect(80, 350, 620, 130);
    context.fillStyle = '#2066cc'; context.fillRect(80, 560, 300, 130);
    const scan = canvas.toDataURL('image/jpeg', 0.95);
    canvas.width = 1000; canvas.height = 200; context.fillStyle = 'white'; context.fillRect(0, 0, 1000, 200);
    context.fillStyle = '#111'; context.font = 'bold 42px Arial'; context.fillText('CHART: A 24 / B 73', 50, 90);
    return { scan, chartLabel: canvas.toDataURL('image/jpeg', 0.95) };
  });
  const pdf = new jsPDF(); pdf.setFontSize(14);
  pdf.text('Visual evidence fixture: read the original pages.', 20, 35);
  pdf.text('Text alone does not encode the chart bars or table layout.', 20, 55);
  pdf.addPage();
  pdf.addImage(scans.chartLabel, 'JPEG', 20, 25, 170, 34);
  pdf.setDrawColor(0); pdf.setLineWidth(0.7); pdf.line(30, 230, 180, 230); pdf.line(30, 75, 30, 230);
  pdf.setFillColor(204, 50, 32); pdf.rect(55, 170, 40, 60, 'F');
  pdf.setFillColor(32, 102, 204); pdf.rect(120, 90, 40, 140, 'F');
  pdf.addPage();
  pdf.setFillColor(210, 230, 250); pdf.rect(25, 45, 160, 28, 'F');
  pdf.setDrawColor(25); pdf.setLineWidth(0.6);
  for (const x of [25, 85, 135, 185]) pdf.line(x, 45, x, 190);
  for (const y of [45, 73, 112, 151, 190]) pdf.line(25, y, 185, y);
  pdf.text('Group', 32, 63); pdf.text('Before', 91, 63); pdf.text('After', 141, 63);
  pdf.text('A', 38, 98); pdf.text('24', 100, 98); pdf.text('31', 150, 98);
  pdf.text('B', 38, 137); pdf.text('38', 100, 137); pdf.text('73', 150, 137);
  pdf.text('Total', 32, 176); pdf.text('62', 100, 176); pdf.text('104', 148, 176);
  pdf.addPage(); pdf.addImage(scans.scan, 'JPEG', 10, 15, 190, 238);
  for (let p = 5; p <= 7; p += 1) { pdf.addPage(); pdf.text(`Native evidence continues on page ${p}.`, 20, 35); pdf.setFillColor(20 * p, 30, 200); pdf.circle(100, 135, p * 5, 'F'); }
  const file = path.join(output, 'Original-chart-table-scanned-7pages.pdf'); await fs.writeFile(file, Buffer.from(pdf.output('arraybuffer'))); return file;
}

async function decodeImage(dataUrl) {
  return page.evaluate(async dataUrl => {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, blue = 0, dark = 0;
    for (let i = 0; i < data.length; i += 32) { const r = data[i], g = data[i + 1], b = data[i + 2]; if (r > 130 && r > g * 1.5 && r > b * 1.5) red += 1; if (b > 130 && b > r * 1.5 && b > g * 1.3) blue += 1; if (r < 95 && g < 95 && b < 95) dark += 1; }
    return { width: image.naturalWidth, height: image.naturalHeight, red, blue, dark };
  }, dataUrl);
}

async function startServer() {
  server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    try { const bytes = await fs.readFile(file); response.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream'); response.end(bytes); } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`;
}
async function importPdf(file) {
  await page.locator('#file-open').setInputFiles(file);
  await page.waitForFunction(name => __MD_EDITOR_TEST__.getState().docs.some(doc => doc.localFileName === name), path.basename(file));
  docId = await page.evaluate(name => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.localFileName === name).id, path.basename(file));
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().currentDocId === id && document.querySelector('.guanyi-pdf-frame')?.contentWindow?.PDFViewerApplication?.pdfDocument, docId);
  await page.waitForFunction(async () => !!(await GuanyiReaderHost.getStudyReader())?.renderVisual);
}
async function waitPreparation(status) { await page.waitForFunction(({ id, status }) => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).readerStudy?.preparations.at(-1)?.status === status, { id: docId, status }, { timeout: 60000 }); }
async function expectNoPixelsInStorage() {
  assert.doesNotMatch(JSON.stringify(await record()), /data:image|;base64,/);
  assert.equal(await page.evaluate(() => [localStorage, sessionStorage].some(storage => Object.keys(storage).some(key => /data:image|;base64,/.test(storage.getItem(key) || '')))), false);
}
function assertAllImages(batch, count, label) {
  assert.deepEqual(batch.flatMap(item => item.visuals || []).map(item => item.page), Array.from({ length: count }, (_, index) => index + 1), `${label}: every page is sent once in order`);
  assert.ok(batch.every(item => item.imageCount === (item.visuals || []).length && item.imageCount <= 3), `${label}: matching real image attachments, maximum 3 per call`);
}
async function openVisualPreview() {
  const sources = panel().locator('.guanyi-study-overview .guanyi-study-source-preview');
  if (!await sources.evaluate(node => node.open)) await sources.locator(':scope > summary').click();
  const preview = sources.locator('.guanyi-study-visual-preview').first(); await preview.locator('summary').click();
  await preview.locator('img').waitFor(); await preview.locator('img').evaluate(async image => image.decode()); return preview;
}

const watchdog = setTimeout(() => { console.error(`Paper vision browser exceeded 240 seconds during ${phase}`); browser?.close(); }, 240000);
(async () => {
  await fs.mkdir(output, { recursive: true }); const origin = await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const file = await documentFixture();
  await page.addInitScript(() => { localStorage.setItem('md-editor-model-config-v1', JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://vision.fixture.invalid/v1', model: 'vision-fixture' })); sessionStorage.setItem('md-editor-model-session-key-v1', 'generated-vision-fixture-key'); window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://vision.fixture.invalid/')) {
      const wire = route.request().postDataJSON(), content = (wire.messages || wire.input).at(-1).content, payload = JSON.parse(messageText(content));
      const images = Array.isArray(content) ? content.filter(part => part.type === 'image_url') : [];
      assert.equal(images.length, (payload.visuals || []).length); const imageInfo = [];
      for (let index = 0; index < images.length; index += 1) {
        const dataUrl = images[index].image_url.url, bytes = Buffer.from(dataUrl.split(',')[1], 'base64'), visual = payload.visuals[index];
        assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff'); assert.ok(bytes.length > 1000);
        const metric = { page: visual.page, ...await decodeImage(dataUrl), bytes: bytes.length, sha256: digest(bytes) };
        assert.equal(metric.width, visual.width); assert.equal(metric.height, visual.height); assert.ok(Math.max(metric.width, metric.height) <= 2000);
        pixels.push(metric); imageInfo.push(metric);
        if (requests.length < 3) await fs.writeFile(path.join(output, `model-page-${visual.page}.jpg`), bytes);
      }
      const entry = { ...payload, imageCount: images.length, images: imageInfo }; requests.push(entry);
      if (mode === 'wait') { delayed.push(route); return; }
      if (mode === 'unsupported') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'This model does not support image_url or vision input.' } }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelResponse(payload)) } }] }) });
    }
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue(); external.push(url); return route.abort();
  });
  await page.goto(origin); await page.waitForFunction(() => window.__MD_EDITOR_TEST__); await importPdf(file);

  stage('rendering original pages without changing the live PDF viewer');
  const bridge = await page.evaluate(async () => {
    const reader = await GuanyiReaderHost.getStudyReader(), app = document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication;
    const before = { position: reader.position(), hash: app.pdfDocument.annotationStorage.serializable.hash };
    const visual = await reader.renderVisual(2); const after = { position: reader.position(), hash: app.pdfDocument.annotationStorage.serializable.hash };
    const scan = await reader.page(4); const chart = await reader.page(2);
    return { before, after, dataUrl: visual.dataUrl, width: visual.width, height: visual.height, scanned: scan.scanned, scannedBlocks: scan.blocks.length, chartText: chart.blocks.map(block => block.text).join(' ') };
  });
  assert.deepEqual(bridge.before, bridge.after); assert.equal(bridge.scanned, true); assert.equal(bridge.scannedBlocks, 0); assert.doesNotMatch(bridge.chartText, /CHART|24|73/);
  const chartPixels = await decodeImage(bridge.dataUrl); assert.ok(chartPixels.red > 1000 && chartPixels.blue > 1000 && chartPixels.dark > 100, 'actual chart bars, axes and raster labels are decoded');
  const bridgeDigest = digest(Buffer.from(bridge.dataUrl.split(',')[1], 'base64'));

  stage('sending every original image including vector tables and scanned pages');
  await page.locator('.guanyi-study-toggle').click(); await button('研读全文').click(); await waitPreparation('ready');
  const prepared = (await record()).preparations.at(-1), first = requests.filter(item => /^(read-batch|prepare-document)$/.test(item.stage));
  assertAllImages(first, 7, 'preparation'); assert.equal(prepared.coverage.sentImages, 7); assert.equal(prepared.coverage.totalImages, 7); assert.ok(prepared.coverage.scannedPages.includes(4));
  assert.equal(first.flatMap(item => item.images).find(item => item.page === 2).sha256, bridgeDigest, 'model receives the genuine detached page render');
  for (const p of [2, 3, 4]) assert.ok(first.flatMap(item => item.images).find(item => item.page === p).dark > 100, `page ${p} has actual readable pixels`);
  assert.ok(prepared.reading.summary.sources.every(source => source.kind === 'page-image' && !source.precise)); await expectNoPixelsInStorage();
  assert.equal(await panel().locator('.guanyi-study-visual-preview img').count(), 0, 'stored citation does not eagerly render or persist an image');

  stage('previewing cited original pixels locally and navigating back');
  const beforePreview = requests.length, preview = await openVisualPreview();
  assert.equal(requests.length, beforePreview, 'preview is local and never calls the model');
  const image = preview.locator('img'); assert.equal(await image.evaluate(node => Math.max(node.naturalWidth, node.naturalHeight) <= 2000), true);
  await page.screenshot({ path: path.join(output, '01-visual-source-preview.png') });
  await preview.locator('summary').click(); await page.waitForFunction(() => !document.querySelector('.guanyi-study-visual-preview img'));
  await openVisualPreview();
  await panel().locator('.guanyi-study-overview').getByRole('button', { name: '定位图表所在页', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2);
  await page.locator('.guanyi-study-return').click(); await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1);

  stage('answering with all page images and local visual source identities');
  const answerStart = requests.length; await tab('文档对话'); await panel().getByRole('textbox', { name: '研读问题', exact: true }).fill('Compare the chart, table and scanned result.'); await button('发送').click();
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).readerStudy.messages.at(-1)?.status === 'ready', docId, { timeout: 60000 });
  assertAllImages(requests.slice(answerStart).filter(item => /^answer-(batch|document)$/.test(item.stage)), 7, 'answer');
  const message = (await record()).messages.at(-1); assert.equal(message.answer, reply); assert.equal(message.context.mode, 'document'); assert.equal(message.coverage.sentImages, 7); assert.ok(message.sources.some(source => source.page === 4 && source.kind === 'page-image'));

  stage('cancelling a genuine detached PDF.js render');
  const cancelled = await page.evaluate(async () => {
    const reader = await GuanyiReaderHost.getStudyReader(), app = document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication, pdfPage = await app.pdfDocument.getPage(2);
    const original = pdfPage.render, controller = new AbortController(); let started = false;
    pdfPage.render = function (...args) { const result = original.apply(this, args); started = true; queueMicrotask(() => controller.abort()); return result; };
    try { await reader.renderVisual(2, { signal: controller.signal }); return { started, rejected: false }; } catch (error) { return { started, rejected: error.name === 'AbortError' }; } finally { pdfPage.render = original; }
  });
  assert.deepEqual(cancelled, { started: true, rejected: true });

  stage('stopping during UI image preparation and model requests');
  await tab('导读');
  await page.evaluate(async () => {
    const reader = await GuanyiReaderHost.getStudyReader(); window.__visionOriginalRender = reader.renderVisual; window.__visionRenderEntered = false; window.__visionRenderAborted = false;
    reader.renderVisual = async (_visual, { signal }) => { window.__visionRenderEntered = true; return new Promise((resolve, reject) => signal.addEventListener('abort', () => { window.__visionRenderAborted = true; reject(new DOMException('stopped', 'AbortError')); }, { once: true })); };
  });
  const beforeRenderCancel = requests.length; await button('重新研读').click(); await page.waitForFunction(() => window.__visionRenderEntered); await button('停止').click(); await waitPreparation('interrupted');
  assert.equal(await page.evaluate(() => window.__visionRenderAborted), true); assert.equal(requests.length, beforeRenderCancel);
  await page.evaluate(async () => { (await GuanyiReaderHost.getStudyReader()).renderVisual = window.__visionOriginalRender; });
  mode = 'wait'; const beforeRequestCancel = requests.length; await button('重新研读').click();
  while (requests.length === beforeRequestCancel) await page.waitForTimeout(20); await button('停止').click(); await waitPreparation('interrupted');
  mode = 'normal'; for (const route of delayed.splice(0)) await route.abort().catch(() => {});
  assert.equal((await record()).preparations.filter(item => item.status === 'ready').length, 1);

  stage('retaining previous results when the model rejects image input');
  mode = 'unsupported'; const beforeUnsupported = requests.length; await button('重新研读').click(); await waitPreparation('error'); mode = 'normal';
  assert.equal(requests.length, beforeUnsupported + 1, 'unsupported image input has no silent text-only fallback');
  assert.ok(requests.at(-1).imageCount > 0); assert.equal((await record()).preparations.filter(item => item.status === 'ready').length, 1);
  assert.match(await panel().textContent(), /图像|图片|视觉/); await expectNoPixelsInStorage();

  stage('reading visual sources in narrow light and dark layouts');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await tab('导读');
    await openVisualPreview();
    const bounded = await panel().locator('.guanyi-study-visual-content img').first().evaluate(image => { const r = image.getBoundingClientRect(), outer = image.closest('.guanyi-study-panel').getBoundingClientRect(); return r.width > 0 && r.left >= outer.left && r.right <= outer.right + 1 && image.scrollWidth <= image.clientWidth + 1; });
    assert.equal(bounded, true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `visual-${theme}-${width}.png`) });
  }

  stage('exporting and restoring visual citations without serializing pixel data');
  await page.setViewportSize({ width: 1440, height: 960 }); await button('整理为 Markdown').click(); await page.locator('.guanyi-study-dialog').getByRole('button', { name: '创建 Markdown 笔记', exact: true }).click();
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().currentDocId !== id, docId);
  const markdown = await page.evaluate(() => __MD_EDITOR_TEST__.getCurrentMarkdown()); assert.match(markdown, /图像|图表/); assert.match(markdown, /文件第 4 页/); assert.doesNotMatch(markdown, /data:image|;base64,/);
  await page.reload(); await page.waitForFunction(() => window.__MD_EDITOR_TEST__); await page.locator(`.app-document-tab[data-doc-id="${docId}"] .app-document-tab__activate`).click(); await page.waitForFunction(async () => !!(await GuanyiReaderHost.getStudyReader())?.renderVisual);
  const reloaded = await record(); assert.ok(reloaded.preparations.find(item => item.status === 'ready').reading.summary.sources.some(source => source.kind === 'page-image' && source.page === 4)); assert.equal(reloaded.messages.at(-1).answer, reply); await expectNoPixelsInStorage();

  let bakker = null;
  if (process.argv.includes('--bakker')) {
    stage('sending all 30 actual Bakker pages through the same browser pipeline');
    const corpus = JSON.parse(await fs.readFile(path.join(root, '.tmp-test/paper-reader-integration-20261115/bakker-fulltext.json'), 'utf8'));
    await importPdf(corpus.sourceFile); await page.locator('.guanyi-study-toggle').click(); const start = requests.length;
    await button('研读全文').click(); await waitPreparation('ready'); const complete = (await record()).preparations.at(-1), batches = requests.slice(start).filter(item => /^(read-batch|prepare-document)$/.test(item.stage));
    assertAllImages(batches, 30, 'Bakker'); assert.equal(batches.flatMap(item => item.evidence || []).map(item => item.text).join(''), corpus.blocks.map(item => item.text).join(''));
    assert.equal(complete.coverage.sentImages, 30); await expectNoPixelsInStorage(); bakker = { pages: 30, nativeBlocks: corpus.blocks.length, characters: corpus.coverage.characters, sentImages: complete.coverage.sentImages, batches: batches.length, semanticModelFixture: true };
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, pages: 7, actualPixelsDecoded: true, detachedRenderDoesNotMutateViewer: true, nativeChartCaptionAbsent: true, scannedPage: 4,
    completePageImages: true, maximumImagesPerCall: 3, imageSources: true, lazyLocalPreview: true, sourceNavigationAndReturn: true, completeAnswerImages: true, cancelPdfRender: true, cancelUiRender: true,
    cancelRequest: true, noTextFallbackOnUnsupportedVision: true, previousResultRetained: true, noPixelsPersistedOrExported: true, reload: true, themes: ['light/1440', 'light/390', 'dark/1440', 'dark/390'],
    bakker, requests: requests.map(({ evidence, notes, ...item }) => ({ ...item, nativeBlocks: evidence?.length || 0 })), errors, external }, null, 2));
  await fs.rm(path.join(output, 'failure.png'), { force: true }); console.log('PASS actual chart/table/scanned pixels, complete image batches, lazy sources, cancellation, unsupported-model boundary, persistence/export and layouts');
})().catch(async error => {
  console.error(`Paper vision browser failed during ${phase}:`, error); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'failure.txt'), error.stack || String(error));
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'state.json'), JSON.stringify(await record().catch(() => null) ?? null, null, 2)); }
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
