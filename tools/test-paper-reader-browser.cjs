'use strict';
// Shipping UI + PDF.js + paper engine against generated long documents.
// Responses are deterministic boundary fixtures; no user keys or documents.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'paper-reader-browser');
const conclusion = 'LATE_PAGE_CONCLUSION: task learning does not prove broad transfer.';
const answer = 'The conclusion on the final page limits the finding to task-specific learning; broad transfer remains unproven.';
const errors = [], requests = [], externalRequests = [], imageCounts = [];
let browser, page, server, phase = 'startup', mode = 'normal', lateId = '', delayed = [];
const stage = text => { phase = text; console.log(`[Paper reader browser] ${text}`); };
const panel = () => page.locator('.guanyi-study-panel');
const action = name => panel().getByRole('button', { name, exact: true });
const tab = name => panel().getByRole('tab', { name, exact: true }).click();
const question = () => panel().getByRole('textbox', { name: '研读问题', exact: true });
const pdfFrame = () => page.frameLocator('.guanyi-pdf-frame');
const record = () => page.evaluate(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerStudy);
const progress = predicate => page.waitForFunction(predicate, null, { timeout: 60000 });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const messageText = message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).find(text => text.trim().startsWith('{')) : message.content;

function modelResponse(payload) {
  const evidence = payload.evidence || [];
  const last = evidence.find(item => item.text?.includes(conclusion));
  if (last) lateId = last.id;
  const hasLate = !!last || (lateId && JSON.stringify(payload.notes || []).includes(lateId));
  const id = hasLate ? lateId : evidence[0]?.id || 'E1';
  const body = hasLate ? answer : 'This batch describes the evidence and its stated conditions.';
  if (/answer/.test(payload.stage || '')) return { answer: body, evidenceIds: [id], insufficient: false,
    card: { question: 'What does the final-page conclusion establish?', answer: body, type: 'Evidence boundary', evidenceIds: [id] } };
  return { reading: { title: 'Long full-document fixture', documentType: 'Research paper', summary: { body, evidenceIds: [id] },
    sections: [{ kind: 'methods', title: 'Methods', body: 'The full document describes the methods and their limits.', basis: 'source', evidenceIds: [id] },
      { kind: 'results', title: 'Results and limits', body, basis: 'author', evidenceIds: [id] },
      { kind: 'process', title: 'Detailed study process', body: 'The study process is available for a closer reading.', basis: 'source', evidenceIds: [id] }],
    terms: [{ term: 'Task-specific learning', explanation: 'An improvement tied to the trained task.', evidenceIds: [id] }],
    quotes: hasLate ? [{ quote: conclusion, translation: '末页结论：证据支持任务特异性学习，但尚不能确立广泛迁移。', evidenceIds: [id] }] : [], related: [] },
    questions: [{ question: 'What limits are stated in the final conclusion?', evidenceIds: [id] }],
    cards: [{ question: 'What does the final-page conclusion establish?', answer: body, type: 'Evidence boundary', evidenceIds: [id] }] };
}

async function createDocument() {
  await fs.mkdir(output, { recursive: true });
  const pdf = new jsPDF(); pdf.setFontSize(10);
  for (let p = 1; p <= 61; p += 1) {
    if (p > 1) pdf.addPage();
    for (let block = 1; block <= 3; block += 1) {
      const marker = `PAGE_${String(p).padStart(3, '0')}_BLOCK_${block}`;
      const text = `${marker} ${p === 61 && block === 3 ? conclusion : 'Evidence must be read with the study methods and stated conditions.'} `
        + 'Participants practiced the assigned task while investigators documented the measured outcome and uncertainty. '.repeat(4);
      pdf.text(pdf.splitTextToSize(text, 170), 20, 25 + (block - 1) * 80);
    }
  }
  const file = path.join(output, 'Full-document-61-pages.pdf');
  await fs.writeFile(file, Buffer.from(pdf.output('arraybuffer'))); return file;
}

