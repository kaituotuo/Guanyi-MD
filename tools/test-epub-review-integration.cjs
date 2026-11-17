'use strict';
// EPUB review acceptance uses generated publications and an isolated browser.
// Model replies are controlled fixtures; no cloud keys or personal files are read.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const JSZip = require('jszip');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'epub-review-integration');
fs.mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) res.writeHead(404).end();
    else { res.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream'); res.end(bytes); }
  });
});
const chapterOneQuote = '阅读需要核对证据与条件，不能脱离原文推论。';
const chapterTwoQuote = '第二章秘密词：远山之约。结论必须保留来源。';
const secondBookQuote = '第二本独有依据：琥珀灯塔标记需要独立核验。';
async function publication(title = 'EPUB 审阅验收', identifier = 'guanyi-review-epub-1', secondChapterQuote = chapterTwoQuote) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${identifier}</dc:identifier><dc:title>${title}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-14T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章 阅读</a></li><li><a href="chapter2.xhtml">第二章 思考</a></li></ol></nav></body></html>');
  zip.file('OPS/chapter1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 阅读</title><style>p{line-height:1.8}</style><script>parent.__epubScriptRan=true;</script></head><body onload="parent.__epubEventRan=true"><h1>第一章 阅读</h1><p id="epub-quote-one">${chapterOneQuote}</p><p id="outside-selection">这是当前章节中尚未选中的独特上下文：青石小径。</p><a id="epub-second-link" href="chapter2.xhtml">继续第二章</a>${'<p>把值得回味的段落留下，在书页之间记录自己的思考。</p>'.repeat(10)}</body></html>`);
  zip.file('OPS/chapter2.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章 思考</title></head><body><h1>第二章 思考</h1><p id="epub-quote-two">${secondChapterQuote}</p></body></html>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
let browser, page, phase = 'startup';
let origin, mode = 'normal';
const errors = [], requests = [], externalRequests = [];
const watchdog = setTimeout(() => { console.error(`EPUB review acceptance timed out during ${phase}`); browser?.close(); }, 240000);
function stage(name) { phase = name; console.log(`[EPUB review] ${name}`); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function parseJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function reply(payload) {
  const system = payload.messages?.[0]?.content || '';
  const user = payload.messages?.at(-1)?.content || '';
  const input = parseJson(user) || {};
  if (/summary/.test(system) && /risks/.test(system)) {
    const supplied = (input.evidence || []).find(item => (item.text || '').includes('阅读需要')) || (input.evidence || []).find(item => (item.text || '').includes('远山之约'));
    const quote = supplied?.text || (user.includes(chapterTwoQuote) && !user.includes(chapterOneQuote) ? chapterTwoQuote : chapterOneQuote);
    return { summary: [{ title: '证据边界', text: '本节说明结论应受原文条件约束。' }], details: [{ title: '可核验原文', text: '需保留阅读依据。', quote: mode === 'invalid' ? '这是书中并不存在的模型引文。' : quote }], risks: [] };
  }
  if (/queries/.test(system) && (/route/.test(system) || /路由/.test(system))) return { route: 'direct', queries: ['证据 条件 阅读'], must: [], entities: [] };
  if (/evidenceIds/.test(system)) return { answer: '阅读需要核对证据与条件。', evidenceIds: [mode === 'invalid' ? 'E999' : (input.evidence?.[0]?.id || 'E1')], insufficient: false };
  if (/evidence/.test(system)) {
    const evidence = input.evidence || input.candidates || [];
    return { answer: '阅读需要核对证据与条件，保留原文来源。', evidence: [{ id: mode === 'invalid' ? 'W999' : (evidence[0]?.id || 'W1'), explanation: '这是提供的章节原文。' }], supported: true, confidence: 'high' };
  }
  return '可以依据原文组织阅读笔记。';
}
async function hit(locator, label) {
  const result = await locator.evaluate(el => {
    const r = el.getBoundingClientRect(), target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, hit: !!target && (target === el || el.contains(target)), target: target?.id || target?.className };
  });
  assert.ok(result.inside, `${label} inside viewport`);
  assert.ok(result.hit, `${label} blocked by ${result.target}`);
}
async function importFiles(files) {
  await page.evaluate(async files => __MD_EDITOR_TEST__.importLocalFiles(files.map(file => new File([new Uint8Array(file.bytes)], file.name, { lastModified: 1700000000000 }))), files);
}
async function switchTo(id) {
  await page.evaluate(id => __MD_EDITOR_TEST__.switchDoc(id), id);
}
async function epubReady(target = 'epub-quote-one') {
  await page.waitForFunction(target => !!document.querySelector('.epub-reader iframe')?.contentDocument?.getElementById(target), target);
}
async function selectEpubText(id = 'epub-quote-one', length) {
  await page.evaluate(({ id, length }) => {
    const d = document.querySelector('.epub-reader iframe').contentDocument;
    const node = d.getElementById(id).firstChild, range = d.createRange();
    range.setStart(node, 0); range.setEnd(node, length || node.length);
    const selection = d.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    d.dispatchEvent(new Event('selectionchange'));
  }, { id, length });
  await page.waitForFunction(() => !document.querySelector('[data-epub-action="highlight"]')?.disabled);
}
async function waitReview(open) {
  await page.waitForFunction(open => {
    const drawer = document.getElementById('collab-drawer');
    const rect = drawer.getBoundingClientRect();
    return drawer.getAttribute('aria-hidden') === String(!open) && (open ? rect.right <= innerWidth + 1 : rect.left >= innerWidth - 1);
  }, open);
}
async function reviewToggle() {
  return page.locator('[data-epub-action="review"]');
}
async function globalModelEntry() {
  assert.equal(await page.locator('#app-menu [data-app-command="model-settings"]').count(), 1);
  assert.equal(await page.locator('#btn-model-settings,#btn-model-config,[data-home-action="configure-model"]').count(), 0);
  await page.locator('#btn-app-menu').click();
  for (const command of ['settings', 'model-settings', 'update', 'help', 'about']) await hit(page.locator(`#app-menu [data-app-command="${command}"]`), `EPUB menu ${command}`);
  await page.locator('#app-menu [data-app-command="model-settings"]').click();
  assert.equal(await page.locator('#model-modal').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#model-modal').isVisible(), false);
  assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'), 'false', 'Escape closes model dialog before review');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('md-editor-model-config-v1', JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://model.fixture.invalid/v1', model: 'fixture-model' }));
    sessionStorage.setItem('md-editor-model-session-key-v1', 'fixture-key');
    window.showSaveFilePicker = undefined;
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith('https://model.fixture.invalid/')) {
      const payload = request.postDataJSON(); requests.push(payload);
      if (mode === 'wait') { await new Promise(resolve => setTimeout(resolve, 1200)); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(payload)) } }] }) }).catch(() => {});
    }
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    externalRequests.push(url); return route.abort();
  });
  stage('importing controlled EPUB, MD and PDF fixtures');
  await page.goto(origin); await page.waitForFunction(() => window.__MD_EDITOR_TEST__);
  const bytes = await publication();
  const secondBytes = await publication('另一本独立书籍', 'guanyi-review-epub-2', secondBookQuote);
  const sourceHash = sha(bytes);
  const secondSourceHash = sha(secondBytes);
  const pdf = new jsPDF(); pdf.text('PDF evidence remains independent from EPUB review.', 20, 30);
  await importFiles([
    { name: 'EPUB审阅验收.epub', bytes: [...bytes] },
    { name: '第二本.epub', bytes: [...secondBytes] },
    { name: '隔离阅读笔记.md', bytes: [...Buffer.from('# Markdown 独立批注\n\nMD 文档应保留完整编辑工具栏。')] },
    { name: '独立PDF.pdf', bytes: [...Buffer.from(pdf.output('arraybuffer'))] }
  ]);
  const ids = await page.evaluate(() => Object.fromEntries(__MD_EDITOR_TEST__.getState().docs.filter(d => ['EPUB审阅验收.epub', '第二本.epub', '隔离阅读笔记.md', '独立PDF.pdf'].includes(d.localFileName)).map(d => [d.localFileName, d.id])));
  assert.equal(Object.keys(ids).length, 4);
  await switchTo(ids['EPUB审阅验收.epub']); await epubReady();
  assert.equal(await page.evaluate(() => !!window.__epubScriptRan || !!window.__epubEventRan), false);
  assert.equal(await page.locator('.epub-reader iframe').evaluate(frame => frame.sandbox.contains('allow-scripts')), false);
  const toggle = await reviewToggle();
  await toggle.waitFor();
  assert.equal(await toggle.innerText(), '', 'EPUB review entry uses an icon');
  assert.equal(await toggle.getAttribute('aria-controls'), 'collab-drawer');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.match(await toggle.getAttribute('title'), /智能审阅/);
  await toggle.click(); await waitReview(true);
  assert.deepEqual(await page.locator('[data-collab-panel]').evaluateAll(items => items.map(item => item.dataset.collabPanel).sort()), ['comments', 'reading', 'works']);
  assert.equal(await page.locator('.app-drawer__header').evaluate(el => el.getBoundingClientRect().height), 54);
  assert.equal(await page.locator('.app-sidebar').isVisible(), false);
  assert.equal(requests.length, 0, 'opening review must not send model requests');
  console.log('PASS EPUB review opens the shared three-tab panel without modifying the original or auto-sending');

  stage('retaining native EPUB annotations inside the shared comments page');
  await selectEpubText();
  await page.locator('[data-epub-action="note"]').click();
  const note = page.locator('#epub-review-comments .epub-reader__note textarea').first();
  await note.waitFor();
  await note.fill('EPUB 的独立中文批注 <img src=x onerror=alert(1)>');
  const color = page.locator('#epub-review-comments select[aria-label="高亮颜色"]').first();
  await color.selectOption('green');
  assert.equal(await page.locator('#epub-review-comments img').count(), 0, 'notes render user content as text');
  await page.waitForFunction(id => JSON.parse(__MD_EDITOR_TEST__.getState().docs.find(d => d.id === id).content).annotations?.[0]?.note.includes('独立中文批注'), ids['EPUB审阅验收.epub']);
  const savedAnnotation = await page.evaluate(id => JSON.parse(__MD_EDITOR_TEST__.getState().docs.find(d => d.id === id).content).annotations[0], ids['EPUB审阅验收.epub']);
  assert.match(savedAnnotation.cfi, /^epubcfi\(/);
  assert.equal(savedAnnotation.color, 'green');
  assert.equal(savedAnnotation.quote, chapterOneQuote);
  assert.equal(await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id]?.comments?.length || 0, ids['EPUB审阅验收.epub']), 0, 'EPUB annotations do not create Markdown line comments');
  const downloaded = page.waitForEvent('download');
  await page.locator('.app-reader-save').click();
  const download = await downloaded;
  const downloadPath = await download.path();
  const exported = fs.readFileSync(downloadPath, 'utf8');
  assert.match(exported, /EPUB 的独立中文批注/); assert.ok(exported.includes(chapterOneQuote)); assert.match(exported, /epubcfi\(/);
  assert.ok(!/\.epub\.REVIEW\.md$/.test(download.suggestedFilename()), 'EPUB retains native notes export');
  await page.screenshot({ path: path.join(output, '02-epub-native-annotations.png') });
  console.log('PASS native EPUB annotation note/color/CFI and Markdown export remain intact in shared review');

  stage('checking EPUB review close, menu, keyboard and themes');
  const draft = '保留这条 EPUB 尚未发送的问题。';
  await page.locator('[data-collab-panel="works"]').click();
  await page.locator('#reading-question').fill(draft);
  for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await globalModelEntry();
    assert.equal(await page.locator('.app-drawer__header').evaluate(el => el.getBoundingClientRect().height), 54);
    await page.locator('#btn-close-drawer').click(); await waitReview(false);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true, 'X returns focus to EPUB review entry');
    await toggle.click(); await waitReview(true); await page.locator('[data-collab-panel="works"]').click();
    assert.equal(await page.locator('#reading-question').inputValue(), draft);
    await page.locator('#reading-question').focus(); await page.keyboard.press('Escape'); await waitReview(false);
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true, 'Escape returns focus to EPUB review entry');
    await toggle.click(); await waitReview(true); await page.locator('[data-collab-panel="works"]').click();
    if (width < 1180) {
      await page.locator('#drawer-mask').waitFor({ state: 'visible' });
      await page.locator('#drawer-mask').click({ position: { x: 4, y: 8 } }); await waitReview(false);
      assert.equal(await toggle.evaluate(el => el === document.activeElement), true, 'backdrop returns focus to EPUB review entry');
      await toggle.click(); await waitReview(true); await page.locator('[data-collab-panel="works"]').click();
    }
    assert.equal(await page.locator('#reading-question').inputValue(), draft);
    await page.screenshot({ path: path.join(output, `03-epub-review-${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 960 }); await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  console.log('PASS EPUB review shares 54px header, X/Escape/backdrop focus, unsent draft and global model menu across light/dark widths');

  stage('isolating EPUB annotations from Markdown, another EPUB and PDF');
  await switchTo(ids['第二本.epub']); await epubReady();
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') await (await reviewToggle()).click(); await waitReview(true);
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note').count(), 0, 'another publication has no first-book annotations');
  await switchTo(ids['隔离阅读笔记.md']);
  assert.equal(await page.locator('#fmtbar').isVisible(), true); assert.equal(await page.locator('#fmtbar [data-fmt="bold"]').isEnabled(), true);
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') await page.locator('#btn-comments').click(); await waitReview(true);
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments').isVisible(), false);
  assert.equal(await page.locator('#comment-list').isVisible(), true);
  assert.equal(await page.locator('#comment-list .app-comment-card').count(), 0, 'MD does not display EPUB annotation cards');
  for (const view of ['source', 'preview', 'split']) { await page.locator(`#view-seg [data-view="${view}"]`).click(); assert.equal(await page.locator('#editor-container').getAttribute('data-view'), view); }
  await switchTo(ids['独立PDF.pdf']); await page.waitForSelector('.guanyi-study-toggle');
  assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'), 'true', 'PDF uses its independent study panel');
  assert.equal(await page.locator('[data-epub-action="review"]').count(), 0);
  await page.locator('.guanyi-study-toggle').click(); assert.equal(await page.locator('.guanyi-study-panel').isVisible(), true);
  await page.locator('.guanyi-study-close').click();
  await switchTo(ids['EPUB审阅验收.epub']); await epubReady(); if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') await (await reviewToggle()).click(); await waitReview(true);
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note textarea').inputValue(), 'EPUB 的独立中文批注 <img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').inputValue(), 'green');
  console.log('PASS MD/PDF and a second EPUB keep independent annotations, controls and review state');

  stage('checking current-chapter and selected-text AI reading evidence');
  // A chapter change clears the old selection through the native reader.
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter1.xhtml'); await epubReady();
  await page.locator('[data-collab-panel="reading"]').click();
  const summaryStart = requests.length;
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(id => !!__MD_EDITOR_TEST__.getReviewState().documents[id]?.ai?.result?.details?.length, ids['EPUB审阅验收.epub']);
  const chapterRequests = requests.slice(summaryStart);
  assert.ok(chapterRequests.length >= 1);
  const summaryRequest = chapterRequests.find(payload => /summary/.test(payload.messages[0].content) && /risks/.test(payload.messages[0].content));
  assert.ok(summaryRequest, 'summary uses the existing structured reading response');
  assert.ok(JSON.stringify(summaryRequest).normalize('NFKC').includes(chapterOneQuote.normalize('NFKC')));
  assert.ok(!JSON.stringify(summaryRequest).includes(chapterTwoQuote), 'current chapter summary does not send another chapter');
  assert.ok(!JSON.stringify(summaryRequest).includes('独立中文批注'), 'user notes are not silently mixed into chapter evidence');
  assert.doesNotMatch(JSON.stringify(summaryRequest), /epubcfi\(|OPS\/|chapter1\.xhtml|readerSourceHash|sectionIndex|locatorCfi|[a-f0-9]{64}/i, 'model sees opaque evidence and text, not local positions or source identities');
  const chapterAi = await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id].ai, ids['EPUB审阅验收.epub']);
  assert.ok(chapterAi.result.details[0].evidence, 'validated quote retains local evidence');
  assert.equal(chapterAi.result.details[0].quote.normalize('NFKC'), chapterOneQuote.normalize('NFKC'));
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('#summary-results button').filter({ hasText: '定位原文' }).first().click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="EPUB 章节目录"]').value === 'chapter1.xhtml');
  await epubReady();
  assert.equal(await page.locator('select[aria-label="EPUB 章节目录"]').inputValue(), 'chapter1.xhtml', 'AI quote locates the captured chapter');
  await selectEpubText();
  const selectionStart = requests.length;
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(id => /选/.test(__MD_EDITOR_TEST__.getReviewState().documents[id]?.ai?.scopeLabel || ''), ids['EPUB审阅验收.epub']);
  const selectedRequest = requests.slice(selectionStart).find(payload => /summary/.test(payload.messages[0].content));
  assert.ok(selectedRequest);
  assert.ok(JSON.stringify(selectedRequest).normalize('NFKC').includes(chapterOneQuote.normalize('NFKC')));
  assert.ok(!JSON.stringify(selectedRequest).includes('青石小径'), 'selection analysis excludes unselected chapter context');
  assert.ok(!JSON.stringify(selectedRequest).includes(chapterTwoQuote));
  mode = 'invalid';
  const priorGenerated = await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id].ai.generatedAt, ids['EPUB审阅验收.epub']);
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(({ id, prior }) => __MD_EDITOR_TEST__.getReviewState().documents[id]?.ai?.generatedAt !== prior, { id: ids['EPUB审阅验收.epub'], prior: priorGenerated });
  const invalidAi = await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id].ai, ids['EPUB审阅验收.epub']);
  assert.ok(!JSON.stringify(invalidAi.result).includes('这是书中并不存在的模型引文。'), 'a fabricated quote is not persisted as EPUB evidence');
  mode = 'normal';
  await page.screenshot({ path: path.join(output, '04-epub-ai-reading.png') });
  console.log('PASS AI reading sends only the captured chapter or selection, rejects invented quotes and keeps local source navigation');

  stage('answering from EPUB source evidence and rejecting invented references');
  await page.locator('[data-collab-panel="works"]').click();
  await page.locator('#reading-scope').selectOption('current');
  const workStart = requests.length;
  await page.locator('#reading-question').fill('证据与条件为什么需要核对？'); await page.locator('#btn-ask-work').click();
  await page.waitForFunction(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'complete');
  const work = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1));
  assert.ok(work.evidence.length > 0, 'EPUB question yields local evidence');
  assert.ok(work.evidence.every(item => item.docId === ids['EPUB审阅验收.epub']));
  assert.ok(work.evidence.some(item => item.readerFormat === 'epub' && item.sourceHash === sourceHash && Number.isInteger(item.sectionIndex)));
  assert.ok(requests.slice(workStart).some(payload => /证据/.test(JSON.stringify(payload))));
  for (const payload of requests.slice(workStart)) assert.doesNotMatch(JSON.stringify(payload), /epubcfi\(|OPS\/|chapter[12]\.xhtml|locatorCfi|readerSourceHash|[a-f0-9]{64}/i, 'work model request keeps local identifiers private');
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('.app-reading-evidence-card__actions button').filter({ hasText: '定位原文' }).first().click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="EPUB 章节目录"]').value === 'chapter1.xhtml');
  await epubReady();
  mode = 'invalid';
  const historyCount = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.length);
  await page.locator('#reading-question').fill('证据与条件是什么？'); await page.locator('#btn-ask-work').click();
  await page.waitForFunction(count => __MD_EDITOR_TEST__.getState().workHistory.length > count && __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'complete', historyCount);
  const rejected = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1));
  assert.equal(rejected.generatedByModel, false, 'an unknown evidence ID does not authorize a model answer');
  assert.ok(rejected.evidence.every(item => item.id !== 'W999'));
  mode = 'normal';
  await page.locator('#reading-scope').selectOption('list');
  const listHistoryCount = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.length);
  await page.locator('#reading-question').fill('Markdown 文档应保留完整编辑工具栏'); await page.locator('#btn-ask-work').click();
  await page.waitForFunction(count => __MD_EDITOR_TEST__.getState().workHistory.length > count && __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'complete', listHistoryCount);
  const listAnswer = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1));
  assert.ok(listAnswer.evidence.some(item => item.docId === ids['隔离阅读笔记.md']), 'list scope can use Markdown alongside EPUB');
  assert.ok(!listAnswer.evidence.some(item => item.docId === ids['独立PDF.pdf']), 'PDF retains its independent study flow');
  await page.screenshot({ path: path.join(output, '05-epub-work-answer.png') });
  console.log('PASS EPUB current/list questions use verified evidence; unsupported model IDs fall back to source-only results');

  stage('locating a current-list answer in another publication on the first click');
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().currentDocId), ids['EPUB审阅验收.epub']);
  assert.equal(await page.evaluate(id => window.GuanyiReaderHost.getReviewReader(id), ids['第二本.epub']), null, 'target publication has no already-ready active reader');
  const crossBookHistoryCount = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.length);
  const crossBookStart = requests.length;
  await page.locator('#reading-question').fill('琥珀灯塔标记需要独立核验'); await page.locator('#btn-ask-work').click();
  await page.waitForFunction(count => __MD_EDITOR_TEST__.getState().workHistory.length > count && __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'complete', crossBookHistoryCount);
  const crossBookAnswer = await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1));
  assert.equal(crossBookAnswer.generatedByModel, true);
  assert.equal(crossBookAnswer.evidence.length, 1, 'model only selects the supplied opaque evidence number');
  const crossBookEvidence = crossBookAnswer.evidence[0];
  assert.equal(crossBookEvidence.docId, ids['第二本.epub']);
  assert.equal(crossBookEvidence.sourceHash, secondSourceHash);
  assert.equal(crossBookEvidence.sectionIndex, 1, 'unique target quote belongs to the second chapter of the other publication');
  assert.equal(crossBookEvidence.quote.normalize('NFKC'), secondBookQuote.normalize('NFKC'));
  assert.ok(requests.slice(crossBookStart).some(payload => JSON.stringify(payload).includes('琥珀灯塔标记')));
  for (const payload of requests.slice(crossBookStart)) assert.doesNotMatch(JSON.stringify(payload), /epubcfi\(|OPS\/|chapter[12]\.xhtml|sectionIndex|sourceHash|[a-f0-9]{64}/i, 'cross-publication navigation positions remain local');
  await page.evaluate(() => {
    window.__crossBookNotices = [];
    window.__crossBookNoticeObserver = new MutationObserver(() => {
      const text = document.getElementById('tip').textContent.trim();
      if (text) window.__crossBookNotices.push(text);
    });
    window.__crossBookNoticeObserver.observe(document.getElementById('tip'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('.app-reading-evidence-card').filter({ hasText: '琥珀灯塔标记需要独立核验' }).getByRole('button', { name: '定位原文', exact: true }).click();
  await page.waitForFunction(id => __MD_EDITOR_TEST__.getState().currentDocId === id && document.querySelector('select[aria-label="EPUB 章节目录"]')?.value === 'chapter2.xhtml', ids['第二本.epub']);
  await epubReady('epub-quote-two');
  assert.equal(await page.locator('.epub-reader iframe').evaluate(frame => frame.contentDocument.getElementById('epub-quote-two').textContent), secondBookQuote, 'first click waits for the new reader and displays the actual cited target chapter');
  const crossBookNotices = await page.evaluate(() => { window.__crossBookNoticeObserver.disconnect(); return window.__crossBookNotices; });
  assert.ok(!crossBookNotices.some(text => /来源.*变化|原文.*变化|无法定位|位置无效/.test(text)), `a normal book switch must not report changed source: ${crossBookNotices.join(' | ')}`);
  await page.screenshot({ path: path.join(output, '06-cross-book-source-location.png') });
  await switchTo(ids['EPUB审阅验收.epub']); await epubReady();
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') { await (await reviewToggle()).click(); await waitReview(true); }
  console.log('PASS a current-list citation opens the other EPUB and locates its real second-chapter source on the first click');

  stage('cancelling obsolete EPUB work and restoring saved state');
  // Obsolete requests must not write into another publication after navigation.
  await page.locator('[data-collab-panel="reading"]').click();
  mode = 'wait';
  const pendingStart = requests.length;
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(() => document.querySelector('#btn-generate-summary').disabled);
  const pendingDeadline = Date.now() + 10000;
  while (requests.length === pendingStart && Date.now() < pendingDeadline) await page.waitForTimeout(20);
  assert.ok(requests.length > pendingStart, 'controlled model received the request before document switch');
  await switchTo(ids['第二本.epub']); await epubReady('epub-quote-two');
  await page.waitForTimeout(1400);
  mode = 'normal';
  const secondBookAi = await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id]?.ai || null, ids['第二本.epub']);
  assert.equal(secondBookAi?.result || null, null, 'a late first-book response does not appear in another EPUB');
  await switchTo(ids['EPUB审阅验收.epub']); await epubReady();
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') { await (await reviewToggle()).click(); await waitReview(true); }
  await page.locator('[data-collab-panel="works"]').click();
  await page.locator('#reading-scope').selectOption('current');
  mode = 'wait';
  const cancelQuestion = '证据与条件为什么需要核对？';
  const cancelStart = requests.length;
  await page.locator('#reading-question').fill(cancelQuestion); await page.locator('#btn-ask-work').click();
  const cancelDeadline = Date.now() + 10000;
  while (requests.length === cancelStart && Date.now() < cancelDeadline) await page.waitForTimeout(20);
  assert.ok(requests.length > cancelStart, 'controlled model received work request before closing');
  await page.locator('#btn-close-drawer').click(); await waitReview(false);
  await page.waitForFunction(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'cancelled');
  assert.equal(await (await reviewToggle()).evaluate(el => el === document.activeElement), true);
  await page.waitForTimeout(1400); mode = 'normal';
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1).status), 'cancelled', 'late model response must not overwrite cancelled work');
  await (await reviewToggle()).click(); await waitReview(true); await page.locator('[data-collab-panel="works"]').click();
  assert.equal(await page.locator('#reading-question').inputValue(), cancelQuestion, 'closing pending work retains its question');
  mode = 'wait';
  const editedCancelStart = requests.length;
  await page.locator('#reading-question').fill(cancelQuestion); await page.locator('#btn-ask-work').click();
  const editedCancelDeadline = Date.now() + 10000;
  while (requests.length === editedCancelStart && Date.now() < editedCancelDeadline) await page.waitForTimeout(20);
  assert.ok(requests.length > editedCancelStart, 'model received the work request before the user types another draft');
  const nextDraft = '这是生成过程中继续输入的下一条问题，关闭并重载后必须保留。';
  await page.locator('#reading-question').fill(nextDraft);
  assert.equal(await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id].questionDraft, ids['EPUB审阅验收.epub']), nextDraft, 'new draft is persisted while the previous work request is pending');
  await page.locator('#btn-close-drawer').click(); await waitReview(false);
  await page.waitForFunction(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'cancelled');
  await page.waitForTimeout(1400); mode = 'normal';
  assert.equal(await page.evaluate(() => __MD_EDITOR_TEST__.getState().workHistory.at(-1).status), 'cancelled', 'late work cannot overwrite the cancelled state after editing the next draft');
  assert.equal(await page.evaluate(id => __MD_EDITOR_TEST__.getReviewState().documents[id].questionDraft, ids['EPUB审阅验收.epub']), nextDraft, 'X cancellation cannot overwrite the next draft with the old submitted question');
  await (await reviewToggle()).click(); await waitReview(true); await page.locator('[data-collab-panel="works"]').click();
  assert.equal(await page.locator('#reading-question').inputValue(), nextDraft, 'closing and reopening preserves the newly typed question');
  const beforeReload = await page.evaluate(id => ({ doc: __MD_EDITOR_TEST__.getState().docs.find(d => d.id === id), review: __MD_EDITOR_TEST__.getReviewState().documents[id] }), ids['EPUB审阅验收.epub']);
  assert.equal(beforeReload.doc.readerSourceHash, sourceHash);
  assert.equal(beforeReload.review.questionDraft, nextDraft);
  await page.reload(); await page.waitForFunction(() => window.__MD_EDITOR_TEST__);
  await switchTo(ids['EPUB审阅验收.epub']); await epubReady();
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') { await (await reviewToggle()).click(); await waitReview(true); }
  await page.locator('[data-collab-panel="works"]').click();
  assert.equal(await page.locator('#reading-question').inputValue(), nextDraft, 'reload retains the question typed during the cancelled request');
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note textarea').inputValue(), 'EPUB 的独立中文批注 <img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').inputValue(), 'green');
  const cachedHash = await page.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('guanyi-reader-originals-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const bytes = await new Promise((resolve, reject) => { const r = db.transaction('originals').objectStore('originals').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const digest = await crypto.subtle.digest('SHA-256', bytes); db.close(); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }, ids['EPUB审阅验收.epub']);
  assert.equal(cachedHash, sourceHash, 'original EPUB archive bytes remain unchanged after reviews and restart');
  const afterReload = await page.evaluate(id => ({ doc: __MD_EDITOR_TEST__.getState().docs.find(d => d.id === id), review: __MD_EDITOR_TEST__.getReviewState().documents[id] }), ids['EPUB审阅验收.epub']);
  assert.equal(afterReload.doc.readerSourceHash, beforeReload.doc.readerSourceHash);
  assert.ok(afterReload.review?.ai?.result, 'EPUB AI result persists across reload');
  assert.ok(afterReload.review.ai.result.details.every(item => !item.quote || item.evidence?.sourceHash === sourceHash));
  await page.locator('#epub-review-comments button[aria-label="移除此标注"]').click();
  await page.waitForFunction(id => JSON.parse(__MD_EDITOR_TEST__.getState().docs.find(d => d.id === id).content).annotations.length === 0, ids['EPUB审阅验收.epub']);
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note').count(), 0);
  const report = { sourceHash, sourceArchiveUnchanged: cachedHash === sourceHash, sharedThreeTabReview: true, nativeAnnotations: true, exportNotes: true, modelPrivacy: true, chapterAndSelection: true, sourcedWorkAnswers: true, invalidModelEvidenceBlocked: true, crossFormatIsolation: true, themesAndResponsiveClose: true, crossBookFirstClickSourceLocated: true, crossBookFalseSourceChangedBlocked: true, reload: true, cancelledOnNavigation: true, closedWorkQuestionRetained: true, nextDraftRetainedAfterCancelAndReload: true, errors, externalRequests, modelRequests: requests.length };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS obsolete request isolation, reload persistence, original bytes and native annotation removal');

  fs.writeFileSync(path.join(output, 'initial-contract.json'), JSON.stringify({ sourceHash, ids, requests: requests.length }, null, 2));
  await page.screenshot({ path: path.join(output, '01-epub-review.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'EPUB must not load external resources');
  console.log('EPUB review acceptance passed.');
})().catch(async error => {
  console.error(`EPUB review acceptance failed during ${phase}:`, error);
  fs.writeFileSync(path.join(output, 'failure-requests.json'), JSON.stringify(requests, null, 2));
  if (page) { await page.evaluate(() => ({ review: __MD_EDITOR_TEST__?.getReviewState(), state: __MD_EDITOR_TEST__?.getState() })).then(value => fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(value, null, 2))).catch(() => {}); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error)); }
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await browser?.close(); server.close(); });