async function startServer() {
  server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try { const bytes = await fs.readFile(file); response.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream'); response.end(bytes); }
    catch (_) { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function evidenceExpected() {
  return page.evaluate(async () => {
    const frame = document.querySelector('.guanyi-pdf-frame');
    const pdf = frame.contentWindow.PDFViewerApplication.pdfDocument;
    const sourceHash = __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerSourceHash;
    const blocks = [];
    for (let p = 1; p <= pdf.numPages; p += 1) blocks.push(...(await GuanyiPdfEvidence.extractPage(pdf, p, { sourceHash })).blocks);
    return blocks.map(block => ({ text: block.text, page: block.page }));
  });
}

function assertAllText(firstPass, expected, label) {
  const parts = firstPass.flatMap(request => request.evidence || []);
  assert.equal(parts.map(item => item.text).join(''), expected.map(item => item.text).join(''), `${label}: every native character is supplied in source order`);
  assert.ok(parts.length > 80, `${label}: covers more than the old 80-block cap`);
  const text = parts.map(item => item.text).join('\n');
  for (let p = 1; p <= 61; p += 1) for (let b = 1; b <= 3; b += 1) assert.ok(text.includes(`PAGE_${String(p).padStart(3, '0')}_BLOCK_${b}`), `${label}: page ${p} block ${b}`);
  assert.ok(text.includes(conclusion), `${label}: final-page conclusion is sent`);
  assert.doesNotMatch(JSON.stringify(firstPass), /sourceHash|rects|desktopPath|Full-document-61-pages\.pdf/);
  assert.deepEqual(firstPass.flatMap(item => item.visuals || []).map(item => item.page), Array.from({ length: 61 }, (_, index) => index + 1), `${label}: sends every original PDF page image`);
  assert.ok(firstPass.every(item => (item.visuals || []).length <= 3), `${label}: image batches stay within the supported limit`);
}

async function ready() {
  await page.waitForFunction(() => window.__MD_EDITOR_TEST__ && !window.__MD_EDITOR_BOOT_ERROR__);
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame')?.contentWindow?.PDFViewerApplication?.pdfDocument
    && document.querySelector('.guanyi-pdf-frame').contentDocument.querySelector('.textLayer span'));
}

const watchdog = setTimeout(() => { console.error(`Paper reader browser exceeded 240 seconds during ${phase}`); browser?.close(); }, 240000);
(async () => {
  const file = await createDocument(), origin = await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('md-editor-model-config-v1', JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://paper.fixture.invalid/v1', model: 'paper-fixture' }));
    sessionStorage.setItem('md-editor-model-session-key-v1', 'paper-generated-fixture-key');
    window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined;
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith('https://paper.fixture.invalid/')) {
      const wire = request.postDataJSON(), message = (wire.messages || wire.input).at(-1), payload = JSON.parse(messageText(message));
      const images = Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [];
      assert.equal(images.length, (payload.visuals || []).length, 'visual metadata corresponds to actual image content');
      for (const image of images) { const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64'); assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff'); assert.ok(bytes.length > 1000); }
      imageCounts.push(images.length);
      requests.push(payload);
      if (mode === 'wait') { delayed.push(route); return; }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelResponse(payload)) } }] }) });
    }
    if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    externalRequests.push(url); return route.abort();
  });
  await page.goto(origin); await page.waitForFunction(() => window.__MD_EDITOR_TEST__);
  await page.locator('#file-open').setInputFiles(file); await ready();
  const docId = await page.evaluate(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').id);
  const expected = await evidenceExpected();
  assert.ok(expected.length > 80); assert.equal(new Set(expected.map(item => item.page)).size, 61);
  assert.ok(expected.reduce((sum, item) => sum + item.text.length, 0) > 48000, 'fixture requires real full-text batches');
  await page.locator('.guanyi-study-toggle').click();

  stage('reading every native block across 61 pages with the real engine');
  await action('研读全文').click();
  await progress(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerStudy?.preparations.at(-1)?.status === 'ready');
  const prep = (await record()).preparations.at(-1);
  assert.equal(prep.coverage.totalImages, 61); assert.equal(prep.coverage.sentImages, 61);
  assertAllText(requests.filter(item => /^(?:read-batch|prepare-document)$/.test(item.stage)), expected, 'preparation');
  assert.ok(requests.some(item => item.stage === 'synthesize-reading'), 'long document is synthesized after complete batches');
  assert.equal(prep.start, 1); assert.equal(prep.end, 61); assert.match(JSON.stringify(prep.reading), /broad transfer remains unproven/);
  assert.ok(prep.reading.summary.sources.some(source => source.page === 61), 'late conclusion binds to local page 61');
  assert.equal((await record()).cards.length, 0, 'AI candidates are not silently saved');
  const overview = panel().locator('.guanyi-study-overview');
  assert.equal(await overview.isVisible(), true);
  assert.ok(await overview.evaluate(node => node.getBoundingClientRect().top < innerHeight - 100), 'core summary starts in the initial viewport');
  assert.equal(await panel().getByRole('heading', { name: 'Methods', exact: true }).isVisible(), true);
  assert.equal(await panel().getByRole('heading', { name: 'Results and limits', exact: true }).isVisible(), true);
  for (const label of ['研究过程与细节', '术语与概念', '原文摘引与译文']) {
    const group = panel().locator('.guanyi-study-detail-group').filter({ has: page.locator('summary', { hasText: label }) });
    assert.equal(await group.evaluate(node => node.open), false, `${label} starts collapsed`);
    await group.locator(':scope > summary').click(); assert.equal(await group.evaluate(node => node.open), true);
    await group.locator(':scope > summary').click();
  }
  await panel().locator('.guanyi-study-body').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#tip').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, '01-full-document-reading.png') });

  stage('showing an exact excerpt, locating it and returning to the reading position');
  const sources = panel().locator('details').filter({ has: page.locator('summary', { hasText: '查看原文依据' }) }).first();
  await sources.locator('summary').click();
  assert.ok((await sources.textContent()).includes(conclusion));
  const excerpt = sources.getByRole('button', { name: '定位此摘录', exact: true }).first();
  await excerpt.click();
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 61);
  await pdfFrame().locator('.guanyi-evidence-layer').waitFor();
  await page.locator('.guanyi-study-return').click();
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1);

  stage('answering over the whole document by default and preserving the final-page evidence');
  const beforeAnswer = requests.length; await tab('文档对话');
  await question().fill('What does the final-page conclusion establish?'); await action('发送').click();
  await progress(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerStudy.messages.at(-1)?.status === 'ready');
  const message = (await record()).messages.at(-1);
  assert.equal(message.context.mode, 'document'); assert.equal(message.answer, answer); assert.ok(message.sources.some(source => source.page === 61));
  assert.equal(message.coverage.totalImages, 61); assert.equal(message.coverage.sentImages, 61);
  assertAllText(requests.slice(beforeAnswer).filter(item => /^(?:answer-batch|answer-document)$/.test(item.stage)), expected, 'answer');

  stage('cancelling a pending full-document task without replacing the saved reading');
  await tab('导读'); mode = 'wait'; const beforeCancel = requests.length;
  await action('重新研读').click();
  await page.waitForFunction(count => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerStudy.preparations.at(-1)?.status === 'preparing', beforeCancel);
  while (requests.length === beforeCancel) await page.waitForTimeout(20);
  await action('停止').click();
  await progress(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.readerFormat === 'pdf').readerStudy.preparations.at(-1)?.status === 'interrupted');
  mode = 'normal'; for (const route of delayed.splice(0)) await route.abort().catch(() => {});
  assert.ok((await record()).preparations.some(item => item.status === 'ready' && item.reading.summary.body.includes('broad transfer')));
  assert.equal(await panel().locator('.guanyi-study-notice').filter({ hasText: /上次研读已中断/ }).count(), 1, 'cancellation has one retained notice');
  assert.equal((await panel().textContent()).match(/已停止|研读已中断/g)?.length, 1, 'cancellation does not duplicate stopped notices');

  stage('keeping long excerpts within narrow light and dark layouts');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await tab('导读');
    for (const details of await panel().locator('details').all()) await details.evaluate(node => { node.open = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const clipped = await panel().locator('blockquote, .guanyi-study-source-excerpt').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth + 1
      || ['hidden', 'clip'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1));
    assert.equal(clipped, false, `${theme}/${width}: exact excerpts remain readable`);
    await page.screenshot({ path: path.join(output, `reading-${theme}-${width}.png`) });
  }

  stage('exporting and restoring the complete saved reading and citations');
  await page.setViewportSize({ width: 1440, height: 960 }); await action('整理为 Markdown').click();
  await page.locator('.guanyi-study-dialog').getByRole('button', { name: '创建 Markdown 笔记', exact: true }).click();
  await page.waitForFunction(() => __MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === __MD_EDITOR_TEST__.getState().currentDocId)?.readerFormat !== 'pdf');
  assert.match(await page.evaluate(() => __MD_EDITOR_TEST__.getCurrentMarkdown()), /LATE_PAGE_CONCLUSION|broad transfer/);
  assert.match(await page.evaluate(() => __MD_EDITOR_TEST__.getCurrentMarkdown()), /文件第 61 页/);
  await page.evaluate(id => __MD_EDITOR_TEST__.switchDoc(id), docId); await ready();
  await page.reload(); await page.waitForFunction(() => window.__MD_EDITOR_TEST__);
  await page.locator(`.app-document-tab[data-doc-id="${docId}"] .app-document-tab__activate`).click(); await ready();
  assert.ok((await record()).preparations.some(item => item.status === 'ready' && item.reading.summary.sources.some(source => source.page === 61)));
  assert.equal((await record()).messages.at(-1).answer, answer);
  assert.doesNotMatch(JSON.stringify(await record()), /data:image|;base64,/);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, realPdfPages: 61, nativeBlocks: expected.length,
    nativeCharacters: expected.reduce((sum, item) => sum + item.text.length, 0), completePreparation: true, completeDefaultDocumentAnswer: true,
    latePageConclusion: true, exactExcerptAndReturn: true, cancellation: true, layouts: ['light/1440', 'light/390', 'dark/1440', 'dark/390'],
    export: true, reload: true, completePageImages: 61, imageCounts, stages: requests.map(item => item.stage), errors, externalRequests }, null, 2));
  await fs.rm(path.join(output, 'failure.png'), { force: true }); await fs.rm(path.join(output, 'failure.txt'), { force: true });
  console.log('PASS real PDF.js full-text batches, late-page reading/answer, exact excerpt location/return, cancellation, themes, export and reload');
})().catch(async error => {
  console.error(`Paper reader browser failed during ${phase}:`, error);
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'failure.txt'), error.stack || String(error));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
    await fs.writeFile(path.join(output, 'state.json'), JSON.stringify(await record().catch(() => null), null, 2));
  }
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
